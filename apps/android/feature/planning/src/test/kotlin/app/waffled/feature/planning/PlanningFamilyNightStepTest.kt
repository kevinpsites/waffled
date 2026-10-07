package app.waffled.feature.planning

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.familynight.FamilyNightBodies
import app.waffled.feature.planning.api.PlanningFamilyNightApi
import app.waffled.feature.planning.api.PlanningFamilyNightBoard
import app.waffled.feature.planning.api.PlanningFamilyNightPart
import app.waffled.feature.planning.api.PlanningHttp
import app.waffled.feature.planning.api.PlanningWeekEvent
import app.waffled.feature.planning.steps.PlanningFamilyNightDecision
import app.waffled.feature.planning.steps.PlanningFamilyNightFormat
import app.waffled.feature.planning.steps.PlanningFamilyNightModel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Test
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `PlanningFamilyNightStepTests.swift`. The occurrence endpoint reads key PRESENCE,
 * so the body tests assert exact key sets; the bodies themselves are `feature:familynight`'s
 * [FamilyNightBodies], reused rather than redefined.
 */
class PlanningFamilyNightStepTest {

    private val boardJson = """
    {
      "weekStart": "2026-09-06",
      "date": "2026-09-09",
      "dayOfWeek": 3,
      "time": "17:00",
      "occurrenceId": "5c1f0a2e-0000-4000-8000-000000000001",
      "theme": "pizza and the new Lego set",
      "status": "planned",
      "onCalendar": true,
      "eventId": "5c1f0a2e-0000-4000-8000-000000000002",
      "eventTitle": "Family Night",
      "eventWhen": "Wednesday 5:00 PM",
      "members": [
        { "id": "p-kevin", "name": "Kevin", "avatarEmoji": null, "colorHex": null },
        { "id": "p-kelly", "name": "Kelly", "avatarEmoji": "🦊", "colorHex": "#E0653F" },
        { "id": "p-wally", "name": "Wally", "avatarEmoji": "🐢", "colorHex": "#25A368" },
        { "id": "p-lottie", "name": "Lottie", "avatarEmoji": "🦄", "colorHex": "#7A5AF8" }
      ],
      "parts": [
        { "partId": "activity", "label": "Activity", "emoji": "🎲", "rotates": true,
          "detail": null, "personId": "p-kevin", "personName": "Kevin", "pinned": false },
        { "partId": "treat", "label": "Treat", "emoji": "🍨", "rotates": true,
          "detail": "the good ice cream", "personId": "p-lottie", "personName": "Lottie", "pinned": true },
        { "partId": "checkin", "label": "Check-in", "emoji": "💬", "rotates": false,
          "detail": null, "personId": null, "personName": null, "pinned": false }
      ]
    }
    """

    private fun board(): PlanningFamilyNightBoard = WaffledJson.decodeFromString(boardJson)

    private class Rejected : Exception()

    private class Feed(var board: PlanningFamilyNightBoard) {
        var fetchFails = false
        var saveFails = false
        var fetchCount = 0
        val bodies = mutableListOf<JsonObject>()

        fun model() = PlanningFamilyNightModel(
            fetchBoard = {
                fetchCount++
                if (fetchFails) throw Rejected()
                board
            },
            saveOccurrence = {
                bodies += it
                if (saveFails) throw Rejected()
            },
            fetchWeekEvents = { _, _ -> emptyList() },
        )
    }

    private fun JsonObject.assignment(): JsonObject = this["assignments"]!!.jsonArray[0].jsonObject

    // ---- presence ----

    @Test fun `a detail write carries no person key`() {
        val body = FamilyNightBodies.setDetail("2026-09-09", "treat", "the good ice cream")
        assertEquals(setOf("date", "assignments"), body.keys)
        assertEquals(setOf("partId", "detail"), body.assignment().keys)
    }

    @Test fun `pinning nobody writes a real nobody-yet rather than omitting the key`() {
        val body = FamilyNightBodies.pin("2026-09-09", "treat", null)
        assertEquals(setOf("partId", "personId"), body.assignment().keys)
        assertEquals(JsonNull, body.assignment()["personId"])
    }

    @Test fun `unlinking sends an explicit null so the event itself survives`() {
        val body = FamilyNightBodies.linkEvent("2026-09-09", null)
        assertEquals(setOf("date", "eventId"), body.keys)
        assertEquals(JsonNull, body["eventId"])
    }

    @Test fun `add to calendar asks the server to make the event with the confirmed details`() {
        val body = FamilyNightBodies.addEvent("2026-09-09", "🌮 Taco night", "18:30", 90)
        assertEquals(setOf("date", "createEvent", "event"), body.keys)
        assertEquals(JsonPrimitive(true), body["createEvent"])
        val event = body["event"]!!.jsonObject
        assertEquals(JsonPrimitive("🌮 Taco night"), event["title"])
        assertEquals(JsonPrimitive("18:30"), event["time"])
        assertEquals(JsonPrimitive(90), event["durationMin"])
    }

