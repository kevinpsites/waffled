package app.waffled.feature.calendar

import app.waffled.core.model.Person
import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.parameter
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.net.URI
import java.time.ZoneId

/**
 * The calendar slice of the API — the Kotlin port of the `events` / `countdowns` /
 * `calendar` endpoints in `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Calendar is the one PowerSync-backed feature: events STREAM in over sync. Everything
 * else it needs is REST, and lives here —
 *
 *  * **event writes**, because the thin local mirror has no goal columns and cannot expand
 *    an RRULE (iOS routes writes the same way);
 *  * **the rich event detail**, for fields the mirror doesn't carry;
 *  * **countdowns**, merged server-side from three sources;
 *  * **ICS feeds** and the **household display settings**, neither of which syncs.
 *
 * Deliberately not a god-object client: each feature module owns the slice it calls.
 * Everything shared (the Ktor client, the 401 refresh, error text) lives in `core:network`.
 */
class CalendarApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types ------------------------------------------------------------

    /**
     * A countdown item, merged server-side from three sources ([source]): a standalone
     * `countdowns` row, a calendar event flagged `isCountdown`, or a member's next
     * birthday. [daysLeft] is computed in the household timezone; the list is soonest first
     * and never includes past items.
     */
    @Serializable
    data class Countdown(
        val id: String,
        val title: String,
        /** `YYYY-MM-DD`. */
        val date: String,
        val daysLeft: Int,
        /** `standalone` | `event` | `birthday`. */
        val source: String,
        val emoji: String? = null,
        val color: String? = null,
        val personId: String? = null,
    ) {
        /** Only standalone items are editable here — the rest are managed at their source. */
        val isStandalone: Boolean get() = source == "standalone"
    }

    @Serializable
    data class CountdownsResponse(
        val countdowns: List<Countdown> = emptyList(),
        /** The household's "N sleeps" vs "N days" wording. */
        val sleeps: Boolean = false,
        val birthdayHorizonDays: Int = DEFAULT_BIRTHDAY_HORIZON_DAYS,
    )

    /**
     * One event with its full detail (rrule, calendar + sync state, named participants,
     * goal link) — fields the thin local mirror doesn't carry.
     */
    @Serializable
    data class EventDetail(
        val id: String,
        val title: String = "",
        val description: String? = null,
        val location: String? = null,
        val startsAt: String? = null,
        val endsAt: String? = null,
        val allDay: Boolean = false,
        val personId: String? = null,
        val goalId: String? = null,
        val goalStepId: String? = null,
        val rrule: String? = null,
        val recurrenceEndAt: String? = null,
        val calendarName: String? = null,
        val syncState: String? = null,
        val origin: String? = null,
        val personName: String? = null,
        val personColor: String? = null,
        val personEmoji: String? = null,
        val participants: List<Participant> = emptyList(),
    ) {
        @Serializable
        data class Participant(
            val id: String,
            val name: String,
            val colorHex: String? = null,
            val avatarEmoji: String? = null,
        )
    }

    /**
     * One subscribed ICS feed (a URL Waffled polls). Read-only by nature — the events it
     * imports are somebody else's calendar.
     */
    @Serializable
    data class IcsFeed(
        val id: String,
        val url: String,
        /** The household's label for it; null means fall back to the URL's host. */
        val name: String? = null,
        val personId: String? = null,
        val personName: String? = null,
        val personColor: String? = null,
        /** `family` (shared kiosk) | `personal` (owner-only). */
        val visibility: String = "family",
        val lastSyncedAt: String? = null,
        /** Why the last poll failed (e.g. "404 Not Found"); null when healthy. */
        val lastError: String? = null,
        val createdAt: String = "",
    ) {
        /**
         * What to call it on screen. Naming a feed is optional and ICS URLs are long and
         * near-identical, so an unnamed feed falls back to its host — the only part of the
         * URL a person can tell apart at a glance.
         */
        val displayName: String
            get() {
                name?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
                val host = runCatching { URI(url).host }.getOrNull()
                return host?.takeIf { it.isNotEmpty() } ?: "Calendar feed"
            }

        /**
         * A feed whose last poll failed. Surfaced prominently — a silently stale calendar is
         * worse than a visibly broken one.
         */
        val hasError: Boolean get() = !lastError.isNullOrEmpty()
    }

    /** One feed poll's outcome. [error] is absent on a healthy sync. */
    @Serializable
    data class IcsFeedSyncResult(
        val imported: Int = 0,
        val updated: Int = 0,
        val deleted: Int = 0,
        val error: String? = null,
    )

    /** The household context every calendar surface needs before it can lay anything out. */
    data class HouseholdSettings(
        val zone: ZoneId,
        val members: List<Person>,
    )

    /** `settings.display` — how the calendar paints chips, and the whole-family colour. */
    data class HouseholdDisplay(
        val style: EventStyle = EventStyle.Solid,
        val familyHex: String = EventPalette.DEFAULT_FAMILY_HEX,
    )

    // ---- countdowns ------------------------------------------------------------

    /** `GET /api/countdowns` → the merged list + the household "sleeps" preference. */
    suspend fun countdowns(): CountdownsResponse =
        send(HttpMethod.Get, "api/countdowns")

    /** Create a standalone countdown. [date] must be `YYYY-MM-DD`. Returns the new id. */
    suspend fun createCountdown(
        title: String,
        date: String,
        emoji: String? = null,
        color: String? = null,
    ): String = send<IdEnvelope>(HttpMethod.Post, "api/countdowns") {
        jsonBody(
            buildJsonObject {
                put("title", JsonPrimitive(title))
                put("date", JsonPrimitive(date))
                if (!emoji.isNullOrEmpty()) put("emoji", JsonPrimitive(emoji))
                if (!color.isNullOrEmpty()) put("color", JsonPrimitive(color))
            },
        )
    }.id

    /**
     * Patch a standalone countdown.
     *
     * The body is a [JsonObject], not a data class, on purpose: `WaffledJson` is configured
     * with `explicitNulls = false`, so a nullable property would be dropped from the body
     * and "clear the emoji" would silently leave it alone.
     */
    suspend fun updateCountdown(id: String, title: String?, date: String?, emoji: String?, color: String? = null) {
        sendUnit(HttpMethod.Patch, "api/countdowns/$id") {
            jsonBody(
                buildJsonObject {
                    title?.let { put("title", JsonPrimitive(it)) }
                    date?.let { put("date", JsonPrimitive(it)) }
                    put("emoji", emoji.orNullJson())
                    color?.let { put("color", it.ifEmpty { null }.orNullJson()) }
                },
            )
        }
    }

    /** Soft-delete a standalone countdown. */
    suspend fun deleteCountdown(id: String) {
        sendUnit(HttpMethod.Delete, "api/countdowns/$id")
    }

    /** Toggle the household "N sleeps" vs "N days" wording. */
    suspend fun setCountdownSleeps(sleeps: Boolean) {
        sendUnit(HttpMethod.Put, "api/countdowns/config") {
            jsonBody(buildJsonObject { put("sleeps", JsonPrimitive(sleeps)) })
        }
    }

    // ---- events ----------------------------------------------------------------

    /** One event's rich detail. */
    suspend fun eventDetail(id: String): EventDetail =
        send<EventEnvelope>(HttpMethod.Get, "api/events/$id").event

    /**
     * Create an event. Returns the new event's id; PowerSync down-syncs it for display.
     *
     * A recurring or goal-linked create MUST come through here rather than the local mirror
     * — the mirror has no goal columns and cannot expand a rule.
     */
    suspend fun createEvent(
        title: String,
        startsAtIso: String,
        endsAtIso: String? = null,
        allDay: Boolean = false,
        location: String? = null,
        personIds: List<String> = emptyList(),
        goalId: String? = null,
        goalStepId: String? = null,
        calendarId: String? = null,
        timezone: String? = null,
        rrule: String? = null,
        recurrenceEndAt: String? = null,
        isCountdown: Boolean = false,
    ): String = send<NewEventEnvelope>(HttpMethod.Post, "api/events") {
        jsonBody(
            buildJsonObject {
                put("title", JsonPrimitive(title))
                put("startsAt", JsonPrimitive(startsAtIso))
                put("allDay", JsonPrimitive(allDay))
                put("isCountdown", JsonPrimitive(isCountdown))
                endsAtIso?.let { put("endsAt", JsonPrimitive(it)) }
                location?.takeIf { it.isNotEmpty() }?.let { put("location", JsonPrimitive(it)) }
                // The FIRST participant is the owner — the server routes the calendar off it.
                personIds.firstOrNull()?.let { put("personId", JsonPrimitive(it)) }
                if (personIds.isNotEmpty()) {
                    put("participantIds", JsonArray(personIds.map(::JsonPrimitive)))
                }
                goalId?.let { put("goalId", JsonPrimitive(it)) }
                goalStepId?.let { put("goalStepId", JsonPrimitive(it)) }
                calendarId?.let { put("calendarId", JsonPrimitive(it)) }
                timezone?.let { put("timezone", JsonPrimitive(it)) }
                rrule?.takeIf { it.isNotEmpty() }?.let { put("rrule", JsonPrimitive(it)) }
                recurrenceEndAt?.let { put("recurrenceEndAt", JsonPrimitive(it)) }
            },
        )
    }.event.id

    /**
     * Update an event.
     *
     * For a recurring occurrence, [scope] (`this` | `following` | `all`) + [occurrenceStart]
     * pick which occurrences change.
     */
    suspend fun updateEvent(
        id: String,
        title: String,
        startsAtIso: String,
        endsAtIso: String? = null,
        allDay: Boolean = false,
        location: String? = null,
        personIds: List<String> = emptyList(),
        goalId: String? = null,
        goalStepId: String? = null,
        rrule: String? = null,
        clearRrule: Boolean = false,
        recurrenceEndAt: String? = null,
        clearRecurrenceEndAt: Boolean = false,
        scope: String? = null,
        occurrenceStart: String? = null,
        isCountdown: Boolean = false,
        rhythmId: String? = null,
        clearRhythmId: Boolean = false,
    ) {
        val body = eventUpdateBody(
            title, startsAtIso, endsAtIso, allDay, location, personIds, goalId, goalStepId,
            rrule, clearRrule, recurrenceEndAt, clearRecurrenceEndAt, scope, occurrenceStart,
            isCountdown, rhythmId, clearRhythmId,
        )
        sendUnit(HttpMethod.Patch, "api/events/$id") { jsonBody(body) }
    }

    /**
     * Delete an event.
     *
     * For a recurring occurrence, [scope] `this` cancels the one occurrence and `following`
     * caps the series before it; both require [occurrenceStart], carried as QUERY PARAMS
     * because DELETE has no body. `all` (the default) drops the whole series.
     */
    suspend fun deleteEvent(id: String, scope: String? = null, occurrenceStart: String? = null) {
        sendUnit(HttpMethod.Delete, "api/events/$id") {
            if (scope != null && scope != "all" && occurrenceStart != null) {
                parameter("scope", scope)
                parameter("occurrenceStart", occurrenceStart)
            }
        }
    }

    // ---- household -------------------------------------------------------------

    /**
     * The calendar's display preferences. Both values are raw strings on the wire;
     * resolution (and the "anything but tinted is solid" rule) lives in [EventStyle] /
     * [EventPalette] so it matches the web's `display.ts` exactly.
     */
    suspend fun householdDisplay(): HouseholdDisplay {
        val response = send<HouseholdEnvelope>(HttpMethod.Get, "api/household")
        val display = response.household?.settings?.display
        return HouseholdDisplay(
            style = EventStyle.resolve(display?.eventStyle),
            familyHex = EventPalette.normalizedFamilyHex(display?.familyColorHex),
        )
    }

    /**
     * The household members and timezone the calendar needs.
     *
     * ⚠️ Both are REST because neither is reachable from a feature module today:
     * `SyncManager.members` is declared but never populated, and the household ZONE — which
     * `SyncManager` already knows, since it buckets days with it — is held privately inside
     * `DerivedEventState`. `persons` and `households` are both SYNCED tables, so this call
     * is a stopgap rather than the intended long-term source. See the port report.
     */
    suspend fun householdSettings(): HouseholdSettings {
        val envelope = send<HouseholdSettingsEnvelope>(HttpMethod.Get, "api/household/settings")
        return HouseholdSettings(
            // An unrecognised zone must degrade to the device's, never throw: the whole
            // calendar would otherwise fail to load over one bad settings row.
            zone = runCatching { ZoneId.of(envelope.household?.timezone.orEmpty()) }
                .getOrElse { ZoneId.systemDefault() },
            members = envelope.members.map { it.toPerson() },
        )
    }

    // ---- ICS feeds -------------------------------------------------------------

    /** The household's subscribed ICS feeds (empty on a server that predates them). */
    suspend fun icsFeeds(): List<IcsFeed> =
        send<CalendarStatusEnvelope>(HttpMethod.Get, "api/calendar/google/status").feeds

    /** Subscribe to an ICS URL (admins). The poller imports its events read-only. */
    suspend fun createIcsFeed(url: String, name: String?, personId: String?, visibility: String) {
        sendUnit(HttpMethod.Post, "api/calendar/feeds") {
            jsonBody(
                buildJsonObject {
                    put("url", JsonPrimitive(url))
                    put("name", name.orNullJson())
                    put("personId", personId.orNullJson())
                    put("visibility", JsonPrimitive(visibility))
                },
            )
        }
    }

    /** Rename a feed / reassign its owner / flip family-vs-personal (admins). */
    suspend fun updateIcsFeed(id: String, body: JsonObject) {
        sendUnit(HttpMethod.Patch, "api/calendar/feeds/$id") { jsonBody(body) }
    }

    /**
     * Unsubscribe. Unlike disconnecting an OAuth account this also removes the events it
     * imported — the feed was their only source.
     */
    suspend fun deleteIcsFeed(id: String) {
        sendUnit(HttpMethod.Delete, "api/calendar/feeds/$id")
    }

    /** Poll one feed right now. */
    suspend fun syncIcsFeed(id: String): IcsFeedSyncResult =
        send(HttpMethod.Post, "api/calendar/feeds/$id/sync") {
            jsonBody(buildJsonObject { })
        }

    // ---- envelopes -------------------------------------------------------------

    @Serializable private data class IdEnvelope(val id: String)
    @Serializable private data class EventEnvelope(val event: EventDetail)
    @Serializable private data class NewEventEnvelope(val event: NewEvent) {
        @Serializable data class NewEvent(val id: String)
    }

    @Serializable
    private data class HouseholdEnvelope(val household: H? = null) {
        @Serializable data class H(val settings: S? = null)

        @Serializable data class S(val display: D? = null)

        @Serializable data class D(val eventStyle: String? = null, val familyColorHex: String? = null)
    }

    /**
     * ⚠️ The REST envelope is camelCase (`colorHex`), while `core:model`'s [Person] is
     * annotated for the SYNCED TABLE's snake_case columns (`color_hex`). Decoding the
     * response straight into [Person] therefore silently drops the colour and the emoji —
     * every avatar would render grey with no error anywhere. Hence a wire DTO that maps.
     */
    @Serializable
    private data class HouseholdSettingsEnvelope(
        val household: HouseholdDto? = null,
        val members: List<MemberDto> = emptyList(),
    )

    @Serializable
    private data class HouseholdDto(val id: String = "", val name: String = "", val timezone: String? = null)

    @Serializable
    private data class MemberDto(
        val id: String,
        val name: String,
        val colorHex: String? = null,
        val avatarEmoji: String? = null,
        val memberType: String? = null,
        val isAdmin: Boolean = false,
    ) {
        fun toPerson() = Person(
            id = id,
            name = name,
            colorHex = colorHex,
            avatarEmoji = avatarEmoji,
            memberType = memberType,
            isAdmin = isAdmin,
        )
    }

    /**
     * The calendar-status payload. Only `feeds` matters here; the OAuth accounts and
     * calendars belong to Settings. A server older than the app omits `feeds` entirely, so
     * it defaults to none rather than throwing — a decode failure reads to the user as
     * "couldn't reach server", a misleading way to say "your server is a version behind".
     */
    @Serializable
    private data class CalendarStatusEnvelope(val feeds: List<IcsFeed> = emptyList())

    // ---- the request helper ----------------------------------------------------

    /**
     * Build → authorise → send → unwrap. [WaffledHttp.authorized] attaches the bearer per
     * request (it rotates, so it can't be baked into the client), replays once after a
     * refresh, and turns a non-2xx into a `WaffledApiException` carrying the SERVER's
     * message. Network work runs on IO so a caller on the main thread is safe.
     */
    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = withContext(Dispatchers.IO) {
        WaffledHttp.authorized(client, tokens, method, path, configure) { it.body<T>() }
    }

    /** As [send], for a response with no body to decode (a 204 has none at all). */
    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit = {},
    ) {
        withContext(Dispatchers.IO) {
            WaffledHttp.authorized(client, tokens, method, path, configure) { }
        }
    }

    companion object {
        /** What the server assumes when it doesn't say. */
        const val DEFAULT_BIRTHDAY_HORIZON_DAYS: Int = 183

        /**
         * The PATCH body for an event update.
         *
         * Pure and public so the recurring-edit rules are testable without a server. A
         * per-occurrence override can represent only title / start / end / location, so
         * scope `this` omits every SERIES field; `following` and `all` create or update
         * complete masters, so they carry the full series state.
         *
         * Built as a [JsonObject] rather than a data class because `explicitNulls = false`
         * would silently DROP a null — turning "clear the location" into "leave it alone".
         */
        fun eventUpdateBody(
            title: String,
            startsAtIso: String,
            endsAtIso: String?,
            allDay: Boolean,
            location: String?,
            personIds: List<String>,
            goalId: String?,
            goalStepId: String?,
            rrule: String?,
            clearRrule: Boolean,
            recurrenceEndAt: String?,
            clearRecurrenceEndAt: Boolean,
            scope: String?,
            occurrenceStart: String?,
            isCountdown: Boolean,
            rhythmId: String? = null,
            clearRhythmId: Boolean = false,
        ): JsonObject = buildJsonObject {
            put("title", JsonPrimitive(title))
            put("startsAt", JsonPrimitive(startsAtIso))
            put("endsAt", endsAtIso.orNullJson())
            put("location", location.orNullJson())
            scope?.let { put("scope", JsonPrimitive(it)) }
            occurrenceStart?.let { put("occurrenceStart", JsonPrimitive(it)) }

            if (scope != "this") {
                put("allDay", JsonPrimitive(allDay))
                put("personId", personIds.firstOrNull().orNullJson())
                put("participantIds", JsonArray(personIds.map(::JsonPrimitive)))
                put("goalId", goalId.orNullJson())
                put("goalStepId", goalStepId.orNullJson())
                put("isCountdown", JsonPrimitive(isCountdown))
                when {
                    rrule != null -> put("rrule", JsonPrimitive(rrule))
                    clearRrule -> put("rrule", JsonNull)
                }
                when {
                    recurrenceEndAt != null -> put("recurrenceEndAt", JsonPrimitive(recurrenceEndAt))
                    clearRecurrenceEndAt -> put("recurrenceEndAt", JsonNull)
                }
                // Absent means "leave the link alone" on the server, so only an explicit
                // link or unlink is sent; the link lives on the master, never an override.
                when {
                    rhythmId != null -> put("rhythmId", JsonPrimitive(rhythmId))
                    clearRhythmId -> put("rhythmId", JsonNull)
                }
            }
        }
    }
}

/** A value, or an explicit JSON null — never an omitted key. */
private fun String?.orNullJson(): JsonElement = if (this == null) JsonNull else JsonPrimitive(this)

/** Attach a pre-built JSON tree as the request body. */
private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
