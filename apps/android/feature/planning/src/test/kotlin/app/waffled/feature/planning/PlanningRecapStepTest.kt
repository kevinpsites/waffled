package app.waffled.feature.planning

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.calendar.EventPalette
import app.waffled.feature.calendar.EventStyle
import app.waffled.feature.planning.api.PlanningHttp
import app.waffled.feature.planning.api.PlanningRecapApi
import app.waffled.feature.planning.api.PlanningRecapCounts
import app.waffled.feature.planning.api.PlanningRecapCrumb
import app.waffled.feature.planning.api.PlanningRecapLeftAlone
import app.waffled.feature.planning.api.PlanningRecapView
import app.waffled.feature.planning.steps.PlanningRecapModel
import app.waffled.feature.planning.steps.PlanningRecapText
import app.waffled.feature.planning.steps.RecapNoteComposer
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `PlanningRecapStepTests.swift`. Three things matter most: a ragged payload must
 * cost a card and never the recap, nothing is recomputed (the crumb is INTEGERS ONLY), and
 * "Keep it parked" writes nothing.
 */
class PlanningRecapStepTest {

    private val recapJson = """
    {
      "weekStart": "2026-09-06",
      "savedAt": null,
      "days": [
        { "date": "2026-09-06", "meal": null, "cook": null, "events": [], "more": 0 },
        { "date": "2026-09-07", "meal": "Crockpot chili", "cook": null, "events": [], "more": 0 },
        { "date": "2026-09-08", "meal": "Sheet-pan chicken", "cook": "Lottie",
          "events": [
            { "id": "ev-dance", "title": "Dance", "when": "Tuesday 6:00 PM",
              "personId": "p-lottie", "personName": "Lottie", "personColor": "#7A5AF8",
              "participantIds": [] }
          ],
          "more": 0 },
        { "date": "2026-09-09", "meal": null, "cook": null, "events": [], "more": 0 },
        { "date": "2026-09-10", "meal": null, "cook": null, "events": [], "more": 0 },
        { "date": "2026-09-11", "meal": null, "cook": null,
          "events": [
            { "id": "ev-1", "title": "Recital", "when": "Friday 5:00 PM", "personId": "p-wally",
              "personName": "Wally", "personColor": "#25A368", "participantIds": ["p-kevin"] },
            { "id": "ev-2", "title": "Standup", "when": "Friday 9:00 AM", "personId": null,
              "personName": null, "personColor": null, "participantIds": [] },
            { "id": "ev-3", "title": "Dentist", "when": "Friday 11:00 AM", "personId": "p-kevin",
              "personName": "Kevin", "personColor": null, "participantIds": [] },
            { "id": "ev-4", "title": "Date night", "when": "Friday 8:00 PM", "personId": "p-kevin",
              "personName": "Kevin", "personColor": "#EC6049", "participantIds": ["p-wally", "p-lottie"] }
          ],
          "more": 2,
          "hidden": [
            { "id": "ev-5", "title": "Soccer", "when": "Friday 6:00 PM", "personId": "p-wally",
              "personName": "Wally", "personColor": "#25A368", "participantIds": [] },
            { "id": "ev-6", "title": "Book club", "when": "Friday 7:30 PM", "personId": null,
              "personName": null, "personColor": null, "participantIds": [] }
          ] },
        { "date": "2026-09-12", "meal": null, "cook": null, "events": [], "more": 0 }
      ],
      "groups": [
        { "key": "calendar", "label": "Calendar", "headline": "2 events added since you started",
          "detail": "Date night · Recital", "count": 2, "stepKey": "calendar" },
        { "key": "meals", "label": "Meals + Lists", "headline": "5 nights planned · 14 items on the list",
          "detail": "Sheet-pan chicken · Crockpot chili", "count": 2, "stepKey": "meals" },
        { "key": "tasks", "label": "Chores + Rhythms", "headline": "6 tasks have an owner and a day · 1 rhythm settled",
          "detail": "Furnace filter · Air filter", "count": 2, "stepKey": "tasks" },
        { "key": "kids", "label": "Kids", "headline": "1 answer from the kids",
          "detail": "Wally · Reading", "count": 1, "stepKey": "kids" }
      ],
      "lastCall": [
        { "id": "n-camps", "note": "Look into summer camps",
          "detail": "Parked by Kevin · 2 weeks ago · passed over once" }
      ],
      "lastCallMore": 2,
      "leftAlone": [
        { "key": "step:connection", "label": "Connection", "detail": "Skipped on purpose",
          "badge": "skipped", "stepKey": "connection" },
        { "key": "goals:list-lottie", "label": "Lottie's goals", "detail": "Answered with no focus this week",
          "badge": "none", "stepKey": "goals" },
        { "key": "parked:tasks", "label": "Kelly’s parents in October?", "detail": "Parked for Tasks",
          "badge": "parked", "stepKey": "tasks" }
      ],
      "lastWeekTargets": [
        { "goalId": "g-guitar", "title": "Practice guitar", "emoji": "🎸", "unit": "hours",
          "target": 10, "done": 7 }
      ],
      "counts": { "decisions": 7, "deferred": 3, "parked": 2 }
    }
    """