    @Test fun `the event sheet opens on the theme or Family Night and stops at the server's limit`() {
        assertEquals("🏡 Board games", FamilyNightBodies.defaultEventTitle("Board games"))
        assertEquals("🏡 Family Night", FamilyNightBodies.defaultEventTitle("  "))
        assertEquals(200, FamilyNightBodies.limitEventTitle("a".repeat(250)).length)
    }

    // ---- the wire ----

    @Test fun `the board and the week's events are read off the shell's week`() = runTest {
        val harness = ApiTestHarness().apply { start() }
        try {
            val api = PlanningFamilyNightApi(PlanningHttp(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens))
            harness.enqueueJson(boardJson)
            assertEquals("2026-09-09", api.board("2026-09-06").date)
            assertEquals("/api/weekly-planning/familyNight?weekStart=2026-09-06", harness.takeRequest().path)

            harness.enqueueJson("""{"events":[{"id":"e1","title":"Swim","startsAt":"2026-09-10T15:00:00Z","allDay":false,"origin":null}]}""")
            assertEquals(listOf("Swim"), api.weekEvents("2026-09-06", "2026-09-12").map { it.title })
            assertEquals("/api/events?from=2026-09-06&to=2026-09-12", harness.takeRequest().path)
        } finally {
            harness.stop()
        }
    }

    @Test fun `decodes the board verbatim off the wire`() {
        val b = board()
        assertEquals("2026-09-06", b.weekStart)
        assertEquals("2026-09-09", b.date)
        assertEquals(3, b.dayOfWeek)
        assertEquals("17:00", b.time)
        assertFalse(b.isSkipped)
        assertTrue(b.onCalendar)
        assertEquals("Family Night", b.eventTitle)
        assertEquals("Wednesday 5:00 PM", b.eventWhen)
        assertEquals(4, b.members.size)
        assertNull(b.members[0].avatarEmoji)
        assertEquals("#E0653F", b.members[1].colorHex)
        assertEquals(listOf("activity", "treat", "checkin"), b.parts.map { it.partId })
        assertFalse(b.parts[0].pinned)
        assertTrue(b.parts[1].pinned)
        assertEquals("the good ice cream", b.parts[1].detail)
        assertFalse(b.parts[2].rotates)
        assertNull(b.parts[2].personName)
    }

    // ---- formatting ----

    @Test fun `the link picker groups the week's events by household day in time order`() {
        val events = WaffledJson.decodeFromString<Map<String, List<PlanningWeekEvent>>>(
            """{"events":[
              {"id":"e2","title":"Movie night","startsAt":"2026-09-11T01:00:00Z","allDay":false,"origin":"manual","personId":"p1","personColor":"#E0548B","personEmoji":"🦄"},
              {"id":"e1","title":"Swim","startsAt":"2026-09-10T15:00:00Z","allDay":false,"origin":null},
              {"id":"e3","title":"Soccer","startsAt":"2026-09-10T22:30:00Z","allDay":false,"origin":null}
            ]}""",
        ).getValue("events")

        val days = PlanningFamilyNightFormat.weekEventDays(events, "2026-09-06", ZoneId.of("America/Chicago"), Locale.US)

        // 8 PM on the 10th in Chicago is the 11th in UTC; it belongs to the evening it happens in.
        assertEquals(listOf("2026-09-10"), days.map { it.key })
        assertEquals("Thursday · Sep 10", days[0].label)
        assertEquals(listOf("Swim", "Soccer", "Movie night"), days[0].events.map { it.event.title })
        // Carried into the chip's owner, so it paints in the owner's colour.
        assertEquals("#E0548B", days[0].events.last().owner?.colorHex)
        assertEquals("🦄", days[0].events.last().owner?.avatarEmoji)
        assertNull(days[0].events.first().owner)
    }

    @Test fun `the subline tells a suggestion apart from a decision`() {
        val b = board()
        assertEquals("suggested · Kevin, next in the rotation", PlanningFamilyNightFormat.suggestion(b.parts[0]))
        assertEquals("pinned for this week · Lottie", PlanningFamilyNightFormat.suggestion(b.parts[1]))
        assertEquals("nobody yet", PlanningFamilyNightFormat.suggestion(b.parts[2]))
    }

