package app.waffled.feature.planning

import app.waffled.core.network.WaffledJson
import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.WeeklyPlanningView
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Port of `PlanningFormatTests.swift`. Fixtures go through the real decoder. */
class PlanningFormatTest {

    private fun stepJson(
        key: String,
        number: Int,
        act: String = "Frame the week",
        available: Boolean = true,
        status: String = "pending",
    ) = """
        {"key":"$key","number":$number,"title":"$key","ask":"?","primary":"OK",
         "act":"$act","available":$available,"status":"$status","data":{},
         "decidedAt":null,"parked":[]}
    """.trimIndent()

    private fun step(
        key: String,
        number: Int,
        act: String = "Frame the week",
        available: Boolean = true,
        status: String = "pending",
    ): PlanningStep = WaffledJson.decodeFromString(stepJson(key, number, act, available, status))

    private fun view(steps: List<String>, currentStep: String? = null, weekStart: String = "2026-09-06"): WeeklyPlanningView {
        val session = currentStep?.let {
            """{"id":"s1","weekStart":"$weekStart","status":"active","currentStep":"$it",
               "driverPersonId":null,"startedAt":"2026-09-06T17:00:00.000Z","completedAt":null}"""
        } ?: "null"
        val json = """
            {"config":{"dayOfWeek":0,"time":"17:00","steps":{},"showOnToday":true},
             "weekStart":"$weekStart","defaultWeekStart":"$weekStart","minWeekStart":"2026-08-30",
             "session":$session,
             "steps":[${steps.joinToString(",")}]}
        """.trimIndent()
        return WaffledJson.decodeFromString(json)
    }

    @Test fun `an unavailable step is never offered or counted`() {
        val steps = listOf(step("looseEnds", 1), step("meals", 2, available = false), step("kids", 2))
        assertEquals(listOf("looseEnds", "kids"), PlanningFormat.availableSteps(steps).map { it.key })
    }

    @Test fun `acts group consecutive runs without hardcoding the act names`() {
        val steps = listOf(
            step("looseEnds", 1, act = "Intake"),
            step("calendar", 2, act = "Frame the week"),
            step("horizon", 3, act = "Frame the week"),
            step("recap", 4, act = "Close"),
        )
        val groups = PlanningFormat.stepsByAct(steps)
        assertEquals(listOf("Intake", "Frame the week", "Close"), groups.map { it.act })
        assertEquals(listOf("calendar", "horizon"), groups[1].steps.map { it.key })
    }

    @Test fun `two separated runs of one act stay separate`() {
        val steps = listOf(step("a", 1, act = "X"), step("b", 2, act = "Y"), step("c", 3, act = "X"))
        assertEquals(listOf("X", "Y", "X"), PlanningFormat.stepsByAct(steps).map { it.act })
    }

    @Test fun `an unavailable step does not split an act in two`() {
        val steps = listOf(
            step("calendar", 1),
            step("meals", 2, available = false),
            step("horizon", 2),
        )
        val groups = PlanningFormat.stepsByAct(steps)
        assertEquals(1, groups.size)
        assertEquals(listOf("calendar", "horizon"), groups[0].steps.map { it.key })
    }

    @Test fun `the step asked for wins over the session's own pointer`() {
        val v = view(listOf(stepJson("looseEnds", 1), stepJson("goals", 2)), currentStep = "looseEnds")
        assertEquals("goals", PlanningFormat.resolveCurrent(v, asked = "goals")?.key)
    }

    @Test fun `with nothing asked for it resumes where the session was left`() {
        val v = view(listOf(stepJson("looseEnds", 1), stepJson("goals", 2)), currentStep = "goals")
        assertEquals("goals", PlanningFormat.resolveCurrent(v)?.key)
    }

    @Test fun `an unavailable step never strands the session on a blank screen`() {
        val v = view(listOf(stepJson("looseEnds", 1), stepJson("meals", 2, available = false)), currentStep = "meals")
        assertEquals("looseEnds", PlanningFormat.resolveCurrent(v, asked = "meals")?.key)
    }

    @Test fun `a view with no runnable steps resolves to nothing`() {
        assertNull(PlanningFormat.resolveCurrent(view(listOf(stepJson("meals", 1, available = false)))))
    }

    @Test fun `no view at all resolves to nothing`() {
        assertNull(PlanningFormat.resolveCurrent(null))
    }

