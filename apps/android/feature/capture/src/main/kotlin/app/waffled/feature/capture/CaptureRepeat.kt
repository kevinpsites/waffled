package app.waffled.feature.capture

import java.time.LocalDate

// COPY of the rule-describing half of `feature/calendar` Recurrence.kt (itself the port of
// iOS Recurrence.swift). A feature module may not depend on another feature, and the
// capture parser needs the same plain-English label the calendar shows. Follow-up: lift
// Recurrence into core:model so both modules share one copy.

/** The capture editor's "Repeats" menu — the iOS sheet's six choices. */
enum class CaptureRepeatFreq(val label: String) {
    None("Does not repeat"),
    Daily("Daily"),
    Weekdays("Weekdays"),
    Weekly("Weekly"),
    Monthly("Monthly"),
    Yearly("Yearly"),

    /** A parsed rule the menu cannot represent (an interval, say) — kept verbatim. */
    Custom("Custom"),
}

/** The menu state: a frequency plus the weekly days or the verbatim custom rule. */
data class CaptureRepeat(
    val freq: CaptureRepeatFreq = CaptureRepeatFreq.None,
    val byday: List<String> = emptyList(),
    val custom: String = "",
) {
    /** The RRULE to send, or null for a one-off. A weekly rule with no days uses [start]'s weekday. */
    fun rrule(start: LocalDate): String? = when (freq) {
        CaptureRepeatFreq.None -> null
        CaptureRepeatFreq.Daily -> "FREQ=DAILY"
        CaptureRepeatFreq.Weekdays -> "FREQ=WEEKLY;BYDAY=${CaptureRecurrence.WEEKDAY_SET}"
        CaptureRepeatFreq.Weekly ->
            "FREQ=WEEKLY;BYDAY=${byday.ifEmpty { listOf(CaptureRecurrence.weekdayCode(start)) }.joinToString(",")}"
        CaptureRepeatFreq.Monthly -> "FREQ=MONTHLY"
        CaptureRepeatFreq.Yearly -> "FREQ=YEARLY"
        CaptureRepeatFreq.Custom -> custom.ifBlank { null }
    }

    companion object {
        /** Seed the menu from a parsed rule; anything the menu can't name stays [CaptureRepeatFreq.Custom]. */
        fun parse(rrule: String?): CaptureRepeat {
            if (rrule.isNullOrBlank()) return CaptureRepeat()
            val raw = rrule.trim().removePrefix("RRULE:").trim()
            val parts = CaptureRecurrence.ruleParts(raw)
            val bounded = parts.containsKey("COUNT") || parts.containsKey("UNTIL") || parts.containsKey("INTERVAL")
            val byday = parts["BYDAY"]?.split(",").orEmpty()
            if (!bounded) {
                when (parts["FREQ"]) {
                    "DAILY" -> if (parts["BYDAY"] == null) return CaptureRepeat(CaptureRepeatFreq.Daily)
                    "WEEKLY" -> {
                        if (byday.joinToString(",") == CaptureRecurrence.WEEKDAY_SET) return CaptureRepeat(CaptureRepeatFreq.Weekdays)
                        if (byday.all { it in CaptureRecurrence.weekdays }) return CaptureRepeat(CaptureRepeatFreq.Weekly, byday)
                    }
                    "MONTHLY" -> if (parts["BYDAY"] == null && parts["BYMONTHDAY"] == null) return CaptureRepeat(CaptureRepeatFreq.Monthly)
                    "YEARLY" -> return CaptureRepeat(CaptureRepeatFreq.Yearly)
                }
            }
            return CaptureRepeat(CaptureRepeatFreq.Custom, custom = raw)
        }
    }
}

object CaptureRecurrence {
    val weekdays = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")
    const val WEEKDAY_SET = "MO,TU,WE,TH,FR"

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

    fun weekdayCode(date: LocalDate): String = weekdays[date.dayOfWeek.value % 7]

    /** Plain-English description of a rule; the raw rule when it isn't recognised. */
    fun describeRrule(rule: String?, start: LocalDate): String {
        if (rule.isNullOrEmpty()) return "Does not repeat"
        val parts = ruleParts(rule.trim().removePrefix("RRULE:").removePrefix("rrule:").trim())
        val freq = parts["FREQ"].orEmpty()
        val n = parts["INTERVAL"]?.toIntOrNull()?.let { maxOf(1, it) } ?: 1
        val byday = parts["BYDAY"]?.split(",").orEmpty()
        fun every(unit: String) = if (n == 1) "Every $unit" else "Every $n ${unit}s"

        val base: String = when {
            freq == "DAILY" && parts["BYDAY"] == null -> every("day")
            freq == "WEEKLY" && byday.joinToString(",") == WEEKDAY_SET ->
                if (n == 1) "Every weekday (Mon–Fri)" else "Every $n weeks on Mon–Fri"
            freq == "WEEKLY" && byday.isNotEmpty() && byday.all { it in dayName } ->
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

    internal fun ruleParts(raw: String): Map<String, String> =
        raw.uppercase().split(";").mapNotNull { segment ->
            val kv = segment.split("=", limit = 2)
            if (kv.size == 2) kv[0] to kv[1] else null
        }.toMap()
}
