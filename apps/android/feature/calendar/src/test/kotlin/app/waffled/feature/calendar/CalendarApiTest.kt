package app.waffled.feature.calendar

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.ZoneId
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The calendar's REST slice, driven against a real MockWebServer through [ApiTestHarness].
 *
 * Events reach the app over PowerSync, but every WRITE and everything the thin local mirror
 * doesn't carry — countdowns, ICS feeds, the household display settings, the rich event
 * detail — is REST, and lives here.
 */
class CalendarApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: CalendarApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = CalendarApi(client, harness.tokens)
    }

    @After
    fun tearDown() = harness.stop()

    private fun bodyOf(raw: String): JsonObject = Json.parseToJsonElement(raw) as JsonObject

    // ---- countdowns ------------------------------------------------------------

    @Test
    fun readsTheMergedCountdownListAndTheSleepsPreference() = runTest {
        harness.enqueueJson(
            """
            {"countdowns":[
              {"id":"c1","title":"Beach trip","date":"2026-08-15","daysLeft":21,"source":"standalone","emoji":"🏖️"},
              {"id":"e9","title":"Emma's recital","date":"2026-08-20","daysLeft":26,"source":"event"}
            ],"sleeps":true,"birthdayHorizonDays":90}
            """.trimIndent(),
        )

        val result = api.countdowns()

        assertEquals(listOf("c1", "e9"), result.countdowns.map { it.id })
        assertTrue(result.sleeps)
        assertEquals(90, result.birthdayHorizonDays)
        assertEquals("/api/countdowns", harness.takeRequest().path)
    }

    @Test
    fun anOlderServerWithoutABirthdayHorizonStillDecodes() = runTest {
        // A server a version behind omits the key entirely. Failing to decode here reads to
        // the user as "couldn't reach server", which is a misleading way to say "your
        // server is older than your app".
        harness.enqueueJson("""{"countdowns":[],"sleeps":false}""")
        assertEquals(CalendarApi.DEFAULT_BIRTHDAY_HORIZON_DAYS, api.countdowns().birthdayHorizonDays)
    }

    @Test
    fun onlyStandaloneCountdownsAreEditable() {
        // Events and birthdays are managed at their source.
        assertTrue(countdown(source = "standalone").isStandalone)
        assertFalse(countdown(source = "event").isStandalone)
        assertFalse(countdown(source = "birthday").isStandalone)
    }

    @Test
    fun createsAStandaloneCountdownAndReturnsItsId() = runTest {
        harness.enqueueJson("""{"id":"c7"}""")

        assertEquals("c7", api.createCountdown(title = "Beach trip", date = "2026-08-15", emoji = "🏖️"))

        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/countdowns", request.path)
        val body = bodyOf(request.body.readUtf8())
        assertEquals(JsonPrimitive("Beach trip"), body["title"])
        assertEquals(JsonPrimitive("2026-08-15"), body["date"])
        assertEquals(JsonPrimitive("🏖️"), body["emoji"])
    }

    @Test
    fun anEmptyEmojiClearsRatherThanBeingOmitted() = runTest {
        // `WaffledJson` sets explicitNulls = false, so a nullable data-class field would be
        // dropped from the body and "remove the emoji" would silently do nothing. The body
        // is built as a JsonObject precisely so the null reaches the wire.
        harness.enqueueJson("", status = 204)

        api.updateCountdown(id = "c1", title = "Mountain trip", date = "2026-09-01", emoji = null)

        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/countdowns/c1", request.path)
        assertEquals(JsonNull, bodyOf(request.body.readUtf8())["emoji"])
    }

    @Test
    fun deletesAStandaloneCountdown() = runTest {
        harness.enqueueJson("", status = 204)
        api.deleteCountdown("c1")
        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/countdowns/c1", request.path)
    }

    // ---- event writes ----------------------------------------------------------

    @Test
    fun aSingleOccurrenceUpdateOmitsEverySeriesOnlyField() = runTest {
        // A per-occurrence override on the server can only carry title/start/end/location.
        // Sending allDay or participantIds with scope "this" would appear to save and then
        // quietly not apply.
        val body = CalendarApi.eventUpdateBody(
            title = "Special practice",
            startsAtIso = "2026-06-22T22:00:00Z",
            endsAtIso = null,
            allDay = true,
            location = "Gym",
            personIds = listOf("person-a"),
            goalId = "goal-a",
            goalStepId = "step-a",
            rrule = "FREQ=DAILY",
            clearRrule = false,
            recurrenceEndAt = null,
            clearRecurrenceEndAt = false,
            scope = "this",
            occurrenceStart = "2026-06-22T22:00:00Z",
            isCountdown = true,
        )

        assertEquals(JsonPrimitive("Special practice"), body["title"])
        assertEquals(JsonPrimitive("Gym"), body["location"])
        assertEquals(JsonPrimitive("this"), body["scope"])
        assertEquals(JsonPrimitive("2026-06-22T22:00:00Z"), body["occurrenceStart"])
        assertNull(body["allDay"])
        assertNull(body["isCountdown"])
        assertNull(body["participantIds"])
        assertNull(body["goalId"])
        assertNull(body["rrule"])
    }

    @Test
    fun aFollowingUpdateCarriesTheWholeSeriesState() = runTest {
        val body = CalendarApi.eventUpdateBody(
            title = "Special practice",
            startsAtIso = "2026-06-22T22:00:00Z",
            endsAtIso = null,
            allDay = true,
            location = null,
            personIds = listOf("person-a"),
            goalId = "goal-a",
            goalStepId = "step-a",
            rrule = "FREQ=DAILY",
            clearRrule = false,
            recurrenceEndAt = null,
            clearRecurrenceEndAt = true,
            scope = "following",
            occurrenceStart = "2026-06-22T22:00:00Z",
            isCountdown = true,
        )

        assertEquals(JsonPrimitive(true), body["allDay"])
        assertEquals(JsonPrimitive(true), body["isCountdown"])
        assertEquals(listOf(JsonPrimitive("person-a")), body["participantIds"]?.let { (it as kotlinx.serialization.json.JsonArray).toList() })
        assertEquals(JsonPrimitive("goal-a"), body["goalId"])
        assertEquals(JsonPrimitive("FREQ=DAILY"), body["rrule"])
        // An explicit null CLEARS the end date; omitting the key would leave it alone.
        assertEquals(JsonNull, body["recurrenceEndAt"])
        // A cleared end / location must be a null on the wire, not a missing key.
        assertEquals(JsonNull, body["location"])
        assertEquals(JsonNull, body["endsAt"])
    }

    @Test
    fun createsAnEventAndReturnsTheNewId() = runTest {
        harness.enqueueJson("""{"event":{"id":"ev-1"}}""")

        val id = api.createEvent(
            title = "Dentist",
            startsAtIso = "2026-06-22T22:00:00Z",
            endsAtIso = "2026-06-22T23:00:00Z",
            allDay = false,
            location = "Main St",
            personIds = listOf("person-a", "person-b"),
            timezone = "America/Denver",
        )

        assertEquals("ev-1", id)
        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/events", request.path)
        val body = bodyOf(request.body.readUtf8())
        // The first participant is the owner — the server routes the calendar off it.
        assertEquals(JsonPrimitive("person-a"), body["personId"])
        assertEquals(JsonPrimitive("America/Denver"), body["timezone"])
    }

    @Test
    fun deletingOneOccurrenceCarriesTheScopeAsQueryParams() = runTest {
        // DELETE has no body, so the scope rides on the URL.
        harness.enqueueJson("", status = 204)
        api.deleteEvent("ev-1", scope = "following", occurrenceStart = "2026-06-22T22:00:00Z")
        val path = harness.takeRequest().path.orEmpty()
        assertContains(path, "scope=following")
        assertContains(path, "occurrenceStart=2026-06-22T22%3A00%3A00Z")
    }

    @Test
    fun deletingAWholeSeriesSendsNoScopeAtAll() = runTest {
        harness.enqueueJson("", status = 204)
        api.deleteEvent("ev-1")
        assertEquals("/api/events/ev-1", harness.takeRequest().path)
    }

    @Test
    fun readsTheRichEventDetail() = runTest {
        harness.enqueueJson(
            """
            {"event":{"id":"ev-1","title":"Band concert","allDay":false,"origin":"ics",
             "calendarName":"School","participants":[{"id":"p1","name":"Emma","colorHex":"#2F7FED"}]}}
            """.trimIndent(),
        )

        val detail = api.eventDetail("ev-1")

        assertEquals("Band concert", detail.title)
        assertEquals("ics", detail.origin)
        assertEquals(listOf("Emma"), detail.participants.map { it.name })
        // The detail is the preferred source for the read-only gate.
        assertTrue(EventOrigin.isReadOnly(detail.origin, mirrorOrigin = null))
    }

    // ---- household display + members -------------------------------------------

    @Test
    fun readsTheCalendarDisplaySettings() = runTest {
        harness.enqueueJson(
            """{"household":{"settings":{"display":{"eventStyle":"tinted","familyColorHex":"#123ABC"}}}}""",
        )

        val display = api.householdDisplay()

        assertEquals(EventStyle.Tinted, display.style)
        assertEquals("#123ABC", display.familyHex)
    }

    @Test
    fun anUnsetDisplaySettingFallsBackToTheDefaults() = runTest {
        harness.enqueueJson("""{"household":{"settings":{}}}""")
        val display = api.householdDisplay()
        assertEquals(EventStyle.Solid, display.style)
        assertEquals(EventPalette.DEFAULT_FAMILY_HEX, display.familyHex)
    }

    @Test
    fun readsTheHouseholdMembersTheColumnsAndFilterNeed() = runTest {
        harness.enqueueJson(
            """
            {"household":{"id":"h1","name":"Seinfeld","timezone":"America/Denver","weekStart":"sunday"},
             "members":[{"id":"p1","name":"Jerry","colorHex":"#2F7FED","avatarEmoji":"🙂"},
                        {"id":"p2","name":"Elaine"}]}
            """.trimIndent(),
        )

        val settings = api.householdSettings()

        assertEquals(listOf("Jerry", "Elaine"), settings.members.map { it.name })
        assertEquals("#2F7FED", settings.members.first().colorHex)
        assertEquals("/api/household/settings", harness.takeRequest().path)
    }

    @Test
    fun readsTheHouseholdTimezoneTheCalendarFormatsIn() = runTest {
        // ⚠️ REST, not sync: `SyncManager` derives day buckets in the household zone but
        // never exposes the zone itself, and the synced `households` row is not readable
        // from a feature module. The calendar needs it to label days and lay out a month.
        harness.enqueueJson(
            """{"household":{"id":"h1","name":"Seinfeld","timezone":"America/Denver","weekStart":"sunday"},"members":[]}""",
        )
        assertEquals(ZoneId.of("America/Denver"), api.householdSettings().zone)
    }

    @Test
    fun readsTheHouseholdWeekStartAndLeavesItUnsetWhenAbsent() = runTest {
        harness.enqueueJson("""{"household":{"id":"h1","name":"X","timezone":"UTC","weekStart":"monday"},"members":[]}""")
        assertEquals(app.waffled.core.model.HouseholdWeekStart.Monday, api.householdSettings().weekStart)
        harness.enqueueJson("""{"household":{"id":"h1","name":"X","timezone":"UTC"},"members":[]}""")
        assertNull(api.householdSettings().weekStart)
    }

    @Test
    fun anUnknownTimezoneFallsBackToTheDeviceRatherThanThrowing() = runTest {
        harness.enqueueJson("""{"household":{"id":"h1","name":"X","timezone":"Mars/Olympus"},"members":[]}""")
        assertEquals(ZoneId.systemDefault(), api.householdSettings().zone)
    }

    // ---- ICS feeds -------------------------------------------------------------

    @Test
    fun readsSubscribedFeedsAndToleratesAServerThatHasNone() = runTest {
        harness.enqueueJson(
            """
            {"configured":true,"connected":true,"accounts":[],"calendars":[],
             "feeds":[{"id":"f1","url":"https://school.example/cal.ics","visibility":"family",
                       "lastError":"404 Not Found","createdAt":"2026-01-01T00:00:00Z"}]}
            """.trimIndent(),
        )

        val feeds = api.icsFeeds()

        assertEquals(1, feeds.size)
        // An unnamed feed falls back to its host — the only part of a long ICS URL a person
        // can tell apart at a glance.
        assertEquals("school.example", feeds.first().displayName)
        // A silently stale calendar is worse than a visibly broken one.
        assertTrue(feeds.first().hasError)
    }

    @Test
    fun aServerWithoutTheFeedsKeyReadsAsNoFeeds() = runTest {
        harness.enqueueJson("""{"configured":false,"connected":false,"accounts":[],"calendars":[]}""")
        assertTrue(api.icsFeeds().isEmpty())
    }

    @Test
    fun pollsOneFeedOnDemand() = runTest {
        harness.enqueueJson("""{"imported":3,"updated":1,"deleted":0}""")
        val result = api.syncIcsFeed("f1")
        assertEquals(3, result.imported)
        assertNull(result.error)
        assertEquals("/api/calendar/feeds/f1/sync", harness.takeRequest().path)
    }

    // ---- the shared request contract -------------------------------------------

    @Test
    fun relaysTheServersOwnMessageOnAFailure() = runTest {
        harness.enqueueError(409, "ReadOnlyEvent", "This event comes from a subscribed calendar.")
        val failure = assertFailsWith<WaffledApiException> { api.deleteEvent("ev-1") }
        assertEquals(409, failure.status)
        assertContains(failure.message.orEmpty(), "subscribed calendar")
    }

    @Test
    fun refreshesOnceAndReplaysAfterA401() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"countdowns":[],"sleeps":false}""")

        api.countdowns()

        assertEquals(1, harness.refreshCount.get())
        assertEquals(2, harness.requestCount)
    }

    // ---- rhythm link on an event (EventRhythmLinkTests) ---------------------------

    private fun rhythmBody(rhythmId: String? = null, clearRhythmId: Boolean = false, scope: String? = null) =
        CalendarApi.eventUpdateBody(
            title = "Zoo trip",
            startsAtIso = "2026-06-22T22:00:00Z",
            endsAtIso = null,
            allDay = false,
            location = null,
            personIds = listOf("person-a"),
            goalId = null,
            goalStepId = null,
            rrule = null,
            clearRrule = false,
            recurrenceEndAt = null,
            clearRecurrenceEndAt = false,
            scope = scope,
            occurrenceStart = null,
            isCountdown = false,
            rhythmId = rhythmId,
            clearRhythmId = clearRhythmId,
        )

    @Test
    fun anEditThatDoesNotTouchTheRhythmLinkLeavesItAlone() {
        // Absent means "don't touch"; a null here would unlink every event this app edits.
        assertFalse(rhythmBody().containsKey("rhythmId"))
    }

    @Test
    fun linkingCarriesTheRhythmId() {
        assertEquals(JsonPrimitive("rh-1"), rhythmBody(rhythmId = "rh-1")["rhythmId"])
    }

    @Test
    fun unlinkingIsStatedAsAnExplicitNull() = runTest {
        harness.enqueueNoContent()
        api.updateEvent(
            id = "e1", title = "Zoo trip", startsAtIso = "2026-06-22T22:00:00Z",
            clearRhythmId = true,
        )
        assertEquals(JsonNull, bodyOf(harness.takeRequest().body.readUtf8())["rhythmId"])
    }

    @Test
    fun oneOccurrenceOverrideCarriesNoRhythmLink() {
        assertNull(rhythmBody(rhythmId = "rh-1", scope = "this")["rhythmId"])
    }

    private fun countdown(source: String) = CalendarApi.Countdown(
        id = "c1",
        title = "Beach trip",
        date = "2026-08-15",
        daysLeft = 21,
        source = source,
    )
}
