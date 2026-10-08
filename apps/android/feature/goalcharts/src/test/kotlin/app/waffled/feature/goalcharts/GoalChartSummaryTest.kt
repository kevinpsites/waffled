package app.waffled.feature.goalcharts

import app.waffled.core.model.GoalCadence
import app.waffled.core.model.GoalPoint
import app.waffled.core.model.GoalSeries
import app.waffled.core.model.HouseholdWeekStart
import java.time.LocalDate
import java.time.YearMonth
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val Sun = HouseholdWeekStart.Sunday

/**
 * The spoken form of each chart.
 *
 * Every one of these views conveys its information through colour and shape alone, so
 * each owes a content description. They are pure string builders precisely so they can be
 * tested here — a `Canvas` content description otherwise only exists on a device.
 */
class GoalChartSummaryTest {

    private val today = LocalDate.of(2026, 8, 21)

    private fun stats(vararg points: GoalPoint, target: Int? = null) =
        computeGoalChartStats(
            GoalSeries(
                points = points.toList(),
                target = target,
                cadence = GoalCadence.Daily,
                rangeStart = LocalDate.of(2026, 1, 1),
                unit = "pages",
            ),
            today,
        )

    private fun p(day: String, value: Int) = GoalPoint(LocalDate.parse(day), value.toDouble())

    @Test
    fun `the week summary names the range, the total and the active days`() {
        val s = stats(p("2026-08-17", 3), p("2026-08-19", 5))
        val text = weekSummary(s, startOfWeek(today, Sun), "pages")
        assertTrue(text.contains("8 pages"), text)
        assertTrue(text.contains("2 of 7"), text)
    }

    @Test
    fun `the month summary names the month, the total and the best day`() {
        val s = stats(p("2026-08-02", 4), p("2026-08-03", 9))
        val text = monthSummary(s, YearMonth.of(2026, 8), "pages")
        assertTrue(text.contains("August 2026"), text)
        assertTrue(text.contains("13 pages"), text)
        assertTrue(text.contains("best day 9"), text)
    }

    @Test
    fun `a month with nothing logged says so rather than reading as broken`() {
        val text = monthSummary(stats(), YearMonth.of(2026, 8), "pages")
        assertTrue(text.contains("Nothing logged"), text)
    }

    @Test
    fun `the year summary names active days and both streaks`() {
        val s = stats(p("2026-08-20", 1), p("2026-08-21", 1))
        val text = yearSummary(s)
        assertTrue(text.contains("2 active days"), text)
        assertTrue(text.contains("current streak 2"), text)
        assertTrue(text.contains("longest streak 2"), text)
    }

    @Test
    fun `the ring summary lists every month so far`() {
        val s = stats(p("2026-01-04", 5), p("2026-08-01", 2))
        val text = yearRingSummary(s, "pages")
        assertTrue(text.startsWith("The year in a ring"), text)
        assertTrue(text.contains("January 5"), text)
        assertTrue(text.contains("August 2"), text)
        assertTrue(!text.contains("September"), "months after today must not be spoken: $text")
    }

    @Test
    fun `the pace summary says whether you are ahead or behind`() {
        val ahead = paceSummary(
            computeGoalChartStats(
                GoalSeries(
                    points = listOf(p("2026-08-01", 90)),
                    target = 100,
                    rangeStart = LocalDate.of(2026, 8, 1),
                    rangeEnd = LocalDate.of(2026, 8, 31),
                    unit = "pages",
                ),
                today,
            ),
            "pages",
        )
        assertTrue(ahead.contains("ahead of pace"), ahead)

        val behind = paceSummary(
            computeGoalChartStats(
                GoalSeries(
                    points = listOf(p("2026-08-01", 1)),
                    target = 100,
                    rangeStart = LocalDate.of(2026, 8, 1),
                    rangeEnd = LocalDate.of(2026, 8, 31),
                    unit = "pages",
                ),
                today,
            ),
            "pages",
        )
        assertTrue(behind.contains("behind pace"), behind)
    }

    @Test
    fun `the consistency summary is a hit count out of the days elapsed`() {
        val s = stats(p("2026-08-01", 1), p("2026-08-02", 1), p("2026-08-05", 0))
        assertEquals(
            "Consistency for August: showed up on 2 of the 21 days so far. Current streak 0 days, longest 2.",
            consistencySummary(s, YearMonth.of(2026, 8)),
        )
    }

    @Test
    fun `the collection summary counts filled slots`() {
        val text = collectionSummary(done = 3, target = 12, unit = "books")
        assertTrue(text.contains("3 of 12 books"), text)
    }

    @Test
    fun `the by-person summary names each person and their share`() {
        val s = computeGoalChartStats(
            GoalSeries(
                points = listOf(
                    GoalPoint(LocalDate.of(2026, 8, 2), 4.0, "abe"),
                    GoalPoint(LocalDate.of(2026, 8, 3), 6.0, "mia"),
                ),
                rangeStart = LocalDate.of(2026, 1, 1),
                unit = "pages",
                personColors = linkedMapOf("abe" to "#EC6049", "mia" to "#25A368"),
            ),
            today,
        )
        val text = byPersonSummary(s, mapOf("abe" to "Abe", "mia" to "Mia"), "pages")
        assertTrue(text.contains("Abe 4 pages"), text)
        assertTrue(text.contains("Mia 6 pages"), text)
    }

    @Test
    fun `a person with no name falls back to a neutral label rather than an id`() {
        val s = computeGoalChartStats(
            GoalSeries(
                points = listOf(GoalPoint(LocalDate.of(2026, 8, 2), 4.0, "abe-9f2c")),
                rangeStart = LocalDate.of(2026, 1, 1),
            ),
            today,
        )
        val text = byPersonSummary(s, emptyMap(), "")
        assertTrue(!text.contains("abe-9f2c"), "a raw id must never be spoken: $text")
        assertTrue(text.contains("Someone"), text)
    }

    // ---- fractional amounts ----------------------------------------------------

    @Test
    fun `a spoken amount drops the decimal on a whole number and keeps two otherwise`() {
        // A screen reader saying "one point zero eight three three three three" is worse
        // than useless, and the same string renders inside a 13dp calendar square.
        assertEquals("12", amountText(12.0))
        assertEquals("1.08", amountText(1.0833333))
        assertEquals("0.33", amountText(1.0 / 3.0))
        assertEquals("0.5", amountText(0.5), "a trailing zero is noise")
        assertEquals("2.58 hours", amount(2.5833, "hours"))
    }

    @Test
    fun `a fractional total is spoken, not rounded away`() {
        val s = stats(GoalPoint(LocalDate.of(2026, 8, 19), 1.0 / 3.0))
        val text = weekSummary(s, startOfWeek(today, Sun), "hours")
        assertTrue(text.contains("0.33 hours"), text)
        assertTrue(text.contains("1 of 7"), "a sub-unit log is still a day you showed up: $text")
    }
}
