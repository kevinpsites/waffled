package app.waffled.feature.lists

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Stepping the grocery week — the port of the `step` cases in
 * `apps/ios/Tests/GroceryWeeksTests.swift`.
 *
 * The value stepped from is always the SERVER's own answer for the week on screen. A
 * client that computes its own week start snaps to the DEVICE region's first-day-of-week
 * while the server snaps to the HOUSEHOLD's, and the two routinely disagree.
 */
class GroceryWeekStepTest {

    @Test
    fun `steps a week from the server's own answer`() {
        assertEquals("2026-08-24", GroceryWeekStep.step("2026-08-17", 1))
        assertEquals("2026-08-10", GroceryWeekStep.step("2026-08-17", -1))
    }

    @Test
    fun `crosses month and year boundaries`() {
        assertEquals("2026-10-05", GroceryWeekStep.step("2026-09-28", 1))
        assertEquals("2026-12-28", GroceryWeekStep.step("2027-01-04", -1))
    }

    /**
     * Whatever cut the server said is carried forward verbatim — a Monday key steps to a
     * Monday, and this never re-snaps it onto the device's idea of a week.
     */
    @Test
    fun `carries the server's cut forward untouched`() {
        assertEquals("2026-08-23", GroceryWeekStep.step("2026-08-16", 1))
        assertEquals("2026-08-24", GroceryWeekStep.step("2026-08-17", 1))
    }

    /** Nothing to step from yet (board not loaded) is not a step to nowhere. */
    @Test
    fun `an unloaded or unparseable week yields null`() {
        assertNull(GroceryWeekStep.step("", 1))
        assertNull(GroceryWeekStep.step("not-a-date", 1))
        assertNull(GroceryWeekStep.step("2026-13-01", 1))
    }

    @Test
    fun `stepping zero weeks returns the same week`() {
        assertEquals("2026-08-17", GroceryWeekStep.step("2026-08-17", 0))
    }
}
