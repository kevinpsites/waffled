package app.waffled.feature.today

import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The picker's per-goal descriptor line. */
class GoalDescriptorTest {

    private fun goal(
        target: Double? = null,
        progress: Double = 0.0,
        unit: String? = null,
        streakDays: Int = 0,
        category: String? = null,
    ) = TodayApi.Goal(
        id = "g", title = "t", unit = unit, target = target,
        totalProgress = progress, streakDays = streakDays, category = category,
    )

    @Test
    fun aTargetGoalReadsAsProgressOfTarget() {
        assertEquals("4 of 10 books", goalDescriptor(goal(target = 10.0, progress = 4.0, unit = "books")))
    }

    /** A whole number must not read as a decimal — "4", never "4.0". */
    @Test
    fun wholeNumbersLoseTheirDecimal() {
        assertEquals("4 of 10", goalDescriptor(goal(target = 10.0, progress = 4.0)))
        assertEquals("4.5 of 10", goalDescriptor(goal(target = 10.0, progress = 4.5)))
    }

    /** A target-less goal has no computable percentage, so it falls back to the streak. */
    @Test
    fun aTargetLessGoalFallsBackToItsStreak() {
        assertEquals("12-day streak", goalDescriptor(goal(streakDays = 12)))
    }

    @Test
    fun withNeitherItShowsTheCategory() {
        assertEquals("Fitness", goalDescriptor(goal(category = "fitness")))
        assertEquals("No target set", goalDescriptor(goal()))
    }

    /** A zero target is not a target — dividing by it would be a crash or a bogus 100%. */
    @Test
    fun aZeroTargetIsNotATarget() {
        assertEquals("No target set", goalDescriptor(goal(target = 0.0)))
        assertEquals(0.0, goal(target = 0.0, progress = 5.0).fraction)
    }

    @Test
    fun theFractionIsClampedToOne() {
        assertEquals(1.0, goal(target = 10.0, progress = 25.0).fraction)
        assertEquals(0.5, goal(target = 10.0, progress = 5.0).fraction)
    }
}

/**
 * The day-rollover timer. At household-tz midnight "today" changes, so the dinner and
 * chores on screen are suddenly yesterday's.
 */
class DayRolloverTest {

    private val zone: ZoneId = ZoneId.of("America/Chicago")

    @Test
    fun itWaitsUntilJustPastTheNextMidnight() {
        val at = LocalDateTime.of(2026, 7, 16, 23, 0).atZone(zone)
        // One hour, plus the one-second cushion past the boundary.
        assertEquals(60 * 60 * 1000L + 1_000L, millisUntilNextDay(at))
    }

    /** Landing exactly on midnight must schedule a whole day, not fire in a tight loop. */
    @Test
    fun midnightItselfSchedulesAFullDay() {
        val at = LocalDateTime.of(2026, 7, 16, 0, 0).atZone(zone)
        assertEquals(24 * 60 * 60 * 1000L + 1_000L, millisUntilNextDay(at))
    }

    /** A DST "spring forward" day is 23 hours — the wait must still be positive and sane. */
    @Test
    fun aDstDayStillSchedulesForward() {
        val at = LocalDateTime.of(2026, 3, 8, 1, 0).atZone(zone)
        val wait = millisUntilNextDay(at)
        assertTrue(wait > 0, "expected a positive wait, got $wait")
        assertTrue(wait <= 24 * 60 * 60 * 1000L + 1_000L, "expected at most a day, got $wait")
    }
}
