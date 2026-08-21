package app.waffled.feature.goalcharts

import androidx.compose.ui.graphics.Color
import app.waffled.core.model.GoalCadence
import app.waffled.core.model.GoalPoint
import app.waffled.core.model.GoalSeries
import java.time.LocalDate
import java.time.YearMonth
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The derivations behind the eight goal visualisations.
 *
 * A `Canvas` cannot be exercised on the JVM, so every number the drawing depends on —
 * scale maxima, bucket assignment, grid alignment, streaks, pace, ring sweep angles —
 * lives in [GoalChartMath] as a pure function and is tested here. Mirrors the Swift
 * suite behind `apps/ios/.../Features/Goals/GoalStats.swift`.
 */
class GoalChartMathTest {

    private val today = LocalDate.of(2026, 8, 21) // a Friday

    private fun series(
        vararg points: GoalPoint,
        target: Int? = null,
        cadence: GoalCadence = GoalCadence.Daily,
        start: LocalDate? = LocalDate.of(2026, 1, 1),
        end: LocalDate? = null,
        colors: Map<String, String> = emptyMap(),
    ) = GoalSeries(
        points = points.toList(),
        target = target,
        cadence = cadence,
        rangeStart = start,
        rangeEnd = end,
        unit = "pages",
        personColors = colors,
    )

    private fun p(day: String, value: Int, person: String? = null) =
        GoalPoint(LocalDate.parse(day), value, person)

    // ---------------------------------------------------------------- day state

    @Test
    fun `a logged day paints heat`() {
        val stats = computeGoalChartStats(series(p("2026-08-20", 4)), today)
        assertEquals(DayPaint.Heat, stats.cell(LocalDate.of(2026, 8, 20)).paint)
    }

    /**
     * "Logged nothing" and "not tracked" are different states, and the range is what
     * separates them: a quiet day inside the goal's own window still gets a visible cell,
     * because a month with three logged days must look like a month and not like three
     * squares floating in a hole. Outside the window nothing is painted at all.
     */
    @Test
    fun `nothing-logged inside the window paints, outside it does not`() {
        val stats = computeGoalChartStats(
            series(p("2026-08-19", 0), start = LocalDate.of(2026, 8, 1)),
            today,
        )
        val inWindow = stats.cell(LocalDate.of(2026, 8, 18))
        val outOfWindow = stats.cell(LocalDate.of(2026, 7, 18))

        assertEquals(DayPaint.Empty, inWindow.paint)
        assertEquals(DayPaint.Blank, outOfWindow.paint)
        assertNotEquals(inWindow.paint, outOfWindow.paint)
    }

    /**
     * The finer half of the same distinction. Both paint the quiet cell — a 13dp square
     * has no room for more — but the day sheet says "nothing was tracked" for one and
     * "logged, but nothing counted" for the other, and reads [DayCell.hasEntry] to tell
     * them apart. If the omission stopped surfacing here it would be doing no work at all.
     */
    @Test
    fun `an explicit zero is still distinguishable from an absent day`() {
        val stats = computeGoalChartStats(
            series(p("2026-08-19", 0), start = LocalDate.of(2026, 8, 1)),
            today,
        )
        val explicitZero = stats.cell(LocalDate.of(2026, 8, 19))
        val absent = stats.cell(LocalDate.of(2026, 8, 18))

        assertEquals(explicitZero.paint, absent.paint)
        assertTrue(explicitZero.hasEntry)
        assertTrue(!absent.hasEntry)
        assertNotEquals(explicitZero.hasEntry, absent.hasEntry)
    }

    @Test
    fun `a day outside the range is blank even when it has an entry`() {
        val stats = computeGoalChartStats(
            series(p("2025-12-30", 9), start = LocalDate.of(2026, 1, 1)),
            today,
        )
        assertEquals(DayPaint.Blank, stats.cell(LocalDate.of(2025, 12, 30)).paint)
    }

    @Test
    fun `a day after today is future regardless of range`() {
        val stats = computeGoalChartStats(series(end = today.plusYears(1)), today)
        assertEquals(DayPaint.Future, stats.cell(today.plusDays(1)).paint)
        // Yesterday is inside the window and simply had nothing logged.
        assertEquals(DayPaint.Empty, stats.cell(today.minusDays(1)).paint)
    }

    @Test
    fun `a floor pushes earlier days blank`() {
        val stats = computeGoalChartStats(series(p("2026-02-02", 3)), today)
        val floor = LocalDate.of(2026, 3, 1)
        assertEquals(DayPaint.Heat, stats.cell(LocalDate.of(2026, 2, 2)).paint)
        assertEquals(DayPaint.Blank, stats.cell(LocalDate.of(2026, 2, 2), floor).paint)
    }

