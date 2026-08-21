package app.waffled.feature.meals

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Which grocery weeks a meal-plan apply has to rebuild — the port of
 * `apps/ios/Tests/GroceryWeeksTests.swift`.
 *
 * The bug this pins: "Plan my month" rebuilt with `weekStart = monthStart` — ONE call,
 * and a rebuild covers exactly one week. A month is 4-6 weeks, so every week after the
 * first was planned but never shopped for.
 *
 * The trap in the fix: the grocery list is keyed by the HOUSEHOLD's week-start
 * preference, never the device's locale. Grouping a Monday household on Sundays merges
 * two of its weeks into one key, the server snaps that key onto its own boundary, and
 * the week left over is never built.
 */
class GroceryWeeksTest {

    /**
     * August 2026 starts on a Saturday and has 31 days, so a Sunday-keyed month spans
     * SIX week-starts. One rebuild call covered one of them.
     */
    @Test
    fun `covers every week of a month`() {
        val dates = (1..31).map { "2026-08-%02d".format(it) }
        assertEquals(
            listOf("2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30"),
            GroceryWeeks.weekStarts(dates, HouseholdWeekStart.Sunday),
        )
    }

    /** A five-week span yields five rebuilds — one per week, no more. */
    @Test
    fun `yields one rebuild per week`() {
        val dates = listOf("2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29")
        assertEquals(5, GroceryWeeks.weekStarts(dates, HouseholdWeekStart.Sunday).size)
    }

    /** Two nights in the same week are one call, not two. */
    @Test
    fun `does not repeat a week`() {
        assertEquals(
            listOf("2026-08-16"),
            GroceryWeeks.weekStarts(listOf("2026-08-17", "2026-08-19", "2026-08-22"), HouseholdWeekStart.Sunday),
        )
    }

    /**
     * A Monday household groups on Mondays. 2026-08-16 is a Sunday: it CLOSES the week
     * that began Monday the 10th, and does not open a new one.
     */
    @Test
    fun `groups a monday household on mondays`() {
        assertEquals(listOf("2026-08-10"), GroceryWeeks.weekStarts(listOf("2026-08-16"), HouseholdWeekStart.Monday))
        assertEquals(listOf("2026-08-17"), GroceryWeeks.weekStarts(listOf("2026-08-17"), HouseholdWeekStart.Monday))
        // The same two dates land in ONE week for a Sunday household and TWO for a Monday
        // one — the exact disagreement that makes the preference load-bearing.
        assertEquals(
            listOf("2026-08-16"),
            GroceryWeeks.weekStarts(listOf("2026-08-16", "2026-08-17"), HouseholdWeekStart.Sunday),
        )
        assertEquals(
            listOf("2026-08-10", "2026-08-17"),
            GroceryWeeks.weekStarts(listOf("2026-08-16", "2026-08-17"), HouseholdWeekStart.Monday),
        )
    }

    /**
     * Cleared nights count too: that shopping has to come back OFF the list, which only
     * happens if its week is rebuilt.
     */
    @Test
    fun `includes cleared dates`() {
        assertEquals(
            listOf("2026-08-16", "2026-08-30"),
            GroceryWeeks.weekStarts(listOf("2026-08-18", "2026-09-03"), HouseholdWeekStart.Sunday),
        )
    }

    /** Garbage in, nothing out — an unparseable date must not become a bogus rebuild. */
    @Test
    fun `skips unparseable dates`() {
        assertEquals(
            listOf("2026-08-16"),
            GroceryWeeks.weekStarts(listOf("", "not-a-date", "2026-08-18"), HouseholdWeekStart.Sunday),
        )
        assertTrue(GroceryWeeks.weekStarts(emptyList(), HouseholdWeekStart.Sunday).isEmpty())
    }

    /**
     * "We haven't synced the household's preference yet" is a real state, and it is NOT
     * the same as Sunday. Assuming Sunday for a Monday household merges two of its real
     * weeks into one key; the server snaps that key onto its own boundary and rebuilds
     * one week, so the other never gets built at all. The window is normally one sync
     * tick — but it is unbounded whenever PowerSync is offline while REST still works,
     * and planning is REST.
     */
    @Test
    fun `covers both cuts when the household preference is unknown`() {
        // Sun + Mon land in ONE Sunday week but TWO Monday weeks. Not knowing which, both.
        assertEquals(
            listOf("2026-08-31", "2026-09-06", "2026-09-07"),
            GroceryWeeks.weekStarts(listOf("2026-09-06", "2026-09-07"), null),
        )
        // A midweek date: the two conventions disagree, so both keys are covered.
        assertEquals(listOf("2026-09-06", "2026-09-07"), GroceryWeeks.weekStarts(listOf("2026-09-09"), null))
        // And a known preference still produces exactly one key per week — no extra calls
        // once we actually know the answer.
        assertEquals(listOf("2026-09-07"), GroceryWeeks.weekStarts(listOf("2026-09-09"), HouseholdWeekStart.Monday))
    }

    /**
     * Stepping the grocery week has to move from the week the SERVER last returned, not
     * from a week computed on the device.
     */
    @Test
    fun `steps a week from the server's own answer`() {
        assertEquals("2026-08-24", GroceryWeeks.step("2026-08-17", 1))
        assertEquals("2026-08-10", GroceryWeeks.step("2026-08-17", -1))
        // Across a month boundary, and a year one.
        assertEquals("2026-10-05", GroceryWeeks.step("2026-09-28", 1))
        assertEquals("2026-12-28", GroceryWeeks.step("2027-01-04", -1))
        // Whatever the server said is carried forward verbatim — a Monday key steps to a
        // Monday key, a Sunday key to a Sunday key. The helper never re-decides the cut.
        assertEquals("2026-08-23", GroceryWeeks.step("2026-08-16", 1))
        // Nothing to step from yet (board not loaded) is not a step to nowhere.
        assertNull(GroceryWeeks.step("", 1))
        assertNull(GroceryWeeks.step("not-a-date", 1))
    }

    /** The household preference arrives as free text off the synced `households` row. */
    @Test
    fun `reads the preference leniently`() {
        assertEquals(HouseholdWeekStart.Monday, HouseholdWeekStart.parse("monday"))
        assertEquals(HouseholdWeekStart.Monday, HouseholdWeekStart.parse("Monday"))
        assertEquals(HouseholdWeekStart.Monday, HouseholdWeekStart.parse("  MONDAY  "))
        assertEquals(HouseholdWeekStart.Sunday, HouseholdWeekStart.parse("sunday"))
        // Anything else — including nothing synced yet — is the server default.
        assertEquals(HouseholdWeekStart.Sunday, HouseholdWeekStart.parse(null))
        assertEquals(HouseholdWeekStart.Sunday, HouseholdWeekStart.parse("tuesday"))
    }
}