    private fun recap(): PlanningRecapView = WaffledJson.decodeFromString(recapJson)

    private fun savedRecap(): PlanningRecapView =
        WaffledJson.decodeFromString(recapJson.replace("\"savedAt\": null", "\"savedAt\": \"2026-09-06T17:40:00.000Z\""))

    private class Rejected : Exception()

    private class Feed(var view: PlanningRecapView) {
        var fetchFails = false
        var dropFails = false
        var fetchCount = 0
        val fetchArgs = mutableListOf<Pair<String?, String?>>()
        val drops = mutableListOf<Pair<String, String>>()
        val settles = mutableListOf<Pair<String, String>>()
        val choreBodies = mutableListOf<JsonObject>()

        fun model() = PlanningRecapModel(
            fetchRecap = { s, w ->
                fetchCount++
                fetchArgs += s to w
                if (fetchFails) throw Rejected()
                view
            },
            dropNote = { id, s ->
                drops += id to s
                if (dropFails) throw Rejected()
            },
            settleNote = { id, s -> settles += id to s },
            saveChore = { choreBodies += it },
        )
    }

    // ---- decoding ----

    @Test fun `decodes the whole receipt`() {
        val r = recap()
        assertEquals("2026-09-06", r.weekStart)
        assertNull(r.savedAt)
        assertEquals(
            listOf("2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"),
            r.days.map { it.date },
        )
        assertEquals("Crockpot chili", r.days[1].meal)
        assertEquals(listOf("Dance"), r.days[2].events.map { it.title })
        assertEquals(listOf("calendar", "meals", "tasks", "kids"), r.groups.map { it.key })
        assertEquals("Meals + Lists", r.groups[1].label)
        assertEquals("meals", r.groups[1].stepKey)
        assertEquals(listOf("Look into summer camps"), r.lastCall.map { it.note })
        assertEquals(2, r.lastCallMore)
        assertEquals(listOf("skipped", "none", "parked"), r.leftAlone.map { it.badge })
        assertEquals(PlanningRecapCounts(7, 3, 2), r.counts)
    }

    @Test fun `carries the colour inputs and not a colour`() {
        val dance = recap().days[2].events.first()
        assertEquals("p-lottie", dance.personId)
        assertEquals("#7A5AF8", dance.personColor)
        assertTrue(dance.participantIds.isEmpty())
        val dentist = recap().days[5].events.first { it.title == "Dentist" }
        assertEquals("p-kevin", dentist.personId)
        assertNull(dentist.personColor)
    }