    /**
     * iOS iterates a Swift Dictionary's keys for the per-person dots, so its dot order
     * is nondeterministic run to run. That is a bug, not a spec — Android sorts.
     */
    @Test
    fun `per-person ids on a day are ordered by the personColors order`() {
        val s = series(
            p("2026-08-20", 2, "zoe"),
            p("2026-08-20", 3, "abe"),
            p("2026-08-20", 1, "mia"),
            colors = linkedMapOf("mia" to "#123456", "abe" to "#654321"),
        )
        val cell = computeGoalChartStats(s, today).cell(LocalDate.of(2026, 8, 20))
        // Declared people first in declaration order, then anyone else lexically.
        assertEquals(listOf("mia", "abe", "zoe"), cell.personIds)
        assertEquals(6, cell.value)
    }

    // ---------------------------------------------------------------- grids

    @Test
    fun `startOfWeek anchors on Sunday`() {
        // 2026-08-21 is a Friday; its week starts Sunday 2026-08-16.
        assertEquals(LocalDate.of(2026, 8, 16), startOfWeek(today))
        assertEquals(LocalDate.of(2026, 8, 16), startOfWeek(LocalDate.of(2026, 8, 16)))
        assertEquals(LocalDate.of(2026, 8, 16), startOfWeek(LocalDate.of(2026, 8, 22)))
    }

    @Test
    fun `a week grid is seven consecutive days from its Sunday`() {
        val stats = computeGoalChartStats(series(p("2026-08-18", 5)), today)
        val cells = weekCells(stats, startOfWeek(today))
        assertEquals(7, cells.size)
        assertEquals(LocalDate.of(2026, 8, 16), cells.first().day)
        assertEquals(LocalDate.of(2026, 8, 22), cells.last().day)
        assertEquals(5, cells[2].value) // Tuesday
        assertEquals(DayPaint.Future, cells[6].paint)
    }

    @Test
    fun `a month grid leads with the right number of blanks`() {
        val stats = computeGoalChartStats(series(), today)
        // 2026-08-01 is a Saturday -> six leading slots (Sun..Fri).
        val aug = monthGrid(stats, YearMonth.of(2026, 8))
        assertEquals(6, aug.lead)
        assertEquals(31, aug.cells.size)
        // 2026-02-01 is a Sunday -> no leading slots, and 2026 is not a leap year.
        val feb = monthGrid(stats, YearMonth.of(2026, 2))
        assertEquals(0, feb.lead)
        assertEquals(28, feb.cells.size)
    }

    @Test
    fun `year columns run whole Sunday weeks from the week containing Jan 1 up to today`() {
        val stats = computeGoalChartStats(series(), today)
        val cols = yearColumns(stats, today)
        assertTrue(cols.all { it.size == 7 })
        // 2026-01-01 is a Thursday, so the first column starts Sunday 2025-12-28.
        assertEquals(LocalDate.of(2025, 12, 28), cols.first().first().day)
        // Days before Jan 1 are floored out of the current-year grid.
        assertEquals(DayPaint.Blank, cols.first()[0].paint)
        assertTrue(cols.last().any { it.day == today })
    }

    // ---------------------------------------------------------------- maxima

    @Test
    fun `a scale maximum ignores future days and never divides by zero`() {
        val stats = computeGoalChartStats(
            series(p("2026-08-18", 3), p("2026-08-25", 99)),
            today,
        )
        val cells = weekCells(stats, startOfWeek(today))
        assertEquals(3, scaleMax(cells))
        assertEquals(1, scaleMax(emptyList()))
        assertEquals(1, scaleMax(weekCells(stats, startOfWeek(LocalDate.of(2026, 7, 1)))))
    }

    @Test
    fun `yearMax is the biggest day in todays calendar year`() {
        val stats = computeGoalChartStats(
            series(p("2025-06-01", 500), p("2026-06-01", 12), p("2026-07-04", 30)),
            today,
        )
        assertEquals(30, stats.yearMax)
    }

    // ---------------------------------------------------------------- totals

    @Test
    fun `byMonth buckets todays calendar year only`() {
        val stats = computeGoalChartStats(
            series(p("2025-08-01", 7), p("2026-01-05", 2), p("2026-08-02", 4), p("2026-08-03", 6)),
            today,
        )
        assertEquals(12, stats.byMonth.size)
        assertEquals(2, stats.byMonth[0])
        assertEquals(10, stats.byMonth[7])
        assertEquals(0, stats.byMonth[11])
    }