    @Test fun `next skips over an unavailable step`() {
        val steps = listOf(step("calendar", 1), step("meals", 2, available = false), step("kids", 2))
        assertEquals("kids", PlanningFormat.nextStepAfter(steps, "calendar")?.key)
    }

    @Test fun `the last step has no next`() {
        assertNull(PlanningFormat.nextStepAfter(listOf(step("recap", 1)), "recap"))
    }

    @Test fun `weeks step forward and back`() {
        assertEquals("2026-09-13", PlanningFormat.addWeeks("2026-09-06", 1))
        assertEquals("2026-08-30", PlanningFormat.addWeeks("2026-09-06", -1))
        assertEquals("2026-09-06", PlanningFormat.addWeeks("2026-09-06", 0))
    }

    @Test fun `weeks step across a month and a year boundary`() {
        assertEquals("2027-01-03", PlanningFormat.addWeeks("2026-12-27", 1))
    }

    @Test fun `weeks do not drift across a daylight saving boundary`() {
        assertEquals("2026-11-01", PlanningFormat.addWeeks("2026-10-25", 1))
        assertEquals("2026-11-08", PlanningFormat.addWeeks("2026-11-01", 1))
        assertEquals("2026-03-08", PlanningFormat.addWeeks("2026-03-01", 1))
        assertEquals("2026-03-15", PlanningFormat.addWeeks("2026-03-08", 1))
    }

    @Test fun `a week start that is not a date comes back unchanged`() {
        assertEquals("not-a-date", PlanningFormat.addWeeks("not-a-date", 1))
    }

    @Test fun `the day name wraps safely for anything out of range`() {
        assertEquals("Sunday", PlanningFormat.planningDayName(0))
        assertEquals("Saturday", PlanningFormat.planningDayName(6))
        assertEquals("Sunday", PlanningFormat.planningDayName(7))
        assertEquals("Saturday", PlanningFormat.planningDayName(-1))
    }

    @Test fun `the week label spans seven days inclusive`() {
        assertEquals("6 Sun – 12 Sat", PlanningFormat.weekLabel("2026-09-06"))
    }

    @Test fun `the counter is derived from the runnable list not from step number`() {
        val steps = listOf(
            step("looseEnds", 1),
            step("calendar", 2),
            step("meals", 3, available = false),
            step("tasks", 4),
        )
        val (pos, total) = PlanningFormat.position(steps, "tasks")
        assertEquals(3, total)
        assertEquals(3, pos)
    }

    @Test fun `position is zero when no step is on screen`() {
        assertEquals(0, PlanningFormat.position(listOf(step("a", 1)), null).first)
        assertEquals(0, PlanningFormat.position(listOf(step("a", 1)), "nope").first)
    }

    @Test fun `the hair is positional to match the web`() {
        val steps = listOf(step("a", 1), step("b", 2), step("c", 3), step("d", 4))
        assertEquals(0.5, PlanningFormat.hairFraction(steps, "b"))
        assertEquals(1.0, PlanningFormat.hairFraction(steps, "d"))
    }

    @Test fun `the hair ignores whether steps were answered`() {
        val steps = listOf(
            step("a", 1, status = "pending"),
            step("b", 2, status = "done"),
            step("c", 3, status = "done"),
            step("d", 4, status = "done"),
        )
        assertEquals(0.25, PlanningFormat.hairFraction(steps, "a"))
        assertEquals(0.75, PlanningFormat.settledFraction(steps))
    }

    @Test fun `the hair is zero rather than a divide by zero with no runnable steps`() {
        assertEquals(0.0, PlanningFormat.hairFraction(listOf(step("a", 1, available = false)), "a"))
    }

    @Test fun `settled progress counts a skip as a real answer`() {
        val steps = listOf(
            step("a", 1, status = "done"),
            step("b", 2, status = "skipped"),
            step("c", 3, status = "pending"),
            step("d", 4, status = "pending"),
        )
        assertEquals(0.5, PlanningFormat.settledFraction(steps))
    }

    @Test fun `settled progress ignores unavailable steps entirely`() {
        val steps = listOf(step("a", 1, status = "done"), step("b", 2, available = false))
        assertEquals(1.0, PlanningFormat.settledFraction(steps))
    }

    @Test fun `a session with no runnable steps is zero not a divide by zero`() {
        assertEquals(0.0, PlanningFormat.settledFraction(listOf(step("a", 1, available = false))))
    }
}
