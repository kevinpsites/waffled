package app.waffled.core.auth

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledJson
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.Serializable

/**
 * The one implementation of [TokenProvider] the whole app shares.
 *
 * `core:network` speaks in access-token Strings; `core:auth` speaks in [TokenPair]s.
 * This adapter bridges them, and — importantly — passes the token that actually failed
 * into [TokenRefresher], so a staggered 401 doesn't burn a second rotation.
 *
 * Feature ViewModels should take this (or the ready-made `HttpClient`) rather than
 * assembling their own auth.
 */
class WaffledAuth(
    private val store: TokenStore,
    private val refresher: TokenRefresher,
) : TokenProvider {

    override suspend fun accessToken(): String? = store.load()?.accessToken

    override suspend fun refreshAccessToken(failedToken: String?): String? =
        refresher.refresh(failedAccessToken = failedToken)?.accessToken

    override fun sessionEnded() {
        store.clear()
        refresher.onAuthExpired?.invoke()
    }

    fun isSignedIn(): Boolean = store.load() != null

    fun signOut() = store.clear()

    /**
     * Clear the session and hand back the refresh token so the caller can revoke it
     * server-side afterwards.
     *
     * Sign-out is optimistic on purpose: clear locally and flip the UI immediately, then
     * revoke in the background. A failed revoke must never trap someone in a session
     * they have already left.
     */
    fun signOutAndReturnRefreshToken(): String? {
        val refresh = store.load()?.refreshToken
        store.clear()
        return refresh
    }

    /** Adopt a freshly-issued pair (login, kiosk claim, household switch). */
    fun adopt(tokens: TokenPair) = store.save(tokens)

    var onAuthExpired: (() -> Unit)?
        get() = refresher.onAuthExpired
        set(value) { refresher.onAuthExpired = value }
}

@Serializable
private data class RefreshRequest(val refreshToken: String)

@Serializable
private data class RefreshResponse(
    val accessToken: String? = null,
    val refreshToken: String? = null,
    // The API has used both shapes over time; accept either rather than guessing.
    val token: String? = null,
)

/**
 * `POST /api/auth/refresh`, the real backend behind [TokenRefresher].
 *
 * Deliberately uses a bare [HttpClient] with no auth plugin: refreshing must not itself
 * try to refresh.
 */
class KtorRefreshBackend(
    private val client: HttpClient,
) : RefreshBackend {

    override suspend fun refresh(refreshToken: String): TokenPair? {
        val response = runCatching {
            client.post("api/auth/refresh") {
                contentType(ContentType.Application.Json)
                setBody(RefreshRequest(refreshToken))
            }
        }.getOrNull() ?: return null

        // A rejected refresh token is a dead session. A transport failure is NOT — but we
        // cannot tell the caller "try later" through this interface, so both return null
        // and the user re-authenticates. Erring toward a sign-in beats a silent zombie.
        if (!response.status.isSuccess()) return null

        val parsed = runCatching {
            WaffledJson.decodeFromString(RefreshResponse.serializer(), response.bodyAsText())
        }.getOrNull() ?: return null

        val access = parsed.accessToken ?: parsed.token ?: return null
        // A rotating refresh token: keep the new one, or the old if the server reused it.
        val rotated = parsed.refreshToken ?: refreshToken
        return TokenPair(access, rotated)
    }
}