    @Test
    fun `byMonthPerPerson splits the month total`() {
        val stats = computeGoalChartStats(
            series(p("2026-08-02", 4, "abe"), p("2026-08-03", 6, "mia"), p("2026-08-04", 1, "abe")),
            today,
        )
        assertEquals(mapOf("abe" to 5, "mia" to 6), stats.byMonthPerPerson[7])
        assertEquals(mapOf("abe" to 5, "mia" to 6), stats.byPerson)
    }

    // ---------------------------------------------------------------- streaks

    @Test
    fun `currentStreak counts back from today`() {
        val stats = computeGoalChartStats(
            series(p("2026-08-21", 1), p("2026-08-20", 1), p("2026-08-19", 1), p("2026-08-17", 1)),
            today,
        )
        assertEquals(3, stats.currentStreak)
        assertEquals(3, stats.longestStreak)
        assertEquals(4, stats.activeDays)
    }

    @Test
    fun `currentStreak survives a gap of one day but not two`() {
        val yesterdayOnly = computeGoalChartStats(series(p("2026-08-20", 1)), today)
        assertEquals(1, yesterdayOnly.currentStreak)

        val staleByTwo = computeGoalChartStats(series(p("2026-08-19", 1)), today)
        assertEquals(0, staleByTwo.currentStreak)
    }

    @Test
    fun `a zero-valued day breaks a streak`() {
        val stats = computeGoalChartStats(
            series(p("2026-08-21", 1), p("2026-08-20", 0), p("2026-08-19", 1)),
            today,
        )
        assertEquals(1, stats.currentStreak)
        assertEquals(1, stats.longestStreak)
    }

    @Test
    fun `longestStreak finds the longest run anywhere`() {
        val stats = computeGoalChartStats(
            series(
                p("2026-03-01", 1), p("2026-03-02", 1), p("2026-03-03", 1), p("2026-03-04", 1),
                p("2026-08-21", 1),
            ),
            today,
        )
        assertEquals(4, stats.longestStreak)
        assertEquals(1, stats.currentStreak)
    }

    // ---------------------------------------------------------------- pace

    @Test
    fun `pace is target times elapsed over the goals own duration`() {
        val stats = computeGoalChartStats(
            series(
                p("2026-08-01", 40),
                target = 100,
                start = LocalDate.of(2026, 8, 1),
                end = LocalDate.of(2026, 8, 31), // a 30-day duration
            ),
            today,
        )
        val pace = stats.pace!!
        // 20 of 30 days elapsed -> pace 67 (rounded); only 40 logged -> 27 behind.
        assertEquals(67, pace.paceValue)
        assertEquals(-27, pace.delta)
        assertEquals(LocalDate.of(2026, 8, 31), pace.endLabel)
    }

    @Test
    fun `pace is null without an end date or without a target`() {
        assertNull(computeGoalChartStats(series(target = 100), today).pace)
        assertNull(
            computeGoalChartStats(series(end = LocalDate.of(2026, 12, 31)), today).pace,
        )
    }

    @Test
    fun `elapsed is clamped so a finished goal never paces past its target`() {
        val stats = computeGoalChartStats(
            series(
                target = 100,
                start = LocalDate.of(2026, 1, 1),
                end = LocalDate.of(2026, 3, 1),
            ),
            today,
        )
        assertEquals(100, stats.pace!!.paceValue)
    }

    @Test
    fun `projectedFinish extends the trailing fourteen-day rate`() {
        // 14 pages over the trailing 14 days -> 1 page a day; 60 to go -> 60 days out.
        val points = (0..13).map { p(today.minusDays(it.toLong()).toString(), 1) }
        val stats = computeGoalChartStats(
            GoalSeries(points = points, target = 74, rangeStart = LocalDate.of(2026, 1, 1)),
            today,
        )
        assertEquals(today.plusDays(60), stats.projectedFinish)
    }

    @Test
    fun `projectedFinish is today once the target is met and null with no recent rate`() {
        val met = computeGoalChartStats(series(p("2026-08-01", 10), target = 5), today)
        assertEquals(today, met.projectedFinish)

        val stale = computeGoalChartStats(series(p("2026-02-01", 1), target = 500), today)
        assertNull(stale.projectedFinish)
    }

    // ---------------------------------------------------------------- heat ramp

    @Test
    fun `heatColor lerps component-wise between the two tokens and clamps`() {
        val base = Color(0.2f, 0.4f, 0.6f)
        val peak = Color(0.8f, 0.4f, 0.0f)
        assertEquals(base, heatColor(0f, base, peak))
        assertEquals(peak, heatColor(1f, base, peak))
        assertEquals(base, heatColor(-3f, base, peak))
        assertEquals(peak, heatColor(9f, base, peak))

        // sRGB Colors are stored 8 bits per channel, so one quantisation step (1/255 =
        // 0.0039) is the tightest tolerance any component comparison can hold.
        val step = 1f / 255f
        val mid = heatColor(0.5f, base, peak)
        assertEquals(0.5f, mid.red, step)
        assertEquals(0.4f, mid.green, step)
        assertEquals(0.3f, mid.blue, step)
        assertEquals(1f, mid.alpha, step)
    }