    @Test fun `caps a busy day and reports the remainder`() {
        val friday = recap().days[5]
        assertEquals(4, friday.events.size)
        assertEquals(2, friday.more)
        assertEquals(listOf("Soccer", "Book club"), friday.hidden.map { it.title })
        assertTrue(recap().days[0].hidden.isEmpty())
    }

    @Test fun `a missing participantIds costs a tint and not the session`() {
        val r = WaffledJson.decodeFromString<PlanningRecapView>(
            """{ "weekStart": "2026-09-06",
                 "days": [ { "date": "2026-09-06",
                   "events": [ { "id": "ev-x", "title": "Dance", "when": "Sunday 6:00 PM" } ], "more": 0 } ],
                 "counts": { "decisions": 1, "deferred": 0, "parked": 0 } }""",
        )
        assertEquals(1, r.days[0].events.size)
        assertTrue(r.days[0].events[0].participantIds.isEmpty())
        assertNull(r.days[0].events[0].personId)
        assertEquals(1, r.counts.decisions)
    }

    @Test fun `a day missing its events array still renders`() {
        val r = WaffledJson.decodeFromString<PlanningRecapView>(
            """{ "weekStart": "2026-09-06", "days": [ { "date": "2026-09-06", "meal": "Chili" } ] }""",
        )
        assertTrue(r.days[0].events.isEmpty())
        assertEquals(0, r.days[0].more)
        assertEquals("Chili", r.days[0].meal)
        assertTrue(r.groups.isEmpty())
        assertTrue(r.lastCall.isEmpty())
        assertTrue(r.leftAlone.isEmpty())
        assertEquals(0, r.lastCallMore)
        assertEquals(PlanningRecapCounts(), r.counts)
    }

    @Test fun `an unknown badge renders as itself rather than failing`() {
        val row = WaffledJson.decodeFromString<PlanningRecapLeftAlone>(
            """{ "key": "k", "label": "Something new", "detail": "d", "badge": "postponed", "stepKey": null }""",
        )
        assertEquals("postponed", row.badge)
        assertNull(row.stepKey)
    }

    @Test fun `an older payload with no targets still decodes`() {
        assertTrue(WaffledJson.decodeFromString<PlanningRecapView>("""{"weekStart":"2026-09-06"}""").lastWeekTargets.isEmpty())
    }

    @Test fun `reads the session's week, sessionless reads still ask for a week`() = runTest {
        val harness = ApiTestHarness().apply { start() }
        try {
            val api = PlanningRecapApi(PlanningHttp(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens))
            harness.enqueueJson(recapJson)
            assertEquals(7, api.recap("s-1", "2026-09-06").counts.decisions)
            assertEquals("/api/weekly-planning/recap?sessionId=s-1&weekStart=2026-09-06", harness.takeRequest().path)
            harness.enqueueJson(recapJson)
            api.recap(null, "2026-09-06")
            assertEquals("/api/weekly-planning/recap?weekStart=2026-09-06", harness.takeRequest().path)
        } finally {
            harness.stop()
        }
    }

    // ---- the crumb ----

    @Test fun `the crumb is integers only`() {
        val crumb = assertNotNull(PlanningRecapCrumb.decision(recap()))
        assertEquals(
            buildJsonObject {
                put("counts", buildJsonObject {
                    put("decisions", 7)
                    put("deferred", 3)
                    put("parked", 2)
                })
            },
            crumb,
        )
    }

    @Test fun `nothing read means no crumb at all`() {
        assertNull(PlanningRecapCrumb.decision(null))
    }

    // ---- the copy ----

    @Test fun `the dinner line names the cook only when there is one`() {
        assertEquals("Lentil soup · Lottie", PlanningRecapText.mealLine("Lentil soup", "Lottie"))
        assertEquals("Lentil soup", PlanningRecapText.mealLine("Lentil soup", null))
        assertNull(PlanningRecapText.mealLine(null, "Lottie"))
        assertNull(PlanningRecapText.mealLine("", "Lottie"))
    }

