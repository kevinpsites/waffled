package app.waffled.feature.planning.api

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import io.ktor.http.encodeURLPathPart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * The one request helper every planning API slice uses — the shell's and each step's
 * `Planning<Step>Api`. Bodies are always a [JsonObject]: several planning routes read key
 * PRESENCE (a null is a 400, or means "clear"), which a data class cannot express under
 * `explicitNulls = false`. Build them with `buildJsonObject`.
 */
class PlanningHttp(val client: HttpClient, val tokens: TokenProvider) {

    suspend inline fun <reified T> get(path: String): T = withContext(Dispatchers.IO) {
        WaffledHttp.authorized(client, tokens, HttpMethod.Get, path) { it.body<T>() }
    }

    /** Send [body] (or none) and decode the response as [T]. */
    suspend inline fun <reified T> send(method: HttpMethod, path: String, body: JsonObject? = null): T =
        withContext(Dispatchers.IO) {
            WaffledHttp.authorized(client, tokens, method, path, {
                if (body != null) {
                    contentType(ContentType.Application.Json)
                    setBody(body)
                }
            }) { it.body<T>() }
        }

    /** Send and ignore the response body (204s, or an envelope nobody reads). */
    suspend fun sendIgnoring(method: HttpMethod, path: String, body: JsonObject? = null) {
        withContext(Dispatchers.IO) {
            WaffledHttp.authorized(client, tokens, method, path, {
                if (body != null) {
                    contentType(ContentType.Application.Json)
                    setBody(body)
                }
            }) { }
        }
    }

    companion object {
        /** `?a=1&b=2` from the non-empty pairs, or "" when there are none. */
        fun query(vararg pairs: Pair<String, String?>): String {
            val parts = pairs.filter { !it.second.isNullOrEmpty() }
                .map { (k, v) -> "$k=${v!!.encodeURLParameter()}" }
            return if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
        }

        /** One path segment, escaped. */
        fun seg(value: String): String = value.encodeURLPathPart()
    }
}
