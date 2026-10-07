package app.waffled.feature.rhythms

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What closes out a period. [Unknown] is a forward-compatibility valve, never sent. */
enum class RhythmShape(val wire: String) {
    Completion("completion"),
    Scheduling("scheduling"),
    Unknown("unknown");

    companion object {
        fun from(raw: String?): RhythmShape =
            entries.firstOrNull { it.wire == raw && it != Unknown } ?: Unknown
    }
}

/** Why a rhythm is on the attention feed. [Unknown] rows are dropped by the model. */
enum class AttentionKind(val wire: String) {
    Due("due"),
    Unscheduled("unscheduled"),
    Unknown("unknown");

    companion object {
        fun from(raw: String?): AttentionKind =
            entries.firstOrNull { it.wire == raw && it != Unknown } ?: Unknown
    }
}

/**
 * The rhythms slice of the API — the port of the `rhythms` section of iOS `WaffledAPI`.
 *
 * REST-only: the rhythms table is deliberately off PowerSync. The events a booking creates
 * sync as usual (`events.rhythm_id`).
 */
class RhythmsApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    /**
     * One rhythm. The shape is kept as its raw string and read through [shape], so a value
     * this build doesn't know degrades one row instead of failing the whole response.
     * The current-period fields are only on `GET /api/rhythms`; single-row reads omit them.
     */
    @Serializable
    data class Rhythm(
        val id: String,
        val title: String,
        val emoji: String? = null,
        val notes: String? = null,
        val personId: String? = null,
        val satisfiedBy: String = "",
        /** Postgres interval text — "7 days", "3 mons". Render via [RhythmFormat]. */
        val every: String = "",
        val startsOn: String? = null,
        val autoSchedule: Boolean = false,
        val rrule: String? = null,
        val bookWithin: String? = null,
        val leadTime: String = "",
        val lastCompletedAt: String? = null,
        val nextDueAt: String? = null,
        val isActive: Boolean = true,
        val currentPeriodStart: String? = null,
        val currentPeriodEnd: String? = null,
        val currentWindowEnd: String? = null,
        val satisfied: Boolean? = null,
        val hasSeries: Boolean? = null,
        /** Null on a settled period means it was skipped — a skip has no time. */
        val bookedAt: String? = null,
        /** An all-day booking sits at local midnight, so its time must not be printed. */
        val bookedAllDay: Boolean? = null,
    ) {
        val shape: RhythmShape get() = RhythmShape.from(satisfiedBy)

        /** Where bookings stop counting; equal to the period end on a server without windows. */
        val windowEnd: String? get() = currentWindowEnd ?: currentPeriodEnd
    }

    /** One row of `GET /api/rhythms/attention`; fields are per-kind. */
    @Serializable
    data class AttentionItem(
        @SerialName("kind") val rawKind: String = "",
        val rhythm: Rhythm,
        val dueAt: String? = null,
        val overdue: Boolean? = null,
        val periodStart: String? = null,
        /** The next period's start — the grid boundary, and what a skip is keyed on. */
        val periodEnd: String? = null,
        val windowEnd: String? = null,
        val hasSeries: Boolean? = null,
    ) {
        val kind: AttentionKind get() = AttentionKind.from(rawKind)

        /** The last boundary a booking still counts against — the window's, not the grid's. */
        val bookableUntil: String? get() = windowEnd ?: periodEnd
    }

    @Serializable
    data class Completion(
        val id: String,
        val personId: String? = null,
        val completedAt: String,
        val notes: String? = null,
    )

    /** A page of completions; [averageIntervalDays] is over ALL of them, null below two. */
    @Serializable
    data class History(
        val completions: List<Completion> = emptyList(),
        val total: Int = 0,
        val averageIntervalDays: Double? = null,
    )

    @Serializable private data class RhythmsEnvelope(val rhythms: List<Rhythm> = emptyList())
    @Serializable private data class ItemsEnvelope(val items: List<AttentionItem> = emptyList())
    @Serializable private data class RhythmEnvelope(val rhythm: Rhythm)
    @Serializable private data class EventEnvelope(val event: EventId)
    @Serializable private data class EventId(val id: String)

    /** The whole register, each row with its current-period state. */
    suspend fun rhythms(): List<Rhythm> = send<RhythmsEnvelope>(HttpMethod.Get, "api/rhythms").rhythms

    /**
     * What needs attention by [to]. Callers pass a one-day window: [to] also decides WHICH
     * period a scheduling rhythm reports on, so widening it answers about a later period.
     */
    suspend fun attention(from: String, to: String): List<AttentionItem> =
        send<ItemsEnvelope>(HttpMethod.Get, "api/rhythms/attention?from=$from&to=$to").items

    suspend fun create(body: JsonObject): Rhythm =
        send<RhythmEnvelope>(HttpMethod.Post, "api/rhythms") { jsonBody(body) }.rhythm

    /** A [JsonObject] so a cleared field travels as an explicit null (`explicitNulls = false`). */
    suspend fun update(id: String, body: JsonObject): Rhythm =
        send<RhythmEnvelope>(HttpMethod.Patch, "api/rhythms/$id") { jsonBody(body) }.rhythm

    /** Retire for good — soft server-side, so the completion history survives. Answers 204. */
    suspend fun delete(id: String) {
        execute(HttpMethod.Delete, "api/rhythms/$id", {}) { }
    }

    /** [completedAt] null means "now", stamped by the server; an instant backdates it. */
    suspend fun complete(id: String, completedAt: String?): Rhythm =
        send<RhythmEnvelope>(HttpMethod.Post, "api/rhythms/$id/complete") {
            jsonBody(buildJsonObject { completedAt?.let { put("completedAt", it) } })
        }.rhythm

    /**
     * Book a period into a real calendar event; the server fills title and assignee.
     * [periodStart] names the period being shown, so the server can refuse a booking that
     * would land in a different one. Returns the new event's id.
     */
    suspend fun schedule(id: String, startsAt: String, allDay: Boolean, periodStart: String?): String =
        send<EventEnvelope>(HttpMethod.Post, "api/rhythms/$id/schedule") {
            jsonBody(
                buildJsonObject {
                    put("startsAt", startsAt)
                    put("allDay", allDay)
                    periodStart?.let { put("periodStart", it) }
                },
            )
        }.event.id

    /** Settle a period without inventing a calendar entry. */
    suspend fun skip(id: String, periodStart: String) {
        execute(
            HttpMethod.Post,
            "api/rhythms/$id/skip",
            { jsonBody(buildJsonObject { put("periodStart", periodStart) }) },
        ) { }
    }

    suspend fun completions(id: String, limit: Int? = null): History =
        send(HttpMethod.Get, "api/rhythms/$id/completions" + (limit?.let { "?limit=$it" } ?: ""))

    // ---- request plumbing, the shape every feature slice copies ----

    private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

    private suspend fun <T> execute(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit,
        parse: suspend (HttpResponse) -> T,
    ): T = withContext(Dispatchers.IO) {
        val sentToken = tokens.accessToken()

        suspend fun attempt(token: String?): HttpResponse = client.request(path) {
            this.method = method
            if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
            configure()
        }

        WaffledHttp.unwrap(
            response = attempt(sentToken),
            tokens = tokens,
            sentToken = sentToken,
            retry = { fresh -> attempt(fresh) },
            parse = parse,
        )
    }
}