    @Test
    fun `heat intensity is the day over the scale max`() {
        assertEquals(0f, heatIntensity(0, 8))
        assertEquals(0.5f, heatIntensity(4, 8))
        assertEquals(1f, heatIntensity(8, 8))
        assertEquals(1f, heatIntensity(80, 8), "never overshoots the ramp")
        assertEquals(0f, heatIntensity(4, 0), "a zero max must not divide by zero")
    }

    @Test
    fun `the dark-text threshold matches iOS`() {
        assertEquals(0.55f, HEAT_DARK_THRESHOLD)
        assertTrue(!isHeatDark(0.55f))
        assertTrue(isHeatDark(0.56f))
    }

    // ---------------------------------------------------------------- ring geometry

    @Test
    fun `ring sectors are thirty degrees apart with a gap, starting at twelve o clock`() {
        val jan = ringSector(0)
        // 0deg + half the 3deg gap, shifted to Compose's 3-o'clock origin.
        assertEquals(-88.5f, jan.startAngle, 0.001f)
        assertEquals(27f, jan.sweepAngle, 0.001f)

        val dec = ringSector(11)
        assertEquals(241.5f, dec.startAngle, 0.001f)
        assertEquals(27f, dec.sweepAngle, 0.001f)
        assertEquals(30f, ringSector(1).startAngle - jan.startAngle, 0.001f)
    }

    @Test
    fun `a ring wedge fills from the inner radius in proportion to the month`() {
        assertEquals(56f, ringFillRadius(0, 10, 56f, 116f), 0.001f)
        assertEquals(86f, ringFillRadius(5, 10, 56f, 116f), 0.001f)
        assertEquals(116f, ringFillRadius(10, 10, 56f, 116f), 0.001f)
        assertEquals(116f, ringFillRadius(40, 10, 56f, 116f), 0.001f, "clamped to the outer radius")
    }

    @Test
    fun `a tap on the ring resolves to the month under it`() {
        assertEquals(0, ringMonthAt(0f, -10f), "straight up is January")
        assertEquals(3, ringMonthAt(10f, 0f), "three o'clock is April")
        assertEquals(6, ringMonthAt(0f, 10f), "straight down is July")
        assertEquals(9, ringMonthAt(-10f, 0f), "nine o'clock is October")
        assertEquals(11, ringMonthAt(-1f, -10f), "just anticlockwise of up is December")
    }

    // ---------------------------------------------------------------- collection

    @Test
    fun `a collection shelf never has fewer slots than the items already done`() {
        assertEquals(12, collectionSlots(target = 12, done = 3))
        assertEquals(15, collectionSlots(target = 12, done = 15))
        assertEquals(1, collectionSlots(target = null, done = 0))
    }

    // ---------------------------------------------------------------- pace staircase

    @Test
    fun `the pace line visits only the days that changed it`() {
        val stats = computeGoalChartStats(
            series(
                p("2026-08-03", 4), p("2026-08-06", 6),
                start = LocalDate.of(2026, 8, 1),
            ),
            LocalDate.of(2026, 8, 8),
        )
        // Origin; the previous value held to the day BEFORE each jump; the jump; today.
        // Day 2 is 08-03 (+4) and day 5 is 08-06 (+6), so the total steps 0 -> 4 -> 10.
        assertEquals(
            listOf(0f to 0f, 1f to 0f, 2f to 4f, 4f to 4f, 5f to 10f, 7f to 10f),
            pacePoints(stats).map { it.x to it.y },
        )
    }

    @Test
    fun `the pace line ignores days outside the window`() {
        val stats = computeGoalChartStats(
            series(
                p("2025-12-31", 99), p("2026-08-03", 4),
                start = LocalDate.of(2026, 8, 1),
            ),
            LocalDate.of(2026, 8, 4),
        )
        assertEquals(4f, pacePoints(stats).last().y, "the out-of-window day must not accumulate")
    }

    @Test
    fun `a pace line with nothing logged is still a valid two-point path`() {
        val points = pacePoints(computeGoalChartStats(series(start = LocalDate.of(2026, 8, 1)), today))
        assertTrue(points.size >= 2)
        assertTrue(points.all { it.y == 0f })
    }

    @Test
    fun `percentOf truncates and tolerates a zero denominator`() {
        assertEquals(50, percentOf(1, 2))
        assertEquals(66, percentOf(2, 3))
        assertEquals(0, percentOf(3, 0))
        assertEquals(100, percentOf(9, 9))
    }
}
