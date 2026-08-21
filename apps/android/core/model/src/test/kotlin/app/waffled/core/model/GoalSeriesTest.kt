package app.waffled.core.model

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The contract two parallel agents build against — Goals produces it, the data views
 * consume it. Worth locking, because a disagreement here only shows up at merge.
 */
class GoalSeriesTest {

    private fun day(d: Int) = LocalDate.of(2026, 8, d)

    private val series = GoalSeries(
        points = listOf(
            GoalPoint(day(1), 10, personId = "alice"),
            GoalPoint(day(1), 5, personId = "bob"),
            GoalPoint(day(3), 7, personId = "alice"),
        ),
        target = 100,
        unit = "pages",
    )

    @Test
    fun totalSumsEveryPointIncludingSeveralOnOneDay() {
        assertEquals(22, series.total)
    }

    @Test
    fun byDayCollapsesMultiplePeopleOntoTheSameDay() {
        assertEquals(15, series.byDay[day(1)])
        assertEquals(7, series.byDay[day(3)])
    }

    @Test
    fun aDayWithNoEntryIsAbsentRatherThanZero() {
        // A view must be able to tell "logged nothing" from "not tracked" — they render
        // differently on a heatmap.
        assertNull(series.byDay[day(2)])
    }

    @Test
    fun percentTruncatesAndHandlesAnOpenGoal() {
        assertEquals(22, series.percent)
        assertEquals(0, series.copy(target = null).percent, "an open goal has no percent")
        assertEquals(99, GoalSeries(listOf(GoalPoint(day(1), 999)), target = 1000).percent)
    }

    @Test
    fun anEmptySeriesIsSafeToDraw() {
        val empty = GoalSeries()
        assertEquals(0, empty.total)
        assertEquals(0, empty.percent)
        assertEquals(emptyMap(), empty.byDay)
    }
}