    @Test fun `detail hints fall back to the part's own label`() {
        val b = board()
        assertTrue("charades" in PlanningFamilyNightFormat.detailHint(b.parts[0]))
        assertTrue("good ice cream" in PlanningFamilyNightFormat.detailHint(b.parts[1]))
        assertTrue("how was school" in PlanningFamilyNightFormat.detailHint(b.parts[2]))
        val custom = WaffledJson.decodeFromString<PlanningFamilyNightPart>(
            """{"partId":"service","label":"Service","emoji":"🤝","rotates":true,"detail":null,"personId":null,"personName":null,"pinned":false}""",
        )
        assertEquals("optional — what's the service?", PlanningFamilyNightFormat.detailHint(custom))
    }

    @Test fun `the event picker's week is stepped in whole days off the server's boundary`() {
        assertEquals("2026-09-12", PlanningFamilyNightFormat.plusDays("2026-09-06", 6))
        assertEquals("2026-11-04", PlanningFamilyNightFormat.plusDays("2026-10-29", 6))
    }

    @Test fun `the long date reads the label as a calendar day`() {
        assertEquals("Wednesday, Sep 9", PlanningFamilyNightFormat.longDate("2026-09-09", Locale.US))
        assertEquals("garbage", PlanningFamilyNightFormat.longDate("garbage", Locale.US))
    }

    // ---- the model ----

    @Test fun `a failed read keeps the board that was already on screen`() = runTest {
        val feed = Feed(board())
        val model = feed.model()
        model.load("2026-09-06")
        feed.fetchFails = true
        model.load("2026-09-06")
        assertEquals("pizza and the new Lego set", model.state.value.board?.theme)
        assertTrue(model.state.value.loaded)
    }

    @Test fun `a first read that fails says so`() = runTest {
        val feed = Feed(board()).apply { fetchFails = true }
        val model = feed.model()
        model.load("2026-09-06")
        assertTrue(model.state.value.loaded)
        assertNull(model.state.value.board)
        assertNotNull(model.state.value.errorMessage)
    }

    @Test fun `a failed write neither refetches nor mutates`() = runTest {
        val feed = Feed(board()).apply { saveFails = true }
        val model = feed.model()
        model.load("2026-09-06")
        val rev = model.state.value.rev

        val ok = model.write(FamilyNightBodies.setStatus("2026-09-09", "skipped"), "2026-09-06")

        assertFalse(ok)
        assertEquals(1, feed.bodies.size)
        assertEquals(1, feed.fetchCount)
        assertEquals(rev, model.state.value.rev)
        assertEquals("planned", model.state.value.board?.status)
        assertNotNull(model.state.value.errorMessage)
        assertFalse(model.state.value.busy)
    }

    @Test fun `a write that lands rereads rather than patching locally`() = runTest {
        val feed = Feed(board())
        val model = feed.model()
        model.load("2026-09-06")

        val ok = model.write(FamilyNightBodies.pin("2026-09-09", "activity", "p-wally"), "2026-09-06")

        assertTrue(ok)
        assertEquals(2, feed.fetchCount)
        assertEquals(1, feed.bodies.size)
        assertEquals(3, model.state.value.rows.size)
        assertEquals("every Wednesday", model.state.value.recurrence)
        assertEquals("What is the activity?", model.state.value.rows[0].detailDescription)
    }

    @Test fun `the week's events load once and drop meal mirrors`() = runTest {
        var asked = 0
        val model = PlanningFamilyNightModel(
            fetchBoard = { board() },
            saveOccurrence = { },
            fetchWeekEvents = { from, to ->
                asked++
                assertEquals("2026-09-06", from)
                assertEquals("2026-09-12", to)
                listOf(
                    PlanningWeekEvent(id = "a", title = "Swim"),
                    PlanningWeekEvent(id = "b", title = "Tacos", origin = "meal_plan"),
                    PlanningWeekEvent(id = "c", title = "Prep", origin = "meal_prep"),
                )
            },
        )
        model.loadWeekEvents("2026-09-06")
        model.loadWeekEvents("2026-09-06")
        assertEquals(1, asked)
        assertEquals(listOf("Swim"), model.state.value.weekEvents.map { it.title })
        assertTrue(model.state.value.weekEventsLoaded)
    }

    // ---- the crumb ----

    @Test fun `the crumb records what was decided and not a copy of the module`() {
        val crumb = PlanningFamilyNightDecision.crumb(board())
        assertEquals(setOf("pinned", "skipped"), crumb.keys)
        assertEquals(JsonArray(listOf(JsonPrimitive("treat"))), crumb["pinned"])
        assertEquals(JsonPrimitive(false), crumb["skipped"])
    }

    @Test fun `the crumb is empty but well formed before anything is read`() {
        val crumb = PlanningFamilyNightDecision.crumb(null)
        assertEquals(JsonArray(emptyList()), crumb["pinned"])
        assertEquals(JsonPrimitive(false), crumb["skipped"])
    }
}
