package app.waffled.core.model

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The contract two parallel agents build against — Goals produces it, the data views
 * consume it. Worth locking, because a disagreement here only shows up at merge.
 */
class GoalSeriesTest {

    private fun day(d: Int) = LocalDate.of(2026, 8, d)

    private val series = GoalSeries(
        points = listOf(
            GoalPoint(day(1), 10.0, personId = "alice"),
            GoalPoint(day(1), 5.0, personId = "bob"),
            GoalPoint(day(3), 7.0, personId = "alice"),
        ),
        target = 100,
        unit = "pages",
    )

    @Test
    fun totalSumsEveryPointIncludingSeveralOnOneDay() {
        assertEquals(22.0, series.total, 0.0001)
    }

    @Test
    fun byDayCollapsesMultiplePeopleOntoTheSameDay() {
        assertEquals(15.0, series.byDay[day(1)]!!, 0.0001)
        assertEquals(7.0, series.byDay[day(3)]!!, 0.0001)
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
        assertEquals(99, GoalSeries(listOf(GoalPoint(day(1), 999.0)), target = 1000).percent)
    }

    @Test
    fun anEmptySeriesIsSafeToDraw() {
        val empty = GoalSeries()
        assertEquals(0.0, empty.total, 0.0001)
        assertEquals(0, empty.percent)
        assertEquals(emptyMap(), empty.byDay)
    }

    // -----------------------------------------------------------------------
    // Fractional amounts. The server stores goal_logs.amount as a numeric and an hours
    // goal logs 1h5m as 1.0833… — see apps/api/src/modules/goals/goals.service.ts:33.
    // -----------------------------------------------------------------------

    @Test
    fun aTwentyMinuteLogOnAnHoursGoalIsNotZero() {
        // The headline bug: rounding 0.3333 to an Int turned a logged day into a present
        // day valued ZERO — "I logged 20 minutes" rendering as "nothing logged".
        val hours = GoalSeries(
            points = listOf(GoalPoint(day(1), 20.0 / 60.0)),
            target = 10,
            unit = "hours",
        )
        assertTrue(hours.total > 0.0, "a 20-minute log must survive as a non-zero total")
        assertEquals(0.3333, hours.total, 0.0001)
        assertEquals(0.3333, hours.byDay[day(1)]!!, 0.0001)
    }

    @Test
    fun twoFractionalPointsOnOneDaySumWithoutRounding() {
        // 1h5m + 20m = 1.4166… hours. Rounding each point first gave 1 + 0 = 1, so the
        // day drifted from the goal's own total by nearly half a unit.
        val s = GoalSeries(
            points = listOf(
                GoalPoint(day(1), 1.0833333333333333, personId = "alice"),
                GoalPoint(day(1), 20.0 / 60.0, personId = "bob"),
            ),
            unit = "hours",
        )
        assertEquals(1.4166, s.byDay[day(1)]!!, 0.0001)
        assertEquals(s.total, s.byDay[day(1)]!!, 0.0001)
    }

    @Test
    fun percentFloorsRatherThanRoundingUpToAPrematureHundred() {
        // 99.6 of 100 is not done. Rounding the fractional total up to 100 first would
        // tell a child their jar is full when it isn't — the same rule progressPercent's
        // own truncation exists for.
        val nearly = GoalSeries(points = listOf(GoalPoint(day(1), 99.6)), target = 100)
        assertEquals(99, nearly.percent, "a fractional total just short of target is not 100%")
        assertEquals(100, GoalSeries(listOf(GoalPoint(day(1), 100.0)), target = 100).percent)
    }

    @Test
    fun todayRoundTrips() {
        // The household's today, carried on the contract so neither consumer has to fall
        // back to the DEVICE's date — the exact drift the household timezone prevents.
        assertNull(GoalSeries().today, "a series that wasn't told today says so")
        assertEquals(day(21), series.copy(today = day(21)).today)
    }
}