    @Test fun `the header number is the server's and reads as English`() {
        assertEquals("1 decision", PlanningRecapText.decisionsLabel(1))
        assertEquals("7 decisions", PlanningRecapText.decisionsLabel(7))
        assertEquals("…and 1 more still on the board", PlanningRecapText.lastCallMoreLabel(1))
        assertEquals("…and 2 more still on the board", PlanningRecapText.lastCallMoreLabel(2))
    }

    @Test fun `day labels read a date as a label`() {
        assertEquals("Sun", PlanningRecapText.dayName("2026-09-06"))
        assertEquals("6", PlanningRecapText.dayNumber("2026-09-06"))
        assertEquals("Sat", PlanningRecapText.dayName("2026-09-12"))
        assertEquals("12", PlanningRecapText.dayNumber("2026-09-12"))
    }

    @Test fun `last week's targets read against what was logged`() {
        assertEquals("7 of 10 hours", PlanningRecapText.targetLine(recap().lastWeekTargets[0]))
    }

    @Test fun `a week about to be saved reads forward`() {
        assertEquals("What tonight changed", PlanningRecapText.changedTitle(saved = false))
        assertTrue("Saving writes the record" in PlanningRecapText.footNote(saved = false))
        assertTrue("Saving still records" in PlanningRecapText.nothingDecidedDetail(saved = false))
    }

    @Test fun `a week already saved reads back`() {
        assertEquals("What the session changed", PlanningRecapText.changedTitle(saved = true))
        assertFalse("Saving" in PlanningRecapText.footNote(saved = true))
        assertTrue("was saved" in PlanningRecapText.footNote(saved = true))
        assertTrue("was saved as it stood" in PlanningRecapText.nothingDecidedDetail(saved = true))
    }

    // ---- the model ----

    @Test fun `reads the session's own week and builds every day once`() = runTest {
        val feed = Feed(recap())
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        val s = model.state.value
        assertTrue(s.loaded)
        assertEquals(listOf<Pair<String?, String?>>("s-1" to "2026-09-06"), feed.fetchArgs)
        assertEquals(7, s.days.size)
        assertEquals("Sun", s.days[0].dayName)
        assertEquals("6", s.days[0].dayNumber)
        assertEquals("Sheet-pan chicken · Lottie", s.days[2].mealLine)
        assertEquals("Crockpot chili", s.days[1].mealLine)
        assertEquals(2, s.days[5].more)
        assertEquals(listOf("Soccer", "Book club"), s.days[5].hidden.map { it.title })
        assertEquals("p-wally", s.days[5].hidden.first().people.ownerPersonId)
    }

    @Test fun `hands the colour resolver the event's own inputs`() = runTest {
        val model = Feed(recap()).model()
        model.load("s-1", "2026-09-06")
        val days = model.state.value.days
        val dance = days[2].events.first()
        assertEquals("p-lottie", dance.people.ownerPersonId)
        assertEquals("#7A5AF8", dance.people.ownerColorHex)
        assertEquals("Tuesday 6:00 PM", dance.`when`)

        val palette = EventPalette(memberIds = setOf("p-kevin", "p-wally", "p-lottie"), familyHex = "#F97316", style = EventStyle.Tinted)
        val dateNight = days[5].events.first { it.title == "Date night" }
        assertEquals("#F97316", palette.hex(dateNight.people))
        assertEquals("#7A5AF8", palette.hex(dance.people))
        assertNull(palette.hex(days[5].events.first { it.title == "Standup" }.people))
    }

    @Test fun `a failed read keeps the week it already read back`() = runTest {
        val feed = Feed(recap())
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        feed.fetchFails = true
        model.load("s-1", "2026-09-06")
        val s = model.state.value
        assertTrue(s.loaded)
        assertEquals(7, s.days.size)
        assertEquals(7, s.counts.decisions)
        assertNotNull(s.crumb)
    }

