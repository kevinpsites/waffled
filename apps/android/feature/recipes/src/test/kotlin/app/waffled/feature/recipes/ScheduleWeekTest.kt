package app.waffled.feature.recipes

import app.waffled.core.model.HouseholdWeekStart
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * "This week" in the schedule sheet must name the same seven days the planner shows, so
 * it cuts on the household's first day (the iOS `RecipeScheduleSheet.weekStart`).
 */
class ScheduleWeekTest {

    private val sunday = LocalDate.parse("2026-08-23")

    @Test
    fun aMondayHouseholdsSundayIsTheLastDayOfThisWeek() {
        assertEquals(LocalDate.parse("2026-08-17"), ScheduleWeek.start(sunday, HouseholdWeekStart.Monday, 0))
        assertEquals(LocalDate.parse("2026-08-24"), ScheduleWeek.start(sunday, HouseholdWeekStart.Monday, 1))
    }

    @Test
    fun aSundayHouseholdOrAnUnsyncedOneCutsOnSunday() {
        assertEquals(sunday, ScheduleWeek.start(sunday, HouseholdWeekStart.Sunday, 0))
        assertEquals(LocalDate.parse("2026-08-16"), ScheduleWeek.start(LocalDate.parse("2026-08-19"), null, 0))
    }
}
