package app.waffled.feature.kioskcalendar

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.parameter
import io.ktor.http.HttpMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** The tablet calendar's own REST slice: the Agenda side panel's AI "heads up". */
class KioskCalendarApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {
    @Serializable
    data class HeadsUp(val headline: String, val body: String)

    /**
     * `GET /api/calendar/heads-up` for `from`..`to` (`yyyy-MM-dd`). Null on any failure,
     * like iOS's `try?`: the card is a garnish and keeps its "Thinking…" state.
     */
    suspend fun headsUp(from: String, to: String): HeadsUp? = try {
        withContext(Dispatchers.IO) {
            WaffledHttp.authorized(client, tokens, HttpMethod.Get, "api/calendar/heads-up", {
                parameter("from", from)
                parameter("to", to)
            }) { it.body<HeadsUp>() }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}
