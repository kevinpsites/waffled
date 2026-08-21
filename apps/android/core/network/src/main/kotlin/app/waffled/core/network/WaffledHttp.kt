package app.waffled.core.network

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * Supplies the bearer token and handles a 401 by refreshing once.
 *
 * Declared here (not in `core:auth`) so `core:network` stays dependency-free and
 * `core:auth` can depend on it rather than the other way round.
 */
interface TokenProvider {
    /** The current access token, or null when signed out. */
    suspend fun accessToken(): String?

    /**
     * Called once after a 401. Returns the new access token, or null if the session is
     * over. Implementations MUST be single-flight — see `TokenRefresher`.
     *
     * [failedToken] is the access token the 401'd request actually carried. Passing it
     * is what makes a **staggered** 401 cheap: if the stored token has already moved on,
     * the caller is simply behind and gets the current one instead of triggering a
     * second refresh (and a second rotation of a single-use refresh token). Pass null
     * when the caller has no token to name.
     */
    suspend fun refreshAccessToken(failedToken: String?): String?
}

/** Where the server lives. User-editable at runtime — Waffled is self-hosted. */
interface ServerAddressProvider {
    /** A normalised origin, e.g. `http://10.0.2.2:8080`. */
    fun baseUrl(): String
}

/** Thrown for a non-2xx response, carrying text worth showing the user. */
class WaffledApiException(
    val status: Int,
    val userMessage: String,
) : Exception(userMessage)

val WaffledJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    isLenient = true
}

/**
 * Builds the shared Ktor client.
 *
 * OkHttp is the engine because Coil uses it too, so images and API calls share one
 * connection pool.
 */
object WaffledHttp {

    fun client(
        tokens: TokenProvider,
        server: ServerAddressProvider,
    ): HttpClient = HttpClient(OkHttp) {
        expectSuccess = false

        install(ContentNegotiation) { json(WaffledJson) }

        install(HttpTimeout) {
            requestTimeoutMillis = 30_000
            connectTimeoutMillis = 15_000
            socketTimeoutMillis = 30_000
        }

        defaultRequest {
            url(server.baseUrl().trimEnd('/') + "/")
            header(HttpHeaders.Accept, "application/json")
        }
    }

    /**
     * Turn a response into a body, refreshing once on a 401 and replaying via [retry].
     *
     * Errors relay the SERVER's message — it knows why the request failed and we don't.
     */
    suspend fun <T> unwrap(
        response: HttpResponse,
        tokens: TokenProvider,
        /** The access token this request carried — needed to make a staggered 401 cheap. */
        sentToken: String? = null,
        retry: (suspend (String) -> HttpResponse)? = null,
        parse: suspend (HttpResponse) -> T,
    ): T {
        var current = response

        if (current.status.value == 401 && retry != null) {
            val fresh = tokens.refreshAccessToken(failedToken = sentToken)
            if (fresh != null) current = retry(fresh)
        }

        if (!current.status.isSuccess()) {
            val body = runCatching { current.bodyAsText() }.getOrNull()
            throw WaffledApiException(
                status = current.status.value,
                userMessage = ApiErrorText.from(body, current.status.value),
            )
        }
        return parse(current)
    }
}
