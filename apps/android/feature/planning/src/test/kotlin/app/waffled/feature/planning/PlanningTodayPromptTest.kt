package app.waffled.feature.planning

import app.waffled.feature.planning.api.PlanningSession
import app.waffled.feature.planning.api.WeeklyPlanningConfig
import app.waffled.feature.planning.api.WeeklyPlanningView
import org.junit.Test
import kotlin.test.assertEquals

/**
 * The Today card's three states. No iOS test covers `PlanningTodayCard.prompt`; this one
 * locks the same rules so the card can't flash "due" before data or ignore `showOnToday`.
 */
class PlanningTodayPromptTest {

    private fun view(showOnToday: Boolean = true, dayOfWeek: Int = 0, status: String? = null) = WeeklyPlanningView(
        config = WeeklyPlanningConfig(dayOfWeek = dayOfWeek, time = "17:00", showOnToday = showOnToday),
        weekStart = "2026-09-06",
        defaultWeekStart = "2026-09-06",
        minWeekStart = "2026-08-30",
        session = status?.let { PlanningSession("s1", "2026-09-06", it, null, null, "2026-09-06T17:00:00Z") },
    )

    @Test fun `nothing is decided before the first fetch`() {
        assertEquals(PlanningTodayPrompt.Quiet, PlanningTodayPrompt.of(null, todayDow = 0))
    }

    @Test fun `the card hides when show-on-today is off`() {
        assertEquals(PlanningTodayPrompt.Quiet, PlanningTodayPrompt.of(view(showOnToday = false, status = "active"), 0))
    }

    @Test fun `a session day with nothing started is due`() {
        assertEquals(PlanningTodayPrompt.Due, PlanningTodayPrompt.of(view(dayOfWeek = 3), todayDow = 3))
        assertEquals(PlanningTodayPrompt.Quiet, PlanningTodayPrompt.of(view(dayOfWeek = 3), todayDow = 4))
    }

    @Test fun `an out-of-range day of week still wraps`() {
        assertEquals(PlanningTodayPrompt.Due, PlanningTodayPrompt.of(view(dayOfWeek = 7), todayDow = 0))
    }

    @Test fun `an open session is in progress whatever the day`() {
        assertEquals(PlanningTodayPrompt.InProgress, PlanningTodayPrompt.of(view(status = "active"), todayDow = 5))
    }

    @Test fun `a saved session is decided`() {
        assertEquals(PlanningTodayPrompt.Decided, PlanningTodayPrompt.of(view(status = "completed"), todayDow = 5))
    }
}
