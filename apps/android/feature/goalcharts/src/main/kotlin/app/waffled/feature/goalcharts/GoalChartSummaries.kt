package app.waffled.feature.goalcharts

import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.floor
import kotlin.math.roundToLong

/**
 * The spoken form of each chart.
 *
 * Every one of these views carries its meaning in colour, length and position — a
 * screen reader gets nothing from the drawing itself, so each owes a content description.
 * They live here as pure string builders so `GoalChartSummaryTest` can cover them; a
 * description attached inside a `Canvas` would only ever exist on a device.
 *
 * Formatters are module-level constants, never rebuilt per call: building a formatter in a
 * render path is the other half of the documented date-math jank trap.
 */

private val MONTH_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
private val LONG_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.getDefault())

internal fun monthName(month: Int): String =
    java.time.Month.of(month + 1).getDisplayName(TextStyle.FULL, Locale.getDefault())

internal fun shortMonthName(month: Int): String =
    java.time.Month.of(month + 1).getDisplayName(TextStyle.SHORT, Locale.getDefault())

internal fun monthDay(day: LocalDate): String = MONTH_DAY.format(day)

internal fun longDay(day: LocalDate): String = LONG_DAY.format(day)

/**
 * A measured amount as text: whole numbers lose the decimal, everything else keeps at most
 * two places with trailing zeros dropped — 12 becomes "12", 1.0833… becomes "1.08", and a
 * 20-minute log (0.3333) becomes "0.33".
 *
 * `feature:goals` carries the same rule in its `goalFmt`, and this is deliberately a
 * second copy rather than a dependency: `goalcharts` is the CONSUMER half of the
 * `GoalSeries` seam and has no feature dependencies at all — that absence is the cheapest
 * proof it only ever draws a series. `core:model` is the shared floor between the two, but
 * a display formatter is presentation, not contract.
 *
 * The alternative — printing the raw `Double` — is not neutral: it renders "1.0833333"
 * inside a 13dp calendar square.
 */
internal fun amountText(value: Double): String {
    val rounded = (value * 100).roundToLong() / 100.0
    if (rounded == floor(rounded)) return rounded.toLong().toString()
    return String.format(Locale.US, "%.2f", rounded).trimEnd('0').trimEnd('.')
}

/** `"12 pages"`, or just `"12"` when the goal has no unit. */
internal fun amount(value: Double, unit: String): String =
    if (unit.isBlank()) amountText(value) else "${amountText(value)} $unit"

/** A person's display name, or a neutral label — never a raw id, which reads as noise. */
internal fun personLabel(personId: String, names: Map<String, String>): String =
    names[personId]?.takeIf { it.isNotBlank() } ?: "Someone"

fun weekSummary(stats: GoalChartStats, weekStart: LocalDate, unit: String): String {
    val cells = weekCells(stats, weekStart)
    val total = cells.sumOf { it.value }
    val active = cells.count { it.logged }
    return "Week of ${monthDay(weekStart)} to ${monthDay(weekStart.plusDays(6))}. " +
        "${amount(total, unit)} logged across $active of 7 days."
}

fun monthSummary(stats: GoalChartStats, month: YearMonth, unit: String): String {
    val cells = monthGrid(stats, month).cells
    val total = cells.sumOf { it.value }
    val label = "${monthName(month.monthValue - 1)} ${month.year}"
    if (total <= 0.0) return "Calendar heatmap for $label. Nothing logged yet."
    val best = cells.filter { it.logged }.maxByOrNull { it.value }
    val active = cells.count { it.logged }
    return "Calendar heatmap for $label. ${amount(total, unit)} across $active days" +
        (best?.let { ", best day ${amountText(it.value)} on ${monthDay(it.day)}" } ?: "") + "."
}

fun yearSummary(stats: GoalChartStats): String =
    "Contribution grid for ${stats.today.year}. ${stats.activeDays} active days, " +
        "current streak ${stats.currentStreak}, longest streak ${stats.longestStreak}."

fun yearRingSummary(stats: GoalChartStats, unit: String): String {
    val months = (0..stats.today.monthValue - 1).joinToString(", ") {
        "${monthName(it)} ${stats.byMonth[it]}"
    }
    return "The year in a ring: each wedge is a month. " +
        "${amount(stats.total, unit)} so far. By month: $months."
}

fun paceSummary(stats: GoalChartStats, unit: String): String {
    val target = stats.target ?: 0
    val head = "Cumulative ${if (unit.isBlank()) "progress" else unit} against the pace " +
        "needed to reach $target. ${amount(stats.total, unit)} logged so far"
    val pace = stats.pace ?: return "$head."
    val delta = pace.delta
    val standing = if (delta >= 0.0) {
        "${amountText(delta)} ahead of pace"
    } else {
        "${amountText(-delta)} behind pace"
    }
    val projection = stats.projectedFinish?.let { ", projected to finish ${monthDay(it)}" } ?: ""
    return "$head, $standing$projection."
}

fun consistencySummary(stats: GoalChartStats, month: YearMonth): String {
    val cells = monthGrid(stats, month).cells
    val hits = cells.count { it.logged }
    val elapsed = cells.count { !it.future }
    return "Consistency for ${monthName(month.monthValue - 1)}: showed up on $hits of the " +
        "$elapsed days so far. Current streak ${stats.currentStreak} days, longest ${stats.longestStreak}."
}

fun collectionSummary(done: Int, target: Int?, unit: String): String {
    val slots = collectionSlots(target, done)
    val label = if (unit.isBlank()) "items" else unit
    return "Collection shelf: $done of $slots $label filled."
}

fun byPersonSummary(stats: GoalChartStats, names: Map<String, String>, unit: String): String {
    if (stats.personOrder.isEmpty()) return "Monthly totals by person. Nobody has logged yet."
    val parts = stats.personOrder.joinToString(", ") {
        "${personLabel(it, names)} ${amount(stats.byPerson[it] ?: 0.0, unit)}"
    }
    return "Monthly totals by person. $parts."
}
