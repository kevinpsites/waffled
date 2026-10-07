package app.waffled.feature.planning

import app.waffled.core.network.WaffledJson
import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.WeeklyPlanningCompletion
import app.waffled.feature.planning.api.WeeklyPlanningConfigView
import app.waffled.feature.planning.api.WeeklyPlanningView
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `PlanningDTODecodingTests.swift`. The load-bearing cases are the ABSENT keys:
 * `parked` from an older server, `requiresModule` on the steps with no module.
 */
class PlanningDtoDecodingTest {

    @Test fun `decodes the full view`() {
        val view = WaffledJson.decodeFromString<WeeklyPlanningView>(
            """
            {
              "config": { "dayOfWeek": 0, "time": "17:00", "steps": { "horizon": false }, "showOnToday": true },
              "weekStart": "2026-09-06",
              "defaultWeekStart": "2026-09-06",
              "minWeekStart": "2026-08-30",
              "session": {
                "id": "3f1c6d54-0f7a-4a3e-9a1d-2c5b7e8f0a11",
                "weekStart": "2026-09-06",
                "status": "active",
                "currentStep": "calendar",
                "driverPersonId": "8b2e1a90-11c4-4c1e-8c7a-5d3f9b0e2a44",
                "startedAt": "2026-09-06T17:00:03.412Z",
                "completedAt": null
              },
              "steps": [
                {
                  "key": "looseEnds", "number": 1, "title": "Loose ends",
                  "ask": "Anything still open from last week?", "primary": "All handled",
                  "act": "Intake", "available": true, "status": "done",
                  "data": { "cleared": 4, "parked": true },
                  "decidedAt": "2026-09-06T17:02:11.008Z",
                  "parked": []
                },
                {
                  "key": "calendar", "number": 2, "title": "Calendar",
                  "ask": "Here’s your week. Anything missing?", "primary": "Looks right",
                  "act": "Frame the week", "available": true, "status": "pending",
                  "data": {}, "decidedAt": null,
                  "parked": [
                    { "id": "c0ffee00-0000-4000-8000-000000000001", "note": "Book the dentist", "byline": "Kevin · 2 weeks ago" },
                    { "id": "c0ffee00-0000-4000-8000-000000000002", "note": "Swim lessons start", "byline": null }
                  ]
                },
                {
                  "key": "meals", "number": 7, "title": "Meals",
                  "ask": "What’s planned, and what’s still open?", "primary": "Done",
                  "act": "Run the household", "requiresModule": "meals",
                  "available": false, "status": "pending",
                  "data": {}, "decidedAt": null, "parked": []
                }
              ]
            }
            """.trimIndent(),
        )

        assertEquals("2026-09-06", view.weekStart)
        assertEquals("2026-08-30", view.minWeekStart)
        assertEquals(0, view.config.dayOfWeek)
        assertEquals("17:00", view.config.time)
        assertEquals(false, view.config.steps["horizon"])
        assertTrue(view.config.showOnToday)

        val session = assertNotNull(view.session)
        assertTrue(session.isActive)
        assertEquals("calendar", session.currentStep)
        assertNull(session.completedAt)
        assertEquals("2026-09-06T17:00:03.412Z", session.startedAt)

        assertEquals(3, view.steps.size)
        val looseEnds = view.steps[0]
        assertTrue(looseEnds.isDone)
        assertTrue(looseEnds.isSettled)
        assertNull(looseEnds.requiresModule)
        assertEquals(JsonPrimitive(4), looseEnds.data["cleared"])
        assertEquals(JsonPrimitive(true), looseEnds.data["parked"])

        val calendar = view.steps[1]
        assertEquals(2, calendar.parked.orEmpty().size)
        assertEquals("Book the dentist", calendar.parked?.first()?.note)
        assertEquals("Kevin · 2 weeks ago", calendar.parked?.first()?.byline)
        assertNull(calendar.parked?.last()?.byline)

        val meals = view.steps[2]
        assertEquals("meals", meals.requiresModule)
        assertFalse(meals.available)

        assertEquals(listOf("looseEnds", "calendar"), PlanningFormat.availableSteps(view.steps).map { it.key })
        assertEquals("calendar", PlanningFormat.resolveCurrent(view)?.key)
        assertEquals(0.5, PlanningFormat.settledFraction(view.steps))
    }

