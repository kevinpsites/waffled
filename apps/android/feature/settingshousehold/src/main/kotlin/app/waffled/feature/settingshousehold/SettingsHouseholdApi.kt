package app.waffled.feature.settingshousehold

import app.waffled.core.model.Person
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
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The routes behind the household Settings panels — AI & Capture, Calendars, Display &
 * Kiosk, Meals, Pantry and the stored chore photos. Ported from the matching sections of
 * the iOS `WaffledAPI.swift`.
 *
 * Bodies that may need to CLEAR a field are built as [JsonObject]s with an explicit
 * [JsonNull]: `WaffledJson` drops nulls from data classes, which would silently turn
 * "clear" into "leave alone".
 */
class SettingsHouseholdApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- AI & Capture ----------------------------------------------------------------

    @Serializable
    data class CaptureConfig(
        /** anthropic | openai | ollama | heuristic */
        val provider: String,
        val model: String? = null,
        val available: Map<String, Boolean> = emptyMap(),
        val defaultModels: Map<String, String> = emptyMap(),
    )

    @Serializable
    data class CaptureConfigUpdate(val provider: String, val model: String? = null)

    /** The words a household has told goal suggestions to ignore, grouped per goal. */
    @Serializable
    data class IgnoreGroup(
        val goalId: String,
        val goalTitle: String,
        val goalEmoji: String? = null,
        val words: List<String> = emptyList(),
    ) {
        val id: String get() = goalId
    }

    @Serializable private data class IgnoreGroupsEnvelope(val groups: List<IgnoreGroup> = emptyList())

    suspend fun captureConfig(): CaptureConfig = send(HttpMethod.Get, "api/capture/config")

    /** Admins only. A null [model] means "the provider's server default". */
    suspend fun setCaptureConfig(provider: String, model: String?): CaptureConfigUpdate =
        send(HttpMethod.Put, "api/capture/config") {
            json(
                buildJsonObject {
                    put("provider", provider)
                    put("model", model?.let(::JsonPrimitive) ?: JsonNull)
                },
            )
        }

    suspend fun goalSuggestionIgnores(): List<IgnoreGroup> =
        send<IgnoreGroupsEnvelope>(HttpMethod.Get, "api/goal-calendar/ignores").groups

    suspend fun removeGoalSuggestionIgnore(goalId: String, word: String) =
        sendUnit(HttpMethod.Post, "api/goal-calendar/ignores/remove") {
            json(buildJsonObject { put("goalId", goalId); put("word", word) })
        }

    // ---- Calendars -------------------------------------------------------------------

    /**
     * `GET /api/calendar/google/status`. The path predates multi-provider but the payload
     * covers Google and Outlook. `microsoftConfigured` and `feeds` default for servers
     * that predate them.
     */
    @Serializable
    data class CalendarStatus(
        val configured: Boolean = false,
        val connected: Boolean = false,
        val accounts: List<Account> = emptyList(),
        val calendars: List<Cal> = emptyList(),
        val microsoftConfigured: Boolean = false,
        val feeds: List<Feed> = emptyList(),
    )

    @Serializable
    data class Account(
        val id: String,
        val email: String? = null,
        val connectedAt: String = "",
        /** google | microsoft. Absent on servers where every account was Google. */
        val provider: String? = null,
    )

    /** One subscribed ICS feed — a URL the server polls; its events arrive read-only. */
    @Serializable
    data class Feed(
        val id: String,
        val url: String,
        val name: String? = null,
        val personId: String? = null,
        val personName: String? = null,
        val personColor: String? = null,
        /** family (shared) | personal (owner-only) */
        val visibility: String = "family",
        val lastSyncedAt: String? = null,
        val lastError: String? = null,
        val createdAt: String = "",
    ) {
        /** ICS URLs are long and near-identical, so an unnamed feed shows its host. */
        val displayName: String
            get() {
                name?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
                val host = runCatching { java.net.URI(url).host }.getOrNull()
                return host?.takeIf { it.isNotEmpty() } ?: "Calendar feed"
            }

        /** A silently stale calendar is worse than a visibly broken one. */
        val hasError: Boolean get() = !lastError.isNullOrEmpty()
    }

    @Serializable
    data class Cal(
        val id: String,
        val accountId: String,
        val summary: String? = null,
        val accessRole: String? = null,
        val colorHex: String? = null,
        val isPrimary: Boolean = false,
        val selected: Boolean = false,
        val isWriteTarget: Boolean = false,
        val visibility: String = "family",
        val personId: String? = null,
        val personName: String? = null,
        val personColor: String? = null,
        val lastSyncedAt: String? = null,
    ) {
        val isWritable: Boolean get() = accessRole == "owner" || accessRole == "writer"
    }

    @Serializable
    data class IcsFeedSyncResult(
        val imported: Int = 0,
        val updated: Int = 0,
        val deleted: Int = 0,
        val error: String? = null,
    )

    @Serializable
    data class CalendarSyncResult(
        val imported: Int = 0,
        val updated: Int = 0,
        val deleted: Int = 0,
        val calendars: List<Line> = emptyList(),
    ) {
        @Serializable
        data class Line(val summary: String? = null, val error: String? = null)

        val errors: List<String> get() = calendars.mapNotNull { it.error }
    }

    @Serializable private data class UrlEnvelope(val url: String)

    suspend fun calendarStatus(): CalendarStatus = send(HttpMethod.Get, "api/calendar/google/status")

    /** Map a calendar to a person, toggle sync or visibility, or set the write-target. */
    suspend fun updateCalendarLink(id: String, body: JsonObject) =
        sendUnit(HttpMethod.Patch, "api/calendar/google/calendars/$id") { json(body) }

    /** Imported events stay; only the account and its calendar links go. */
    suspend fun disconnectCalendarAccount(id: String) =
        sendUnit(HttpMethod.Delete, "api/calendar/google/accounts/$id")

    suspend fun createIcsFeed(url: String, name: String?, personId: String?, visibility: String) =
        sendUnit(HttpMethod.Post, "api/calendar/feeds") {
            json(
                buildJsonObject {
                    put("url", url)
                    put("name", name?.let(::JsonPrimitive) ?: JsonNull)
                    put("personId", personId?.let(::JsonPrimitive) ?: JsonNull)
                    put("visibility", visibility)
                },
            )
        }

    suspend fun updateIcsFeed(id: String, body: JsonObject) =
        sendUnit(HttpMethod.Patch, "api/calendar/feeds/$id") { json(body) }

    /** Unlike disconnecting an account, this also removes the feed's imported events. */
    suspend fun deleteIcsFeed(id: String) = sendUnit(HttpMethod.Delete, "api/calendar/feeds/$id")

    suspend fun syncIcsFeed(id: String): IcsFeedSyncResult =
        send(HttpMethod.Post, "api/calendar/feeds/$id/sync") { json(JsonObject(emptyMap())) }

    suspend fun syncCalendars(): CalendarSyncResult =
        send(HttpMethod.Post, "api/calendar/sync") { json(JsonObject(emptyMap())) }

    /** The provider's consent URL; the server redirects to [redirectTo] when done. */
    suspend fun connectCalendarUrl(provider: CalendarProvider, redirectTo: String): String =
        send<UrlEnvelope>(HttpMethod.Post, provider.connectPath.removePrefix("/")) {
            json(buildJsonObject { put("redirectTo", redirectTo) })
        }.url

    // ---- Countdowns ------------------------------------------------------------------

    @Serializable
    private data class CountdownsEnvelope(val sleeps: Boolean = false, val birthdayHorizonDays: Int? = null)

    suspend fun countdownConfig(): CountdownConfig =
        send<CountdownsEnvelope>(HttpMethod.Get, "api/countdowns").let {
            CountdownConfig(sleeps = it.sleeps, birthdayHorizonDays = it.birthdayHorizonDays ?: 183)
        }

    suspend fun setCountdownSleeps(sleeps: Boolean) =
        sendUnit(HttpMethod.Put, "api/countdowns/config") { json(buildJsonObject { put("sleeps", sleeps) }) }

    suspend fun setCountdownBirthdayHorizon(days: Int) =
        sendUnit(HttpMethod.Put, "api/countdowns/config") {
            json(buildJsonObject { put("birthdayHorizonDays", days) })
        }

    // ---- Display & Kiosk -------------------------------------------------------------

    /** Household-wide family-display settings. Any member reads; only admins write. */
    @Serializable
    data class DisplayConfig(
        val screensaverMinutes: Int = 15,
        /** photos | clock | off */
        val content: String = "photos",
        val returnToPicker: Boolean = false,
        /** 0 = never return to Today. */
        val resetHomeMinutes: Int = 3,
        val nightDim: NightDim = NightDim(),
        /** all | favorites | album */
        val photoSource: String = "all",
        val photoAlbum: String? = null,
        val photoInterval: Int = 8,
        val photoShuffle: Boolean = true,
    ) {
        @Serializable
        data class NightDim(
            val enabled: Boolean = false,
            /** HH:mm */
            val start: String = "22:00",
            val end: String = "07:00",
        )
    }

    @Serializable
    data class KioskDevice(
        val id: String,
        val label: String,
        val lastSeenAt: String? = null,
        val createdAt: String = "",
    )

    @Serializable
    data class PairingCode(val code: String, val label: String = "", val expiresAt: String = "")

    @Serializable private data class DevicesEnvelope(val devices: List<KioskDevice> = emptyList())

    @Serializable private data class PhotoMemory(val memory: String? = null)

    @Serializable private data class PhotosEnvelope(val photos: List<PhotoMemory> = emptyList())

    suspend fun displayConfig(): DisplayConfig = send(HttpMethod.Get, "api/kiosk/display")

    /** Returns the server-normalised config (clamped minutes, coerced fields). */
    suspend fun setDisplayConfig(cfg: DisplayConfig): DisplayConfig =
        send(HttpMethod.Put, "api/kiosk/display") {
            json(
                buildJsonObject {
                    put("screensaverMinutes", cfg.screensaverMinutes)
                    put("content", cfg.content)
                    put("returnToPicker", cfg.returnToPicker)
                    put("resetHomeMinutes", cfg.resetHomeMinutes)
                    put(
                        "nightDim",
                        buildJsonObject {
                            put("enabled", cfg.nightDim.enabled)
                            put("start", cfg.nightDim.start)
                            put("end", cfg.nightDim.end)
                        },
                    )
                    put("photoSource", cfg.photoSource)
                    put("photoAlbum", cfg.photoAlbum?.let(::JsonPrimitive) ?: JsonNull)
                    put("photoInterval", cfg.photoInterval)
                    put("photoShuffle", cfg.photoShuffle)
                },
            )
        }

    /** Album names across the household's photos, for the slideshow's album picker. */
    suspend fun photoAlbums(): List<String> =
        DisplayKioskLogic.albumChoices(send<PhotosEnvelope>(HttpMethod.Get, "api/photos").photos.map { it.memory })

    suspend fun kioskDevices(): List<KioskDevice> =
        send<DevicesEnvelope>(HttpMethod.Get, "api/kiosk/devices").devices

    /** A one-time code (about 10 minutes) a new tablet enters to pair. Admins only. */
    suspend fun createPairingCode(): PairingCode =
        send(HttpMethod.Post, "api/kiosk/pairing-code") { json(JsonObject(emptyMap())) }

    suspend fun revokeKioskDevice(id: String) = sendUnit(HttpMethod.Delete, "api/kiosk/devices/$id")

    // ---- Meals -----------------------------------------------------------------------

    /** How planned meals land on the calendar. `participantIds` null = the whole family. */
    @Serializable
    data class MealCalendarSettings(
        val addToCalendar: Boolean = true,
        val pushToGoogle: Boolean = true,
        val calendarPersonId: String? = null,
        val participantIds: List<String>? = null,
        /** meal key → HH:mm */
        val times: Map<String, String> = emptyMap(),
        val durationMinutes: Int = 60,
        val prepReminder: Boolean = false,
        val prepReminderTime: String = "08:00",
        val prepReminderMealTypes: List<String> = listOf("dinner"),
    )

    @Serializable private data class MealSettingsEnvelope(val settings: MealCalendarSettings)

    @Serializable private data class HouseholdSettingsEnvelope(val members: List<Person> = emptyList())

    suspend fun mealCalendarSettings(): MealCalendarSettings =
        send<MealSettingsEnvelope>(HttpMethod.Get, "api/meals/calendar-settings").settings

    /** Admins only. Saving also re-syncs the household's existing planned meals. */
    suspend fun setMealCalendarSettings(body: JsonObject): MealCalendarSettings =
        send<MealSettingsEnvelope>(HttpMethod.Put, "api/meals/calendar-settings") { json(body) }.settings

    suspend fun householdMembers(): List<Person> =
        send<HouseholdSettingsEnvelope>(HttpMethod.Get, "api/household/settings").members

    // ---- Pantry ----------------------------------------------------------------------

    @Serializable
    data class PantryConfig(
        val locations: List<String> = emptyList(),
        val showOnToday: Boolean = true,
        val avoidAllergens: List<String> = emptyList(),
        val lowThreshold: Double = 1.0,
        val locationIcons: Map<String, String>? = null,
        val staleMonths: Double? = null,
    )

    /** The list endpoint carries the config inline; there is no separate GET. */
    suspend fun pantryConfig(): PantryConfig = send(HttpMethod.Get, "api/pantry")

    /** A partial merge — send only what changed. Any member may write. */
    suspend fun setPantryConfig(body: JsonObject): PantryConfig =
        send(HttpMethod.Put, "api/pantry/config") { json(body) }

    // ---- Stored chore photos ---------------------------------------------------------

    @Serializable
    data class StoredProof(
        val instanceId: String,
        val choreTitle: String,
        val emoji: String? = null,
        val personName: String? = null,
        val personAvatar: String? = null,
        val personColor: String? = null,
        val proofUrl: String? = null,
        val completedAt: String? = null,
    ) {
        val id: String get() = instanceId
    }

    @Serializable private data class ProofsEnvelope(val proofs: List<StoredProof> = emptyList())

    @Serializable private data class ClearedEnvelope(val cleared: Int = 0)

    suspend fun storedProofs(): List<StoredProof> =
        send<ProofsEnvelope>(HttpMethod.Get, "api/chore-proofs").proofs

    /** Drops the blob; the chore keeps its `hadProof` flag. */
    suspend fun deleteProof(instanceId: String) =
        sendUnit(HttpMethod.Delete, "api/chore-proofs/$instanceId")

    /** Returns how many were cleared. */
    suspend fun clearProofs(): Int = send<ClearedEnvelope>(HttpMethod.Delete, "api/chore-proofs").cleared

    // ---- request plumbing ------------------------------------------------------------

    private fun HttpRequestBuilder.json(body: JsonObject) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit = {},
    ) {
        execute(method, path, configure) { }
    }

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

/** The household Countdowns preferences shown at the top of the Calendars panel. */
data class CountdownConfig(val sleeps: Boolean, val birthdayHorizonDays: Int)
