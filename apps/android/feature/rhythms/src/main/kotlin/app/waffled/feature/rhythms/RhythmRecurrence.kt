package app.waffled.feature.rhythms

import java.time.DayOfWeek
import java.time.LocalDate

/**
 * COPY of the custom-builder half of `feature:calendar`'s `Recurrence` (itself the port of
 * iOS `Recurrence.swift`). Features may not depend on each other, and no recurrence helper
 * lives in a core module yet — follow-up: extract one into `core:model` and delete both
 * this and `feature:chores`' `ChoreRrule` copy.
 */
enum class RhythmMonthlyMode { DayOfMonth, NthWeekday }

object RhythmRecurrence {

    /** RRULE weekday codes, Sunday-led. */
    val weekdays = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")

    private const val WEEKDAY_SET = "MO,TU,WE,TH,FR"
    private val plainDay = weekdays.toSet()
    private val dayName = mapOf(
        "SU" to "Sun", "MO" to "Mon", "TU" to "Tue", "WE" to "Wed",
        "TH" to "Thu", "FR" to "Fri", "SA" to "Sat",
    )
    private val fullDay = mapOf(
        "SU" to "Sunday", "MO" to "Monday", "TU" to "Tuesday", "WE" to "Wednesday",
        "TH" to "Thursday", "FR" to "Friday", "SA" to "Saturday",
    )
    private val ordinals = listOf("", "first", "second", "third", "fourth", "fifth")
    private val nthWeekdayToken = Regex("^-?\\d+[A-Z]{2}$")

    fun weekdayCode(date: LocalDate): String = when (date.dayOfWeek) {
        DayOfWeek.SUNDAY -> "SU"
        DayOfWeek.MONDAY -> "MO"
        DayOfWeek.TUESDAY -> "TU"
        DayOfWeek.WEDNESDAY -> "WE"
        DayOfWeek.THURSDAY -> "TH"
        DayOfWeek.FRIDAY -> "FR"
        DayOfWeek.SATURDAY -> "SA"
    }

    private fun nthWeekdayOfMonth(date: LocalDate): Int = (date.dayOfMonth - 1) / 7 + 1

    /** The "custom" builder of iOS `Recurrence.buildRrule`; [custom] overrides it. */
    fun buildRrule(
        interval: Int,
        unit: RhythmForm.Unit,
        byday: List<String>,
        monthlyMode: RhythmMonthlyMode,
        monthlyOrdinal: Int,
        custom: String,
        start: LocalDate,
    ): String {
        val raw = stripPrefix(custom)
        if (raw.isNotEmpty()) return raw
        val weekday = weekdayCode(start)
        val n = maxOf(1, interval)
        val iv = if (n > 1) ";INTERVAL=$n" else ""
        return when (unit) {
            RhythmForm.Unit.Days -> "FREQ=DAILY$iv"
            RhythmForm.Unit.Weeks -> "FREQ=WEEKLY$iv;BYDAY=${byday.ifEmpty { listOf(weekday) }.joinToString(",")}"
            RhythmForm.Unit.Months -> if (monthlyMode == RhythmMonthlyMode.NthWeekday) {
                val ord = if (monthlyOrdinal == 0) nthWeekdayOfMonth(start) else monthlyOrdinal
                "FREQ=MONTHLY$iv;BYDAY=$ord$weekday"
            } else {
                "FREQ=MONTHLY$iv"
            }
            RhythmForm.Unit.Years -> "FREQ=YEARLY$iv"
        }
    }

    /** Plain-English summary; falls back to the raw rule for shapes it doesn't recognise. */
    fun describeRrule(rule: String?, start: LocalDate): String {
        if (rule.isNullOrEmpty()) return "Does not repeat"
        val parts = stripPrefix(rule).uppercase().split(";").mapNotNull { segment ->
            val kv = segment.split("=", limit = 2)
            if (kv.size == 2) kv[0] to kv[1] else null
        }.toMap()
        val freq = parts["FREQ"].orEmpty()
        val n = parts["INTERVAL"]?.toIntOrNull()?.let { maxOf(1, it) } ?: 1
        val byday = parts["BYDAY"]?.split(",").orEmpty()
        fun every(unit: String) = if (n == 1) "Every $unit" else "Every $n ${unit}s"

        val base: String = when {
            freq == "DAILY" && parts["BYDAY"] == null -> every("day")
            freq == "WEEKLY" && byday.joinToString(",") == WEEKDAY_SET ->
                if (n == 1) "Every weekday (Mon–Fri)" else "Every $n weeks on Mon–Fri"
            freq == "WEEKLY" && byday.isNotEmpty() && byday.all { it in plainDay } ->
                "${every("week")} on ${byday.joinToString(", ") { dayName[it] ?: it }}"
            freq == "WEEKLY" && parts["BYDAY"] == null -> "${every("week")} on ${dayName[weekdayCode(start)].orEmpty()}"
            freq == "MONTHLY" && parts["BYDAY"] != null -> describeMonthlyByday(parts["BYDAY"]!!, ::every)
            freq == "MONTHLY" && parts["BYMONTHDAY"] == null -> every("month")
            freq == "YEARLY" -> every("year")
            else -> null
        } ?: return rule
        val count = parts["COUNT"]
        return if (count != null) "$base, $count times" else base
    }

    private fun describeMonthlyByday(byday: String, every: (String) -> String): String? {
        if (!nthWeekdayToken.matches(byday)) return null
        val num = byday.dropLast(2).toIntOrNull() ?: 1
        val code = byday.takeLast(2)
        val ord = when {
            num == -1 -> "last"
            num in ordinals.indices -> ordinals[num]
            else -> "${num}th"
        }
        return "${every("month")} on the $ord ${fullDay[code] ?: code}"
    }

    private fun stripPrefix(value: String): String =
        value.trim().removePrefix("RRULE:").removePrefix("rrule:").trim()
}
