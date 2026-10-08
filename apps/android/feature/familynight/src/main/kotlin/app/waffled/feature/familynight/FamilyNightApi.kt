package app.waffled.feature.familynight

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The Family Night slice of the API (`/api/family-night`), entirely REST. Port of the
 * Family Night section of the iOS `WaffledAPI.swift`; camelCase 1:1 with the server.
 */
class FamilyNightApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    /** One agenda part. `rotates` = auto-rotate a person through it each week. */
    @Serializable
    data class Part(
        val id: String,
        val label: String = "",
        val emoji: String = "",
        val rotates: Boolean = true,
    )

    /** The stored config (`settings.familyNight`). `time` is "HH:mm", household-local. */
    @Serializable
    data class Config(
        val parts: List<Part> = emptyList(),
        /** 0=Sun … 6=Sat. */
        val dayOfWeek: Int = 1,
        val time: String = "19:00",
        val rotationOrder: List<String>? = null,
        /** The standing weekly calendar series; null = not on the calendar. */
        val eventId: String? = null,
    )

    @Serializable
    data class Member(
        val id: String,
        val name: String = "",
        val color: String? = null,
        val emoji: String? = null,
    )

    /**
     * A resolved per-part assignment for the upcoming gathering. `suggested` = the
     * rotation's pick (not yet stored); false = a stored override. [detail] says what
     * the part is this week ("charades, kids vs parents") — naming a part never claims it.
     */
    @Serializable
    data class Assignment(
        val partId: String,
        val label: String = "",
        val emoji: String = "",
        val detail: String? = null,
        val personId: String? = null,
        val personName: String? = null,
        val suggested: Boolean = true,
    )

    /** The upcoming gathering; `occurrenceId` is null until something is saved for it. */
    @Serializable
    data class Next(
        /** yyyy-MM-dd in the household's zone — never round-trip it through a device date. */
        val date: String,
        val occurrenceId: String? = null,
        val theme: String? = null,
        val notes: String? = null,
        /** planned | done | skipped */
        val status: String = "planned",
        val assignments: List<Assignment> = emptyList(),
    )

    @Serializable
    data class View(
        val config: Config = Config(),
        val members: List<Member> = emptyList(),
        val next: Next,
    )

    @Serializable private data class ConfigEnvelope(val config: Config)

    @Serializable private data class IdEnvelope(val id: String)

    @Serializable private data class EventEnvelope(val eventId: String)

    /** Config, members, and the next gathering with rotation-resolved assignments. */
    suspend fun view(): View = send(HttpMethod.Get, "api/family-night")

    /** Partial (admin): only the keys present are merged. Returns the confirmed config. */
    suspend fun setConfig(patch: JsonObject): Config =
        send<ConfigEnvelope>(HttpMethod.Put, "api/family-night/config") { json(patch) }.config

    /** Write to one gathering; build [body] with [FamilyNightBodies]. Returns its id. */
    suspend fun saveOccurrence(body: JsonObject): String =
        send<IdEnvelope>(HttpMethod.Post, "api/family-night/occurrence") { json(body) }.id

    /** Create or refresh the standing weekly event. Returns its event id. */
    suspend fun schedule(): String =
        send<EventEnvelope>(HttpMethod.Post, "api/family-night/schedule") { json(JsonObject(emptyMap())) }.eventId

    suspend fun unschedule() {
        withContext(Dispatchers.IO) {
            WaffledHttp.authorized(client, tokens, HttpMethod.Delete, "api/family-night/schedule") { }
        }
    }

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = withContext(Dispatchers.IO) {
        WaffledHttp.authorized(client, tokens, method, path, configure) { it.body<T>() }
    }
}

private fun HttpRequestBuilder.json(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}

/**
 * Request bodies for `POST /api/family-night/occurrence` and the config PUT. Pure, so
 * the presence rules are testable — the server reads whether a KEY WAS SENT, not its
 * value (`upsertOccurrence` in `familyNight.ts`):
 *  - `personId: null` is a real "nobody yet"; a detail-only write must carry NO personId.
 *  - `theme: ""` / `detail: ""` clear; an absent key means "leave it alone".
 */
object FamilyNightBodies {

    fun schedule(day: Int, time: String): JsonObject = buildJsonObject {
        put("dayOfWeek", day)
        put("time", time)
    }

    fun agenda(parts: List<FamilyNightApi.Part>): JsonObject = buildJsonObject {
        putJsonArray("parts") {
            parts.forEach { p ->
                addJsonObject {
                    put("id", p.id)
                    put("label", p.label)
                    put("emoji", p.emoji.ifEmpty { "⭐" })
                    put("rotates", p.rotates)
                }
            }
        }
    }

    /** This week only; also materialises the occurrence, which shifts next week's turn. */
    fun pin(date: String, partId: String, personId: String?): JsonObject = buildJsonObject {
        put("date", date)
        putJsonArray("assignments") {
            addJsonObject {
                put("partId", partId)
                // Always present: the presence is the message, and null is "nobody yet".
                put("personId", personId?.let(::JsonPrimitive) ?: JsonNull)
            }
        }
    }

    /** NO personId key: adding one, even null, would turn "named the treat" into "nobody has it". */
    fun setDetail(date: String, partId: String, detail: String): JsonObject = buildJsonObject {
        put("date", date)
        putJsonArray("assignments") {
            addJsonObject {
                put("partId", partId)
                put("detail", detail)
            }
        }
    }

    fun setTheme(date: String, theme: String): JsonObject = buildJsonObject {
        put("date", date)
        put("theme", theme)
    }

    /** One body both ways — a skip has to be undoable. */
    fun setStatus(date: String, status: String): JsonObject = buildJsonObject {
        put("date", date)
        put("status", status)
    }

    /** Null unlinks and leaves the event on the calendar; it never deletes it. */
    fun linkEvent(date: String, eventId: String?): JsonObject = buildJsonObject {
        put("date", date)
        put("eventId", eventId?.let(::JsonPrimitive) ?: JsonNull)
    }

    /**
     * Creates the week's event and links it SERVER-side in one call: a client-made event
     * may not exist on the server yet, so a create-then-link would 404 on a race. `event`
     * carries what the person confirmed in the sheet; the server places it at the
     * household's local time.
     */
    fun addEvent(date: String, title: String, time: String, durationMin: Int): JsonObject = buildJsonObject {
        put("date", date)
        put("createEvent", true)
        putJsonObject("event") {
            put("title", title)
            put("time", time)
            put("durationMin", durationMin)
        }
    }

    /** The server refuses a longer title. */
    fun limitEventTitle(title: String): String = title.take(200)

    fun defaultEventTitle(theme: String?): String {
        val t = theme?.trim().orEmpty()
        return if (t.isEmpty()) "🏡 Family Night" else "🏡 $t"
    }
}
