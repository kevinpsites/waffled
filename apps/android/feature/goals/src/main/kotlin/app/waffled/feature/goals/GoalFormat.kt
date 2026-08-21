package app.waffled.feature.goals

import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * The formatting rules every goal surface shares — the port of the free functions at the
 * top of the iOS `GoalsView.swift`, plus `ReviewRecapTitle.swift`.
 *
 * Amounts are stored EXACT (an hours+minutes log of 1h5m is 1.0833… hours), so every
 * display goes through [goalFmt] rather than printing the raw repeating decimal.
 */

/** The em dash shown wherever there is genuinely no number. */
private const val NO_VALUE = "—"

/**
 * Whole numbers without a decimal, otherwise at most two decimals with trailing zeros
 * dropped: 3 → "3", 1.5 → "1.5", 2.5833… → "2.58", 6.16667 → "6.17". Null → an em dash.
 */
fun goalFmt(n: Double?): String {
    if (n == null) return NO_VALUE
    val rounded = (n * 100).roundToLong() / 100.0
    if (rounded == kotlin.math.floor(rounded)) return rounded.toLong().toString()
    return String.format(java.util.Locale.US, "%.2f", rounded).trimEnd('0').trimEnd('.')
}

/**
 * Compact formatting for the tight goal ring: under 1,000 rounds to a whole number
 * (295.99 → "296") and larger values abbreviate (10,000 → "10K", 1,234,567 → "1.2M"), so
 * the big number stays readable at any magnitude instead of shrinking to nothing.
 *
 * Ring-only — [goalFmt] still feeds the exact figures to subtitles, milestones and cards.
 *
 * Hand-rolled rather than delegating to a platform formatter: iOS uses
 * `.number.notation(.compactName)`, and Android's `CompactDecimalFormat` is both
 * locale-variable and unavailable below API 24-era ICU behaviour we can rely on for
 * matching iOS exactly. Matching the iOS output is what matters here.
 */
fun ringFmt(n: Double?): String {
    if (n == null) return NO_VALUE
    if (abs(n) < 1000) return n.roundToLong().toString()

    val sign = if (n < 0) "-" else ""
    var value = abs(n)
    val suffixes = listOf("K", "M", "B", "T")
    var index = -1
    // The loop tests the ROUNDED value, not the raw one: 999,999 rounds to 1000.0K, which
    // has to promote to "1M" rather than render a four-digit K.
    while (index < suffixes.lastIndex && oneDecimal(value) >= 1000) {
        value /= 1000
        index += 1
    }
    val oneDecimal = oneDecimal(value)
    val text = if (oneDecimal == kotlin.math.floor(oneDecimal)) {
        oneDecimal.toLong().toString()
    } else {
        String.format(java.util.Locale.US, "%.1f", oneDecimal)
    }
    return "$sign$text${suffixes[index]}"
}

private fun oneDecimal(value: Double): Double = (value * 10).roundToLong() / 10.0

/** The first word of a display name — what a chip or a contribution row shows. */
fun goalFirstName(name: String): String = name.substringBefore(' ')

private val GOAL_TYPE_LABELS = mapOf(
    "count" to "Count",
    "total" to "Total",
    "habit" to "Habit",
    "checklist" to "Milestones",
)

/** "Count · in books", "Habit · 5× a week", "Count · each logs visits". */
fun goalDescriptor(goal: GoalsApi.Goal): String {
    val label = GOAL_TYPE_LABELS[goal.goalType] ?: goal.goalType
    val quantity = when {
        goal.goalType == "habit" ->
            "${goal.habitTargetPerPeriod ?: 0}× a ${goal.habitPeriod ?: "week"}"

        goal.trackingMode == "each_tracks" -> "each logs ${goal.unit ?: "progress"}"
        goal.unit != null -> "in ${goal.unit}"
        else -> "shared total"
    }
    return "$label · $quantity"
}

/**
 * The Today review banner's count → headline. Shared by the goals review screen and the
 * Today card so the wording can't drift between them. [confirmed] is calendar events to
 * log against a goal; [suggested] is events that might count toward one.
 */
fun reviewRecapTitle(confirmed: Int, suggested: Int): String = when {
    confirmed > 0 && suggested > 0 -> "$confirmed to review · $suggested to link"
    confirmed > 0 -> if (confirmed == 1) "1 event to log" else "$confirmed events to log"
    else -> if (suggested == 1) "1 event might count" else "$suggested events might count"
}

/** The category glyph, mirroring the web CATEGORIES table. */
fun goalCategoryEmoji(category: String?): String = when (category) {
    "physical" -> "🏃"
    "intellectual" -> "📚"
    "spiritual" -> "🧘"
    "creative" -> "🎨"
    "social" -> "🤝"
    else -> "🎯"
}

/** Units that mean a goal is measured in HOURS, and so is logged as hours + minutes. */
private val HOUR_UNITS = setOf("hour", "hours", "hr", "hrs")

fun isHourUnit(unit: String?): Boolean = unit?.trim()?.lowercase() in HOUR_UNITS

private val TIME_UNITS = HOUR_UNITS + setOf("minute", "minutes", "min")

/** A time-measured goal steps in halves; everything else in whole units. */
fun goalStepSize(unit: String?): Double =
    if (unit?.trim()?.lowercase() in TIME_UNITS) 0.5 else 1.0

/** "1 hour" but "2 hours" — singularise a plural unit for exactly one. */
fun goalUnitLabel(unit: String?, amount: Double): String {
    val u = unit?.trim().orEmpty()
    if (u.isEmpty()) return ""
    val isOne = abs(amount - 1) < 0.001
    return if (isOne && u.length > 1 && u.endsWith("s")) u.dropLast(1) else u
}
