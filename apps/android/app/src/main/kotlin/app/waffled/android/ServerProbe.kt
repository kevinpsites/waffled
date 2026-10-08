package app.waffled.android

import app.waffled.core.network.ServerAddressProvider
import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A minimal end-to-end check that the app can actually reach the configured server.
 *
 * This exists because "it compiles" says nothing about the thing most likely to waste a
 * whole parallel wave: on an emulator, `localhost` is the emulator itself, and the host
 * Caddy lives at `10.0.2.2`. Proving the request path once, centrally, is the Phase 0
 * exit criterion.
 *
 * `/api/health` requires auth, so a **401 still proves reachability** — we got as far as
 * the API and it answered. Only a transport failure means we couldn't get there.
 */
class ServerProbe(
    private val server: ServerAddressProvider,
    private val tokens: TokenProvider,
) {

    sealed interface Result {
        data class Reached(val status: Int, val note: String) : Result
        data class Unreachable(val error: String) : Result
    }

    suspend fun check(): Result = withContext(Dispatchers.IO) {
        val client = WaffledHttp.client(tokens, server)
        try {
            val response = client.get("api/health")
            val status = response.status.value
            val note = when {
                status == 401 -> "reachable (auth required, as expected when signed out)"
                status in 200..299 -> "reachable and authorised"
                else -> runCatching { response.bodyAsText().take(120) }.getOrDefault("")
            }
            Result.Reached(status, note)
        } catch (t: Throwable) {
            // Transport-level: wrong host, no route, cleartext blocked, DNS, timeout.
            Result.Unreachable("${t::class.simpleName}: ${t.message ?: "no detail"}")
        } finally {
            client.close()
        }
    }
}

/** Signed-out token provider — Phase 0 has no login yet. */
object AnonymousTokens : TokenProvider {
    override suspend fun accessToken(): String? = null
    override suspend fun refreshAccessToken(failedToken: String?): String? = null
}
