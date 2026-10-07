package app.waffled.feature.goals

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/GoalStatsTests.swift`, which itself mirrors
 * `apps/web/src/lib/goalStats.test.ts` — same fixtures, same expectations, so the
 * derived stats stay identical on all three platforms. See [GoalStats].
 */
class GoalStatsTest {

    // ---- local-date key helpers (no timestamp-drift gotcha) --------------------

    @Test
    fun roundTripsDateKey() {
        assertEquals("2026-07-17", GoalDateKey.toKey(java.time.LocalDate.of(2026, 7, 17)))
        val back = GoalDateKey.parse("2026-07-17")
        assertEquals(2026, back.year)
        assertEquals(7, back.monthValue)
        assertEquals(17, back.dayOfMonth)
    }

    @Test
    fun addDaysRollsOverMonthAndYearBoundaries() {
        assertEquals("2026-02-01", GoalDateKey.addDays("2026-01-31", 1))
        assertEquals("2027-01-01", GoalDateKey.addDays("2026-12-31", 1))
        assertEquals("2026-02-28", GoalDateKey.addDays("2026-03-01", -1)) // 2026 not a leap year
        assertEquals("2024-02-29", GoalDateKey.addDays("2024-03-01", -1)) // 2024 IS a leap year
    }

    @Test
    fun addDaysCrossesSpringForwardDstBoundary() {
        // US DST 2026 spring-forward is Mar 8. Adding 1 calendar day must land on Mar 9.
        // Calendar-field arithmetic gets this right; epoch-second arithmetic would not.
        assertEquals("2026-03-09", GoalDateKey.addDays("2026-03-08", 1))
    }

    @Test
    fun diffDaysCountsWholeDaysBetweenKeys() {
        assertEquals(9, GoalDateKey.diffDays("2026-01-10", "2026-01-01"))
        assertEquals(-9, GoalDateKey.diffDays("2026-01-01", "2026-01-10"))
        assertEquals(0, GoalDateKey.diffDays("2026-01-01", "2026-01-01"))
    }

    @Test
    fun aMalformedDayKeyDegradesInsteadOfThrowing() {
        // Keys can come straight off the wire (an entry's dateKey); a short or unparseable
        // one must degrade to something rather than crash. Reaching the end IS the assertion.
        GoalDateKey.parse("")
        GoalDateKey.parse("2026")
        GoalDateKey.parse("2026-09")
        GoalDateKey.parse("not-a-date")
        // ...and a well-formed key still round-trips untouched.
        assertEquals("2026-09-30", GoalDateKey.toKey(GoalDateKey.parse("2026-09-30")))
    }

    @Test
    fun startOfWeekCutsOnTheHouseholdsFirstDay() {
        val sun = app.waffled.core.model.HouseholdWeekStart.Sunday
        val mon = app.waffled.core.model.HouseholdWeekStart.Monday
        // 2026-07-17 is a Friday; its week starts Sunday 2026-07-12, or Monday 2026-07-13.
        assertEquals("2026-07-12", GoalDateKey.startOfWeek("2026-07-17", sun))
        assertEquals("2026-07-13", GoalDateKey.startOfWeek("2026-07-17", mon))
        // A Sunday is its own week start — or the LAST day of a Monday week.
        assertEquals("2026-07-12", GoalDateKey.startOfWeek("2026-07-12", sun))
        assertEquals("2026-07-06", GoalDateKey.startOfWeek("2026-07-12", mon))
    }

    // ---- heat ramp -------------------------------------------------------------

    @Test
    fun heatRampEndsAndClamps() {
        assertEquals(Triple(233, 245, 236), GoalStats.heat(0.0))
        assertEquals(Triple(18, 99, 61), GoalStats.heat(1.0))
        assertEquals(GoalStats.heat(0.0), GoalStats.heat(-5.0))
        assertEquals(GoalStats.heat(1.0), GoalStats.heat(5.0))
    }

    // ---- timeframe classification ---------------------------------------------

    @Test
    fun classifyTimeframe() {
        assertEquals(GoalTimeframe.OpenEnded, GoalStats.classifyTimeframe("2026-01-01", null))
        assertEquals(GoalTimeframe.Short, GoalStats.classifyTimeframe("2026-07-01", "2026-07-14"))
        assertEquals(GoalTimeframe.Long, GoalStats.classifyTimeframe("2026-01-01", "2026-12-31"))
        assertEquals(GoalTimeframe.Long, GoalStats.classifyTimeframe("2026-01-01", "2028-01-01"))
    }

    // ---- goal-type -> view mapping ---------------------------------------------

    @Test
    fun totalGoalViewMapping() {
        assertEquals(GoalViewKey.Month, GoalStats.defaultView("total", GoalTimeframe.Long))
        assertEquals(
            listOf(
                GoalViewKey.Week, GoalViewKey.Month, GoalViewKey.Year,
                GoalViewKey.Pace, GoalViewKey.YearRing, GoalViewKey.ByPerson,
            ),
            GoalStats.availableViews("total", GoalTimeframe.Long),
        )
        assertEquals(
            listOf(GoalViewKey.Week, GoalViewKey.Pace, GoalViewKey.ByPerson),
            GoalStats.availableViews("total", GoalTimeframe.Short),
        )
        // Signature (month) doesn't fit a short window -> falls back to Week.
        assertEquals(GoalViewKey.Week, GoalStats.defaultView("total", GoalTimeframe.Short))
    }

    @Test
    fun countGoalViewMapping() {
        assertEquals(GoalViewKey.Collection, GoalStats.defaultView("count", GoalTimeframe.Long))
        assertEquals(
            listOf(GoalViewKey.Month, GoalViewKey.Pace, GoalViewKey.Collection),
            GoalStats.availableViews("count", GoalTimeframe.Long),
        )
        assertEquals(
            listOf(GoalViewKey.Pace, GoalViewKey.Collection),
            GoalStats.availableViews("count", GoalTimeframe.Short),
        )
    }

    @Test
    fun habitGoalViewMapping() {
        assertEquals(GoalViewKey.Consistency, GoalStats.defaultView("habit", GoalTimeframe.Long))
        assertEquals(
            listOf(GoalViewKey.Consistency, GoalViewKey.Week),
            GoalStats.availableViews("habit", GoalTimeframe.Long),
        )
        assertEquals(listOf(GoalViewKey.Week), GoalStats.availableViews("habit", GoalTimeframe.Short))
        assertEquals(GoalViewKey.Week, GoalStats.defaultView("habit", GoalTimeframe.Short))
    }

    @Test
    fun checklistGoalHasNoSwitcher() {
        assertEquals(emptyList(), GoalStats.availableViews("checklist", GoalTimeframe.Long))
        assertNull(GoalStats.defaultView("checklist", GoalTimeframe.Long))
    }

    // ---- compute ---------------------------------------------------------------

    private val days = listOf(
        DayEntry("2026-07-10", 8.3, mapOf("wally" to 4.0, "kevin" to 4.3)),
        DayEntry("2026-07-11", 5.9, mapOf("wally" to 5.9)),
        DayEntry("2026-07-15", 1.5, mapOf("wally" to 1.5)),
        DayEntry("2026-07-16", 3.9, mapOf("kelly" to 2.0, "wally" to 1.9)),
        DayEntry("2026-07-17", 2.5, mapOf("wally" to 2.5)),
    )

    private fun stats(
        today: String = "2026-07-17",
        startDate: String = "2026-01-01",
        endDate: String? = null,
        target: Double? = 1000.0,
        entries: List<DayEntry> = days,
    ) = GoalStats.compute(today, startDate, endDate, target, entries)

    @Test
    fun sumsTotalAndTracksBestDay() {
        val s = stats()
        assertTrue(kotlin.math.abs(s.total - (8.3 + 5.9 + 1.5 + 3.9 + 2.5)) < 0.001)
        assertEquals("2026-07-10", s.bestDay?.dateKey)
        assertEquals(8.3, s.bestDay?.total)
    }

    @Test
    fun dayEntryZeroFillsQuietly() {
        val s = stats()
        assertNull(s.byDay["2026-07-12"])
        val filled = s.dayEntry("2026-07-12")
        assertEquals(0.0, filled.total)
        assertTrue(filled.perMember.isEmpty())
        assertEquals(8.3, s.dayEntry("2026-07-10").total)
    }

    @Test
    fun currentStreakCountsConsecutiveActiveDaysEndingToday() {
        assertEquals(3, stats().currentStreak) // Jul 15-16-17
    }

    @Test
    fun currentStreakIsZeroWhenStale() {
        val stale = listOf(DayEntry("2026-07-10", 3.0, emptyMap()))
        assertEquals(0, stats(entries = stale).currentStreak)
    }

    @Test
    fun currentStreakStillCountsWhenTheLatestDayIsYesterday() {
        // The server's rule: today OR yesterday keeps the streak alive.
        val entries = listOf(
            DayEntry("2026-07-15", 1.0, emptyMap()),
            DayEntry("2026-07-16", 1.0, emptyMap()),
        )
        assertEquals(2, stats(entries = entries).currentStreak)
    }

    @Test
    fun longestStreakFindsTheLongestRun() {
        assertEquals(3, stats().longestStreak)
    }

    @Test
    fun activeDaysCountsOnlyDaysWithATotal() {
        val entries = days + DayEntry("2026-07-13", 0.0, mapOf("wally" to 0.0))
        assertEquals(5, stats(entries = entries).activeDays)
    }

    @Test
    fun weekMaxIsMaxOfLast7DaysEndingToday() {
        assertEquals(5.9, stats().weekMax) // Jul 11..17, excludes Jul 10
    }

    @Test
    fun monthAndYearMaxBucketByTheCalendarPeriodContainingToday() {
        val entries = days + DayEntry("2026-06-30", 99.0, emptyMap())
        val s = stats(entries = entries)
        assertEquals(8.3, s.monthMax) // June's 99 is a different month
        assertEquals(99.0, s.yearMax) // …but the same year
    }

    @Test
    fun paceIsNullForOpenEndedGoal() {
        assertNull(stats().pace)
    }

    @Test
    fun paceIsNullWithoutATarget() {
        assertNull(stats(endDate = "2026-12-31", target = null).pace)
    }

    @Test
    fun paceDerivesFromTheGoalsOwnWindow() {
        val shortDays = listOf(DayEntry("2026-07-03", 60.0, emptyMap()))
        val s = GoalStats.compute("2026-07-06", "2026-07-01", "2026-07-11", 100.0, shortDays)
        assertEquals(50.0, s.pace?.paceValue) // 100 * 5/10
        assertEquals(10.0, s.pace?.delta) // 60 - 50
    }

    @Test
    fun paceClampsElapsedOncePastTheEndDate() {
        val s = GoalStats.compute("2026-08-01", "2026-07-01", "2026-07-11", 100.0, emptyList())
        assertEquals(100.0, s.pace?.paceValue)
    }

    @Test
    fun byMonthPerMemberBucketsPerCalendarMonth() {
        val s = stats()
        val july = s.byMonthPerMember[6]
        assertTrue(kotlin.math.abs((july["wally"] ?: 0.0) - (4 + 5.9 + 1.5 + 1.9 + 2.5)) < 0.001)
        assertEquals(4.3, july["kevin"])
        assertEquals(2.0, july["kelly"])
        assertTrue(s.byMonthPerMember[0].isEmpty())
        assertEquals(0.0, s.byMonth[0])
    }

    // ---- projected finish (extends the trailing-14-day rate) --------------------

    @Test
    fun projectedFinishIsTodayOnceTheTargetIsMet() {
        assertEquals("2026-07-17", stats(target = 5.0).projectedFinish)
    }

    @Test
    fun projectedFinishExtendsTheRecentRate() {
        // The 14-day window starts 2026-07-04, so every fixture day is inside it: 22.1
        // over 14 days -> ~1.5786/day. Remaining 100 - 22.1 = 77.9 -> ceil(49.35) = 50 days.
        val s = stats(target = 100.0)
        assertNotNull(s.projectedFinish)
        assertEquals(GoalDateKey.addDays("2026-07-17", 50), s.projectedFinish)
    }

    @Test
    fun projectedFinishIsNullWhenNothingRecentToExtrapolateFrom() {
        val stale = listOf(DayEntry("2026-01-05", 3.0, emptyMap()))
        assertNull(stats(entries = stale).projectedFinish)
    }

    @Test
    fun projectedFinishIsNullWithoutATarget() {
        assertNull(stats(target = null).projectedFinish)
    }

    @Test
    fun anEmptyLogIsSafeToCompute() {
        val s = stats(entries = emptyList())
        assertEquals(0.0, s.total)
        assertEquals(0, s.currentStreak)
        assertEquals(0, s.longestStreak)
        assertEquals(0, s.activeDays)
        assertNull(s.bestDay)
        assertEquals(0.0, s.weekMax)
    }
}
