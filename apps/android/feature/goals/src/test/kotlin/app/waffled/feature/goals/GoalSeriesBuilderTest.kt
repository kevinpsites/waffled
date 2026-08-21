package app.waffled.feature.goals

import app.waffled.core.model.GoalCadence
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The seam Goals PRODUCES and `feature:goalcharts` CONSUMES.
 *
 * A disagreement here only shows up at merge, so the rules are pinned hard: absent days
 * stay absent, a day's people each keep their own point, and an uncredited remainder is
 * never silently dropped.
 */
class GoalSeriesBuilderTest {

    private fun day(d: Int) = LocalDate.of(2026, 7, d)

    private fun build(
        goalType: String = "total",
        unit: String? = "hours",
        target: Double? = 100.0,
        habitPeriod: String? = null,
        habitTargetPerPeriod: Int? = null,
        startDate: String = "2026-07-01",
        endDate: String? = null,
        today: String = "2026-07-17",
        days: List<DayEntry> = emptyList(),
        personColors: Map<String, String> = emptyMap(),
    ) = GoalSeriesBuilder.build(
        goalType = goalType,
        unit = unit,
        target = target,
        habitPeriod = habitPeriod,
        habitTargetPerPeriod = habitTargetPerPeriod,
        startDate = startDate,
        endDate = endDate,
        today = today,
        days = days,
        personColors = personColors,
    )

    // ---- the absence rule (the whole reason the contract exists) ----------------

    @Test
    fun aDayWithNoEntryIsAbsentRatherThanZeroFilled() {
        val s = build(
            days = listOf(
                DayEntry("2026-07-10", 3.0, mapOf("alice" to 3.0)),
                DayEntry("2026-07-12", 2.0, mapOf("alice" to 2.0)),
            ),
        )
        assertEquals(3, s.byDay[day(10)])
        assertEquals(2, s.byDay[day(12)])
        assertNull(s.byDay[day(11)], "a day nobody logged must not appear at all")
        assertEquals(2, s.points.size)
    }

    @Test
    fun aDayLoggedAtZeroSTAYSPresentAsAZero() {
        // "Logged nothing" and "not tracked" render differently on a heatmap; a habit
        // explicitly marked as missed is the former.
        val s = build(days = listOf(DayEntry("2026-07-10", 0.0, emptyMap())))
        assertEquals(0, s.byDay[day(10)])
        assertEquals(1, s.points.size)
    }

    @Test
    fun pointsAreAscendingByDay() {
        val s = build(
            days = listOf(
                DayEntry("2026-07-12", 1.0, emptyMap()),
                DayEntry("2026-07-03", 1.0, emptyMap()),
                DayEntry("2026-07-09", 1.0, emptyMap()),
            ),
        )
        assertEquals(listOf(day(3), day(9), day(12)), s.points.map { it.day })
    }

    // ---- per-person breakdown --------------------------------------------------

    @Test
    fun eachPersonOnADayKeepsTheirOwnPointAndByDayCollapsesThem() {
        val s = build(
            days = listOf(DayEntry("2026-07-10", 9.0, mapOf("alice" to 5.0, "bob" to 4.0))),
        )
        assertEquals(2, s.points.size)
        assertEquals(setOf("alice", "bob"), s.points.mapNotNull { it.personId }.toSet())
        assertEquals(9, s.byDay[day(10)])
        assertEquals(9, s.total)
    }

    @Test
    fun anAttendeeCreditedZeroSurvivesAsAZeroPoint() {
        // `perMember` may hold a key at 0 — a count_once shared event's attendee is
        // present but not credited. Key on PRESENCE, never on amount > 0, or the
        // by-person view loses everyone who merely came along.
        val s = build(
            goalType = "count",
            days = listOf(DayEntry("2026-07-10", 1.0, mapOf("alice" to 1.0, "bob" to 0.0))),
        )
        val bob = s.points.single { it.personId == "bob" }
        assertEquals(0, bob.value)
        assertEquals(1, s.byDay[day(10)], "an uncredited attendee must not inflate the day")
    }

    @Test
    fun anUnattributedDayBecomesOneHouseholdPoint() {
        val s = build(days = listOf(DayEntry("2026-07-10", 4.0, emptyMap())))
        val only = s.points.single()
        assertNull(only.personId, "a household total carries no person id")
        assertEquals(4, only.value)
    }

    @Test
    fun anUncreditedRemainderIsKeptAsAHouseholdPoint() {
        // A split-pool log can credit less than the day's total (the rest is the pool's).
        // Dropping the difference would make the chart disagree with the hero ring.
        val s = build(days = listOf(DayEntry("2026-07-10", 10.0, mapOf("alice" to 6.0))))
        assertEquals(10, s.byDay[day(10)])
        assertEquals(6, s.points.single { it.personId == "alice" }.value)
        assertEquals(4, s.points.single { it.personId == null }.value)
    }

    @Test
    fun creditingMoreThanTheDayTotalDoesNotInventANegativeRemainder() {
        // each_tracks goals credit every participant fully, so the members can sum ABOVE
        // the pooled total. The per-person breakdown wins; no phantom point is added.
        val s = build(days = listOf(DayEntry("2026-07-10", 1.0, mapOf("alice" to 1.0, "bob" to 1.0))))
        assertEquals(2, s.points.size)
        assertTrue(s.points.none { it.personId == null })
    }

