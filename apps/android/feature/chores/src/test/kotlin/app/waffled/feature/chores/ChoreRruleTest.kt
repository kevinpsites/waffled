package app.waffled.feature.chores

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The editor's repeat-rule round trip — the twin of iOS `ChoreEditSheet.parseRrule` /
 * `buildRrule`.
 *
 * The rule that matters most: **a blank or absent rrule is a one-off, not a daily
 * chore.** Get that wrong and editing a one-off silently converts it into a recurring
 * daily chore on save.
 */
class ChoreRruleTest {

    @Test
    fun `a missing or blank rule parses as once`() {
        assertEquals(ChoreRepeat.Once, ChoreRrule.parse(null).frequency)
        assertEquals(ChoreRepeat.Once, ChoreRrule.parse("").frequency)
        assertEquals(ChoreRepeat.Once, ChoreRrule.parse("   ").frequency)
    }

    @Test
    fun `anything that is not weekly parses as daily`() {
        assertEquals(ChoreRepeat.Daily, ChoreRrule.parse("FREQ=DAILY").frequency)
        assertEquals(ChoreRepeat.Daily, ChoreRrule.parse("freq=daily").frequency)
    }

    @Test
    fun `weekly parses its BYDAY list`() {
        val parsed = ChoreRrule.parse("FREQ=WEEKLY;BYDAY=MO,WE,FR")
        assertEquals(ChoreRepeat.Weekly, parsed.frequency)
        assertEquals(listOf("MO", "WE", "FR"), parsed.days)
    }

    @Test
    fun `weekly parsing is case-insensitive and tolerates no BYDAY`() {
        assertEquals(listOf("TU", "TH"), ChoreRrule.parse("freq=weekly;byday=tu,th").days)
        assertEquals(emptyList(), ChoreRrule.parse("FREQ=WEEKLY").days)
    }

    @Test
    fun `weekly parsing stops at the next rule part`() {
        val parsed = ChoreRrule.parse("FREQ=WEEKLY;BYDAY=SA,SU;INTERVAL=2")
        assertEquals(listOf("SA", "SU"), parsed.days)
    }

    @Test
    fun `building a one-off sends no rule at all`() {
        assertNull(ChoreRrule.build(ChoreRepeat.Once, setOf("MO")))
    }

    @Test
    fun `building daily sends FREQ DAILY`() {
        assertEquals("FREQ=DAILY", ChoreRrule.build(ChoreRepeat.Daily, emptySet()))
    }

    @Test
    fun `building weekly orders the days Monday-first regardless of pick order`() {
        assertEquals(
            "FREQ=WEEKLY;BYDAY=MO,WE,SU",
            ChoreRrule.build(ChoreRepeat.Weekly, setOf("SU", "WE", "MO")),
        )
    }

    @Test
    fun `building weekly with no days chosen degrades to a one-off`() {
        // `canSave` already blocks this in the UI; the builder must not emit a
        // BYDAY-less weekly rule that would repeat on an arbitrary day.
        assertNull(ChoreRrule.build(ChoreRepeat.Weekly, emptySet()))
    }
}
