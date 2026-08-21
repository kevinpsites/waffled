package app.waffled.feature.goalcharts

import app.waffled.core.model.GoalCadence
import app.waffled.core.model.GoalPoint
import app.waffled.core.model.GoalSeries
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Which of the eight views a given goal is offered, and which one opens by default.
 *
 * iOS drives this off `goal.goalType` ("total" / "count" / "habit" / "checklist"), a
 * field `GoalSeries` does not carry — see the module's reported contract gap. These
 * derive the same answers from what `GoalSeries` DOES carry (cadence, target, people,
 * range), and accept an optional `goalType` that narrows the set when the caller knows it.
 */
class GoalViewChoiceTest {

    private val today = LocalDate.of(2026, 8, 21)

    private fun series(
        target: Int? = null,
        cadence: GoalCadence = GoalCadence.Daily,
        start: LocalDate? = LocalDate.of(2026, 1, 1),
        end: LocalDate? = null,
        colors: Map<String, String> = emptyMap(),
        points: List<GoalPoint> = emptyList(),
    ) = GoalSeries(
        points = points,
        target = target,
        cadence = cadence,
        rangeStart = start,
        rangeEnd = end,
        personColors = colors,
    )

    // ---------------------------------------------------------------- timeframe

    @Test
    fun `a goal with no end date is open-ended`() {
        assertEquals(GoalTimeframe.OpenEnded, classifyTimeframe(LocalDate.of(2026, 1, 1), null))
        assertEquals(GoalTimeframe.OpenEnded, classifyTimeframe(null, LocalDate.of(2026, 1, 1)))
    }

    @Test
    fun `the short window is thirty-one days, exclusive`() {
        val start = LocalDate.of(2026, 1, 1)
        assertEquals(GoalTimeframe.Short, classifyTimeframe(start, start.plusDays(30)))
        assertEquals(GoalTimeframe.Long, classifyTimeframe(start, start.plusDays(31)))
    }

    // ---------------------------------------------------------------- offered set

    @Test
    fun `pace and collection need a target`() {
        val untargeted = offeredViews(series(cadence = GoalCadence.Total), today)
        assertTrue(GoalViewKey.Pace !in untargeted)
        assertTrue(GoalViewKey.Collection !in untargeted)

        val targeted = offeredViews(series(target = 20, cadence = GoalCadence.Total), today)
        assertTrue(GoalViewKey.Pace in targeted)
        assertTrue(GoalViewKey.Collection in targeted)
    }

    @Test
    fun `a collection shelf only makes sense for a whole-goal target`() {
        val daily = offeredViews(series(target = 20, cadence = GoalCadence.Daily), today)
        assertTrue(GoalViewKey.Collection !in daily)
    }

    @Test
    fun `by-person needs someone to break down by`() {
        assertTrue(GoalViewKey.ByPerson !in offeredViews(series(), today))
        assertTrue(GoalViewKey.ByPerson in offeredViews(series(colors = mapOf("abe" to "#EC6049")), today))
        // A person can show up in the points even when no colour was sent.
        val withPoints = series(points = listOf(GoalPoint(today, 1.0, "abe")))
        assertTrue(GoalViewKey.ByPerson in offeredViews(withPoints, today))
    }

    @Test
    fun `the week and consistency views are for daily goals`() {
        val daily = offeredViews(series(), today)
        assertTrue(GoalViewKey.Week in daily)
        assertTrue(GoalViewKey.Consistency in daily)

        val monthly = offeredViews(series(cadence = GoalCadence.Monthly), today)
        assertTrue(GoalViewKey.Week !in monthly)
        assertTrue(GoalViewKey.Consistency !in monthly)
    }

    @Test
    fun `a short goal drops the year, month, ring and consistency views`() {
        val short = offeredViews(
            series(start = LocalDate.of(2026, 8, 1), end = LocalDate.of(2026, 8, 14)),
            today,
        )
        assertEquals(listOf(GoalViewKey.Week), short)
    }

    @Test
    fun `views come back in a stable canonical order`() {
        val offered = offeredViews(
            series(target = 40, cadence = GoalCadence.Total, colors = mapOf("abe" to "#EC6049")),
            today,
        )
        assertEquals(offered, offered.sortedBy { it.ordinal })
    }

    @Test
    fun `an explicit goalType narrows the derived set the way iOS does`() {
        val s = series(target = 40, cadence = GoalCadence.Daily, colors = mapOf("abe" to "#EC6049"))
        // Derived: Week, Month, Pace, Year, ByPerson, YearRing, Consistency.
        assertEquals(
            listOf(GoalViewKey.Week, GoalViewKey.Consistency),
            offeredViews(s, today, goalType = "habit"),
        )
        assertEquals(emptyList(), offeredViews(s, today, goalType = "checklist"))
        // An unknown archetype must not silently blank the switcher.
        assertEquals(offeredViews(s, today), offeredViews(s, today, goalType = "spaceship"))
    }

    // ---------------------------------------------------------------- default view

    @Test
    fun `a whole-goal target opens on its collection shelf`() {
        assertEquals(
            GoalViewKey.Collection,
            defaultView(series(target = 30, cadence = GoalCadence.Total), today),
        )
    }

    @Test
    fun `a daily goal without a target opens on consistency`() {
        assertEquals(GoalViewKey.Consistency, defaultView(series(), today))
    }

    @Test
    fun `a monthly goal opens on the month rhythm, never on a pace projection`() {
        assertEquals(
            GoalViewKey.Month,
            defaultView(series(target = 5, cadence = GoalCadence.Monthly), today),
        )
    }

    @Test
    fun `a short goal falls back to the week strip`() {
        assertEquals(
            GoalViewKey.Week,
            defaultView(series(start = LocalDate.of(2026, 8, 1), end = LocalDate.of(2026, 8, 14)), today),
        )
    }

    @Test
    fun `a goal with nothing to offer has no default`() {
        assertNull(defaultView(series(), today, goalType = "checklist"))
    }
}