    // ---- cadence ---------------------------------------------------------------

    @Test
    fun cadenceFollowsAHabitsPeriod() {
        assertEquals(GoalCadence.Daily, build(goalType = "habit", habitPeriod = "day").cadence)
        assertEquals(GoalCadence.Weekly, build(goalType = "habit", habitPeriod = "week").cadence)
        assertEquals(GoalCadence.Monthly, build(goalType = "habit", habitPeriod = "month").cadence)
    }

    @Test
    fun aHabitWithNoPeriodFallsBackToWeekly() {
        // "N× a week" is the server's own default for a habit.
        assertEquals(GoalCadence.Weekly, build(goalType = "habit", habitPeriod = null).cadence)
        assertEquals(GoalCadence.Weekly, build(goalType = "habit", habitPeriod = "fortnight").cadence)
    }

    @Test
    fun everyOtherGoalTypeAccumulatesTowardOneLifetimeTotal() {
        for (t in listOf("total", "count", "checklist")) {
            assertEquals(GoalCadence.Total, build(goalType = t).cadence, "goalType=$t")
        }
    }

    // ---- target ----------------------------------------------------------------

    @Test
    fun aHabitsTargetIsItsPerPeriodCount() {
        val s = build(goalType = "habit", habitPeriod = "week", habitTargetPerPeriod = 5, target = 260.0)
        assertEquals(5, s.target, "the target is for ONE cadence period, not the lifetime roll-up")
    }

    @Test
    fun anOpenGoalHasNoTarget() {
        assertNull(build(target = null).target)
        assertNull(build(goalType = "habit", habitTargetPerPeriod = null).target)
        assertEquals(0, build(target = null, days = listOf(DayEntry("2026-07-10", 3.0))).percent)
    }

    @Test
    fun aFractionalTargetRoundsToTheNearestWholeUnit() {
        assertEquals(101, build(target = 100.5).target)
    }

    // ---- window ----------------------------------------------------------------

    @Test
    fun theWindowRunsFromTheGoalStartToItsDeadline() {
        val s = build(startDate = "2026-07-01", endDate = "2026-12-31")
        assertEquals(LocalDate.of(2026, 7, 1), s.rangeStart)
        assertEquals(LocalDate.of(2026, 12, 31), s.rangeEnd)
    }

    @Test
    fun anOpenEndedGoalsWindowEndsToday() {
        // GoalSeries has no `today` field, so an open goal's window has to end somewhere
        // a view can draw. Today is the only honest answer.
        val s = build(endDate = null, today = "2026-07-17")
        assertEquals(LocalDate.of(2026, 7, 17), s.rangeEnd)
    }

    @Test
    fun anUnparseableWindowDegradesToNullRatherThanThrowing() {
        val s = build(startDate = "", endDate = "not-a-date", today = "2026-07-17")
        assertNull(s.rangeStart)
        assertEquals(LocalDate.of(2026, 7, 17), s.rangeEnd)
    }

    // ---- labels + colours ------------------------------------------------------

    @Test
    fun theUnitIsPassedThroughAndNeverNull() {
        assertEquals("hours", build(unit = "hours").unit)
        assertEquals("", build(unit = null).unit)
        assertEquals("", build(unit = "   ").unit)
    }

    @Test
    fun personColoursArePassedThroughUntouched() {
        val s = build(personColors = mapOf("alice" to "#EC6049"))
        assertEquals(mapOf("alice" to "#EC6049"), s.personColors)
    }

    // ---- degenerate input ------------------------------------------------------

    @Test
    fun noActivityYieldsAnEmptySeriesThatIsStillSafeToDraw() {
        val s = build(days = emptyList())
        assertTrue(s.points.isEmpty())
        assertEquals(0, s.total)
        assertEquals(0, s.percent)
        assertEquals(emptyMap(), s.byDay)
    }

    @Test
    fun aDayWithAnUnparseableKeyIsSkippedRatherThanCrashingTheChart() {
        val s = build(
            days = listOf(
                DayEntry("2026-07-10", 3.0, emptyMap()),
                DayEntry("garbage", 99.0, emptyMap()),
            ),
        )
        assertEquals(1, s.points.size)
        assertEquals(3, s.total)
    }

    // ---- the Int seam ----------------------------------------------------------

    @Test
    fun aFractionalAmountRoundsToTheNearestWholeUnit() {
        // GoalPoint.value is an Int, so an hours goal's 1h5m (1.0833) has to round.
        // See the KDoc on GoalSeriesBuilder — this is a known lossy edge of the contract.
        val s = build(days = listOf(DayEntry("2026-07-10", 1.0833, mapOf("alice" to 1.0833))))
        assertEquals(1, s.byDay[day(10)])
    }

    @Test
    fun aSubHalfUnitLogStillReadsAsALoggedDay() {
        // 20 minutes on an hours goal is 0.333, which rounds to 0 — but the DAY must
        // still be present, or the chart would claim nothing was tracked.
        val s = build(days = listOf(DayEntry("2026-07-10", 0.3333, mapOf("alice" to 0.3333))))
        assertEquals(0, s.byDay[day(10)])
        assertTrue(s.points.isNotEmpty(), "presence is what tells 'did nothing' from 'not tracked'")
    }
}
