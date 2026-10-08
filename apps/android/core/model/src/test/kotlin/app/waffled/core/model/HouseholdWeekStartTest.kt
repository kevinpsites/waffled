package app.waffled.core.model

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Twin of the household overloads in `PlannerWeekStartTests.swift` / `GroceryWeeksTests.swift`. */
class HouseholdWeekStartTest {

    @Test fun parseIsLenientAndDefaultsToSunday() {
        assertEquals(HouseholdWeekStart.Monday, HouseholdWeekStart.parse(" Monday "))
        assertEquals(HouseholdWeekStart.Sunday, HouseholdWeekStart.parse("sunday"))
        assertEquals(HouseholdWeekStart.Sunday, HouseholdWeekStart.parse("tuesday"))
        assertEquals(HouseholdWeekStart.Sunday, HouseholdWeekStart.parse(null))
    }

    @Test fun ofReturnsNullUntilAHouseholdRowArrives() {
        assertNull(HouseholdWeekStart.of(null))
        assertEquals(HouseholdWeekStart.Monday, HouseholdWeekStart.of(Household(id = "h", name = "H", weekStart = "monday")))
    }

    @Test fun weekStartCutsOnTheHouseholdDayNotTheDevice() {
        val sunday = LocalDate.parse("2026-08-16")
        val monday = LocalDate.parse("2026-08-17")
        assertEquals(LocalDate.parse("2026-08-10"), HouseholdWeekStart.Monday.weekStart(sunday))
        assertEquals(monday, HouseholdWeekStart.Monday.weekStart(monday))
        assertEquals(sunday, HouseholdWeekStart.Sunday.weekStart(sunday))
        assertEquals(sunday, HouseholdWeekStart.Sunday.weekStart(LocalDate.parse("2026-08-22")))
    }

    @Test fun rotatedReordersAnySevenLabelRow() {
        val one = listOf("S", "M", "T", "W", "T", "F", "S")
        assertEquals(listOf("M", "T", "W", "T", "F", "S", "S"), HouseholdWeekStart.Monday.rotated(one))
        assertEquals(one, HouseholdWeekStart.Sunday.rotated(one))
        assertEquals(listOf("a"), HouseholdWeekStart.Monday.rotated(listOf("a")))
    }

    @Test fun monthLeadCellsCountsBlanksBeforeTheFirst() {
        val sept = LocalDate.parse("2026-09-01") // a Tuesday
        assertEquals(1, HouseholdWeekStart.Monday.monthLeadCells(sept))
        assertEquals(2, HouseholdWeekStart.Sunday.monthLeadCells(sept))
    }
}
