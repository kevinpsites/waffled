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
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

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
        return sessionFrom(response)
    }

    /** Where the browser starts single sign-on; the server sends it back to [OIDC_REDIRECT]. */
    fun oidcStartUrl(): String =
        server.baseUrl().trimEnd('/') + "/api/auth/oidc/start?redirect=" +
            URLEncoder.encode(OIDC_REDIRECT, Charsets.UTF_8)

    /** Trade the callback's one-time code for a session. */
    suspend fun oidcExchange(code: String): LoginResult {
        val response = runCatching {
            client.post("api/auth/oidc/exchange") {
                contentType(ContentType.Application.Json)
                setBody(mapOf("code" to code))
            }
        }.getOrElse {
            return LoginResult.Failed("Couldn't reach the server to finish sign-in.")
        }
        if (response.status.value == 403) return LoginResult.Failed(NOT_INVITED)
        return sessionFrom(response)
    }

    private suspend fun sessionFrom(response: HttpResponse): LoginResult {
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
        /** Must match the server's `OIDC_NATIVE_REDIRECT_URI` (default) and the manifest's filter. */
        const val OIDC_REDIRECT = "waffled://auth/callback"
        const val NOT_INVITED = "This account isn't invited to this household yet."

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

/** The deep link single sign-on returns through, read the way iOS `loginWithOIDC` reads it. */
sealed interface OidcCallback {
    data class Code(val code: String) : OidcCallback
    data class Failed(val message: String) : OidcCallback
    /** Some other `waffled://` link (or not a link at all). */
    data object NotOurs : OidcCallback

    companion object {
        fun parse(uri: String): OidcCallback {
            val parsed = runCatching { URI(uri) }.getOrNull() ?: return NotOurs
            val expected = URI(AuthApi.OIDC_REDIRECT)
            if (parsed.scheme != expected.scheme || parsed.host != expected.host || parsed.path != expected.path) {
                return NotOurs
            }
            val query = parsed.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
                val (k, v) = (it.split('=', limit = 2) + "").take(2)
                URLDecoder.decode(k, Charsets.UTF_8) to URLDecoder.decode(v, Charsets.UTF_8)
            }
            // The server bounces invite-gating and verification failures back here.
            query["error"]?.let { error ->
                return Failed(
                    query["error_description"]?.takeIf { it.isNotBlank() }
                        ?: if (error == "not_invited") AuthApi.NOT_INVITED
                        else "Single sign-on didn't complete. Please try again.",
                )
            }
            return query["code"]?.takeIf { it.isNotBlank() }?.let(::Code)
                ?: Failed("Sign-in didn't complete. Please try again.")
        }
    }
}
