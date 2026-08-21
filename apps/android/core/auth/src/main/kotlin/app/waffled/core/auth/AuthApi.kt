package app.waffled.core.auth

import app.waffled.core.network.ApiErrorText
import app.waffled.core.network.ServerAddressProvider
import app.waffled.core.network.WaffledJson
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable

/** OIDC presentation the server dictates — e.g. {"buttonLabel":"Sign in with SSO"}. */
@Serializable
data class OidcConfig(val buttonLabel: String? = null)

/** What login methods this self-hosted server actually offers. */
@Serializable
data class AuthStatus(
    val initialized: Boolean = false,
    val methods: List<String> = emptyList(),
    val oidc: OidcConfig? = null,
) {
    val supportsPassword: Boolean get() = methods.any { it.equals("password", true) }
    val supportsOidc: Boolean get() = methods.any { it.equals("oidc", true) }

    /**
     * The SSO button's text. The server names its own identity provider ("Sign in with
     * Okta", "Sign in with Google"), so relay it rather than inventing generic wording.
     */
    val oidcButtonLabel: String
        get() = oidc?.buttonLabel?.takeIf { it.isNotBlank() } ?: "Continue with single sign-on"
}

/** One household this account belongs to. */
@Serializable
data class Membership(
    val householdId: String,
    val householdName: String? = null,
    val personId: String? = null,
    val isAdmin: Boolean = false,
    val memberType: String? = null,
)

@Serializable
private data class LoginRequest(val email: String, val password: String)

@Serializable
private data class LoginResponse(
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val expiresIn: Int? = null,
    val memberships: List<Membership> = emptyList(),
)

sealed interface LoginResult {
    data class Success(val tokens: TokenPair, val memberships: List<Membership>) : LoginResult
    data class Failed(val message: String) : LoginResult
}

/**
 * The `/api/auth` endpoints.
 *
 * Uses its own bare client, with no auth: signing in cannot itself require a token, and
 * a 401 here means "wrong password", not "refresh and retry".
 *
 * Waffled is self-hosted, so the client must ASK which login methods exist
 * ([status]) rather than assuming — a given stack may offer password, OIDC, or both.
 */
class AuthApi(
    private val server: ServerAddressProvider,
    private val client: HttpClient = defaultClient(server),
) {

    suspend fun status(): AuthStatus? = runCatching {
        val response = client.get("api/auth/status")
        if (!response.status.isSuccess()) return@runCatching null
        WaffledJson.decodeFromString(AuthStatus.serializer(), response.bodyAsText())
    }.getOrNull()

    suspend fun login(email: String, password: String): LoginResult {
        val response = runCatching {
            client.post("api/auth/login") {
                contentType(ContentType.Application.Json)
                setBody(LoginRequest(email.trim(), password))
            }
        }.getOrElse {
            return LoginResult.Failed("Couldn't reach the server. Check the address and try again.")
        }

        val body = runCatching { response.bodyAsText() }.getOrNull()

        if (!response.status.isSuccess()) {
            // Relay the server's own wording — it knows why it refused.
            return LoginResult.Failed(ApiErrorText.from(body, response.status.value))
        }

        val parsed = runCatching {
            WaffledJson.decodeFromString(LoginResponse.serializer(), body.orEmpty())
        }.getOrNull()

        val access = parsed?.accessToken
        val refresh = parsed?.refreshToken
        if (access.isNullOrEmpty() || refresh.isNullOrEmpty()) {
            // A 200 with no tokens is not a sign-in, whatever it claims.
            return LoginResult.Failed("The server didn't return a session. Try again.")
        }

        return LoginResult.Success(TokenPair(access, refresh), parsed.memberships)
    }

    /** Best-effort revoke; the local session is cleared regardless. */
    suspend fun logout(refreshToken: String) {
        runCatching {
            client.post("api/auth/logout") {
                contentType(ContentType.Application.Json)
                setBody(mapOf("refreshToken" to refreshToken))
            }
        }
    }

    fun close() = client.close()

    companion object {
        fun defaultClient(server: ServerAddressProvider): HttpClient = HttpClient(OkHttp) {
            expectSuccess = false
            install(ContentNegotiation) { json(WaffledJson) }
            install(HttpTimeout) {
                requestTimeoutMillis = 20_000
                connectTimeoutMillis = 10_000
            }
            defaultRequest { url(server.baseUrl().trimEnd('/') + "/") }
        }
    }
}