    @Test fun `a step with no parked key still decodes`() {
        val step = WaffledJson.decodeFromString<PlanningStep>(
            """
            {
              "key": "kids", "number": 9, "title": "Kids", "ask": "What’s your week about?",
              "primary": "Done", "act": "Run the household",
              "available": true, "status": "pending", "data": {}, "decidedAt": null
            }
            """.trimIndent(),
        )
        assertNull(step.parked)
        assertTrue(step.parked.orEmpty().isEmpty())
        assertNull(step.requiresModule)
        assertFalse(step.isSettled)
    }

    @Test fun `a skipped step is settled but not done`() {
        val step = WaffledJson.decodeFromString<PlanningStep>(
            """
            {
              "key": "horizon", "number": 3, "title": "Horizon scan",
              "ask": "Anything further out you should see now?", "primary": "Nothing missing",
              "act": "Frame the week", "available": true, "status": "skipped",
              "data": {}, "decidedAt": "2026-09-06T17:09:44.100Z", "parked": []
            }
            """.trimIndent(),
        )
        assertTrue(step.isSkipped)
        assertTrue(step.isSettled)
        assertFalse(step.isDone)
    }

    @Test fun `decodes a view with no session yet`() {
        val view = WaffledJson.decodeFromString<WeeklyPlanningView>(
            """
            {
              "config": { "dayOfWeek": 4, "time": "18:30", "steps": {}, "showOnToday": false },
              "weekStart": "2026-09-13",
              "defaultWeekStart": "2026-09-13",
              "minWeekStart": "2026-09-06",
              "session": null,
              "steps": []
            }
            """.trimIndent(),
        )
        assertNull(view.session)
        assertFalse(view.config.showOnToday)
        assertTrue(view.config.steps.isEmpty())
        assertNull(PlanningFormat.resolveCurrent(view))
        assertEquals(0.0, PlanningFormat.settledFraction(view.steps))
    }

    @Test fun `decodes the completed session envelope`() {
        val done = WaffledJson.decodeFromString<WeeklyPlanningCompletion>(
            """
            {
              "session": {
                "id": "3f1c6d54-0f7a-4a3e-9a1d-2c5b7e8f0a11",
                "weekStart": "2026-09-06",
                "status": "completed",
                "currentStep": "recap",
                "driverPersonId": null,
                "startedAt": "2026-09-06T17:00:03.412Z",
                "completedAt": "2026-09-06T17:32:58.771Z"
              },
              "steps": []
            }
            """.trimIndent(),
        )
        assertTrue(done.session.isCompleted)
        assertFalse(done.session.isActive)
        assertEquals("2026-09-06T17:32:58.771Z", done.session.completedAt)
    }

    @Test fun `decodes the bare config catalog`() {
        val payload = WaffledJson.decodeFromString<WeeklyPlanningConfigView>(
            """
            {
              "config": { "dayOfWeek": 0, "time": "17:00", "steps": {}, "showOnToday": true },
              "steps": [
                { "key": "looseEnds", "title": "Loose ends", "ask": "Anything still open from last week?", "primary": "All handled", "act": "Intake" },
                { "key": "tasks", "title": "Tasks", "ask": "Who’s doing what?", "primary": "Handed out", "act": "Run the household", "requiresModule": "chores" }
              ]
            }
            """.trimIndent(),
        )
        assertEquals(2, payload.steps.size)
        assertNull(payload.steps[0].requiresModule)
        assertEquals("chores", payload.steps[1].requiresModule)
        assertEquals("Handed out", payload.steps[1].primary)
    }

    @Test fun `a timestamp with no fraction still formats`() {
        assertNotEquals("2026-09-06T17:32:58Z", PlanningModel.savedLabel("2026-09-06T17:32:58Z"))
        assertNotEquals("2026-09-06T17:32:58.771Z", PlanningModel.savedLabel("2026-09-06T17:32:58.771Z"))
        assertEquals("not a timestamp", PlanningModel.savedLabel("not a timestamp"))
    }
}