    @Test fun `a first read that fails says so without claiming anything`() = runTest {
        val feed = Feed(recap()).apply { fetchFails = true }
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        val s = model.state.value
        assertTrue(s.loaded)
        assertNull(s.view)
        assertTrue(s.days.isEmpty())
        assertNotNull(s.errorMessage)
        assertNull(s.crumb)
    }

    @Test fun `keep it parked writes nothing at all`() = runTest {
        val feed = Feed(recap())
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        model.keepParked("n-camps")
        assertTrue(feed.drops.isEmpty())
        assertTrue(model.state.value.openLastCall.isEmpty())
        assertEquals(2, model.state.value.counts.parked)
    }

    @Test fun `drop it goes through step one's own resolver`() = runTest {
        val feed = Feed(recap())
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        model.drop("n-camps", "s-1")
        assertEquals(listOf("n-camps" to "s-1"), feed.drops)
        assertTrue(model.state.value.openLastCall.isEmpty())
        assertEquals(1, feed.fetchCount)
    }

    @Test fun `a failed drop leaves the note on the board`() = runTest {
        val feed = Feed(recap()).apply { dropFails = true }
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        model.drop("n-camps", "s-1")
        assertEquals(listOf("n-camps"), model.state.value.openLastCall.map { it.id })
        assertNotNull(model.state.value.errorMessage)
        assertNull(model.state.value.working)
    }

    @Test fun `a note made into a task is settled only once the task saved`() = runTest {
        val feed = Feed(recap())
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        val note = model.state.value.openLastCall.first()

        model.makeTask(note)
        assertEquals(RecapNoteComposer.Task(note.id, note.note), model.state.value.composer)
        assertNull(model.saveChoreFromNote(buildJsonObject { put("title", note.note) }))
        model.composerDismissed("s-1")

        assertEquals(1, feed.choreBodies.size)
        assertEquals(listOf(note.id to "s-1"), feed.settles)
        assertTrue(model.state.value.openLastCall.isEmpty())
        assertNull(model.state.value.composer)
    }

    @Test fun `an event saved then dismissed settles once, whichever order the sheet reports in`() = runTest {
        val feed = Feed(recap())
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        val note = model.state.value.openLastCall.first()

        model.makeEvent(note)
        model.eventSaved()
        model.composerDismissed("s-1")
        model.composerDismissed("s-1")

        assertEquals(listOf(note.id to "s-1"), feed.settles)
    }

    @Test fun `a note whose editor is closed without saving stays on the board`() = runTest {
        val feed = Feed(recap())
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        val note = model.state.value.openLastCall.first()
        model.makeEvent(note)
        model.composerDismissed("s-1")
        assertTrue(feed.settles.isEmpty())
        assertEquals(listOf(note.id), model.state.value.openLastCall.map { it.id })
    }

    @Test fun `nothing decided is a state and not an empty screen`() = runTest {
        val feed = Feed(
            WaffledJson.decodeFromString(
                """{ "weekStart": "2026-09-06", "savedAt": null, "days": [], "groups": [], "lastCall": [],
                     "lastCallMore": 0, "leftAlone": [], "counts": { "decisions": 0, "deferred": 0, "parked": 0 } }""",
            ),
        )
        val model = feed.model()
        model.load("s-1", "2026-09-06")
        assertTrue(model.state.value.nothingDecided)
        assertEquals(
            JsonPrimitive(0),
            (model.state.value.crumb!!["counts"] as JsonObject)["decisions"],
        )
    }

    @Test fun `the week itself decides the tense`() = runTest {
        val feed = Feed(recap())
        val live = feed.model()
        live.load("s1", "2026-09-06")
        assertFalse(live.state.value.saved)
        feed.view = savedRecap()
        val saved = feed.model()
        saved.load("s1", "2026-09-06")
        assertTrue(saved.state.value.saved)
    }
}
