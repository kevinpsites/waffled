package app.waffled.feature.calendar

import java.time.DayOfWeek
import java.time.LocalDate

/**
 * Pure helpers for the event editor's "Repeats" picker — the Kotlin port of
 * `apps/ios/.../Calendar/Recurrence.swift`, which mirrors the web's
 * `apps/web/src/kiosk/components/recurrence.ts`.
 *
 * Turn the picker state into an RFC5545 RRULE string, parse an existing rule back into
 * picker state, and describe a rule in plain English. The same shapes round-trip on all
 * three clients, so an event made recurring on one surface stays editable on the others.
 *
 * "Custom…" is a friendly builder ("repeat every N days/weeks/months/years", with weekday
 * chips for weekly and a day-of-month / nth-weekday choice for monthly) — nobody types an
 * RRULE. A raw RRULE is kept as an advanced escape hatch, and to preserve an imported rule
 * the builder cannot represent.
 *
 * ⚠️ The start date is a [LocalDate], not an instant. Only the weekday and the
 * day-of-month matter here, and taking a zoneless date makes the derivation deterministic
 * without the pinned-calendar rig the Swift version needs.
 */
enum class RepeatFreq { None, Daily, Weekdays, Weekly, Monthly, Custom }

enum class CustomUnit { Day, Week, Month, Year }

/**
 * Custom-monthly shape: repeat on the start's day-of-month, or on a chosen *ordinal* of
 * the start's weekday (1…5, or -1 = last). This goes one beyond the web, which only
 * distinguishes the start's own nth vs. last.
 */
enum class MonthlyMode { DayOfMonth, NthWeekday }

/** The picker state. [custom] (an advanced raw RRULE) overrides the builder when set. */
data class RepeatState(
    val freq: RepeatFreq = RepeatFreq.None,
    /** Weekly + custom-weekly days, e.g. `["MO","WE"]`. */
    val byday: List<String> = emptyList(),
    /** Custom: "every N" (>= 1). */
    val interval: Int = 1,
    /** Custom: the unit N counts. */
    val unit: CustomUnit = CustomUnit.Week,
    val monthlyMode: MonthlyMode = MonthlyMode.DayOfMonth,
    /** Custom-monthly nth-weekday: 1…5, or -1 = last. 0 means "the start's own nth". */
    val monthlyOrdinal: Int = 1,
    /** Advanced raw RRULE — overrides the builder. */
    val custom: String = "",
) {
    companion object {
        val NONE = RepeatState()
    }
}

/** The series-wide fields a per-occurrence override cannot represent. */
data class RecurringEventSeriesFields(
    val allDay: Boolean,
    val isCountdown: Boolean,
    val participantIds: List<String>,
    val goalId: String?,
    val goalStepId: String?,
    val rrule: String?,
    /** ISO instant, or null for an open-ended series. */
    val recurrenceEndAt: String?,
)

/**
 * May an edit be applied to one occurrence only?
 *
 * Only if every SERIES field is untouched. A per-occurrence override on the server carries
 * title / start / end / location and nothing else, so letting a changed participant list
 * or rrule through would appear to save and then quietly not apply.
 */
object RecurringEventEditPolicy {

    fun canApplyToSingleOccurrence(
        original: RecurringEventSeriesFields,
        edited: RecurringEventSeriesFields,
    ): Boolean =
        original.allDay == edited.allDay &&
            original.isCountdown == edited.isCountdown &&
            // Order is not meaningful — the write paths disagree about it, and a reorder
            // is not a change to the series.
            original.participantIds.toSet() == edited.participantIds.toSet() &&
            original.goalId == edited.goalId &&
            original.goalStepId == edited.goalStepId &&
            original.rrule == edited.rrule &&
            original.recurrenceEndAt == edited.recurrenceEndAt
}

object Recurrence {

    /** RRULE weekday codes, Sunday-led to match the grid. */
    val weekdays = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")

    const val WEEKDAY_SET = "MO,TU,WE,TH,FR"

    private val plainDay: Set<String> = weekdays.toSet()

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

    /** The RRULE weekday code for a date's weekday. */
    fun weekdayCode(date: LocalDate): String = when (date.dayOfWeek) {
        DayOfWeek.SUNDAY -> "SU"
        DayOfWeek.MONDAY -> "MO"
        DayOfWeek.TUESDAY -> "TU"
        DayOfWeek.WEDNESDAY -> "WE"
        DayOfWeek.THURSDAY -> "TH"
        DayOfWeek.FRIDAY -> "FR"
        DayOfWeek.SATURDAY -> "SA"
    }

    /** Which occurrence of its weekday a date is within its month (1 = first, …). */
    fun nthWeekdayOfMonth(date: LocalDate): Int = (date.dayOfMonth - 1) / 7 + 1

    /**
     * Build the RRULE for the picker state. [start] supplies the default weekly day and
     * the monthly nth-weekday ordinal. Returns null for `None` (or an empty custom rule) —
     * i.e. a non-recurring event.
     */
    fun buildRrule(state: RepeatState, start: LocalDate): String? {
        val weekday = weekdayCode(start)
        return when (state.freq) {
            RepeatFreq.None -> null
            RepeatFreq.Daily -> "FREQ=DAILY"
            RepeatFreq.Weekdays -> "FREQ=WEEKLY;BYDAY=$WEEKDAY_SET"
            RepeatFreq.Weekly -> "FREQ=WEEKLY;BYDAY=${bydayOrStart(state.byday, weekday)}"
            // No BYMONTHDAY → repeats on the start date's day-of-month.
            RepeatFreq.Monthly -> "FREQ=MONTHLY"
            RepeatFreq.Custom -> buildCustom(state, start, weekday)
        }
    }

    private fun buildCustom(state: RepeatState, start: LocalDate, weekday: String): String {
        val raw = stripPrefix(state.custom)
        if (raw.isNotEmpty()) return raw // advanced override

        val n = maxOf(1, state.interval)
        val iv = if (n > 1) ";INTERVAL=$n" else ""
        return when (state.unit) {
            CustomUnit.Day -> "FREQ=DAILY$iv"
            CustomUnit.Week -> "FREQ=WEEKLY$iv;BYDAY=${bydayOrStart(state.byday, weekday)}"
            CustomUnit.Month -> if (state.monthlyMode == MonthlyMode.NthWeekday) {
                val ord = if (state.monthlyOrdinal == 0) nthWeekdayOfMonth(start) else state.monthlyOrdinal
                "FREQ=MONTHLY$iv;BYDAY=$ord$weekday"
            } else {
                "FREQ=MONTHLY$iv"
            }
            CustomUnit.Year -> "FREQ=YEARLY$iv"
        }
    }

    private fun bydayOrStart(byday: List<String>, weekday: String): String =
        byday.ifEmpty { listOf(weekday) }.joinToString(",")

    /**
     * Parse an existing RRULE back into picker state (best-effort).
     *
     * Common interval / yearly / monthly-nth-weekday rules map onto the friendly custom
     * builder; anything it can't represent (COUNT, UNTIL, multi-clause BY…) is preserved
     * verbatim as an advanced custom rule so it stays editable and round-trips untouched.
     */
    fun parseRepeat(rrule: String?): RepeatState {
        if (rrule.isNullOrEmpty()) return RepeatState.NONE
        val raw = stripPrefix(rrule)
        val parts = ruleParts(raw)
        val freq = parts["FREQ"].orEmpty()
        val byday = parts["BYDAY"]?.split(",").orEmpty()
        val plainByday = byday.filter { it in plainDay }
        val interval = parts["INTERVAL"]?.toIntOrNull()?.let { maxOf(1, it) } ?: 1
        val bounded = parts.containsKey("COUNT") || parts.containsKey("UNTIL")

        // Simple presets — interval 1, no COUNT/UNTIL.
        if (!bounded && interval == 1) {
            if (freq == "DAILY" && parts["BYDAY"] == null) return RepeatState(freq = RepeatFreq.Daily)
            if (freq == "WEEKLY") {
                if (byday.joinToString(",") == WEEKDAY_SET) return RepeatState(freq = RepeatFreq.Weekdays)
                if (byday.isNotEmpty() && byday.all { it in plainDay }) {
                    return RepeatState(freq = RepeatFreq.Weekly, byday = byday)
                }
            }
            if (freq == "MONTHLY" && parts["BYDAY"] == null && parts["BYMONTHDAY"] == null) {
                return RepeatState(freq = RepeatFreq.Monthly)
            }
        }

        // The friendly custom builder — interval > 1, yearly, or monthly-by-weekday; still
        // no COUNT/UNTIL (those need the advanced rule).
        if (!bounded) {
            if (freq == "DAILY" && parts["BYDAY"] == null) {
                return RepeatState(freq = RepeatFreq.Custom, interval = interval, unit = CustomUnit.Day)
            }
            if (freq == "WEEKLY" && (parts["BYDAY"] == null || plainByday.size == byday.size)) {
                return RepeatState(
                    freq = RepeatFreq.Custom,
                    byday = plainByday,
                    interval = interval,
                    unit = CustomUnit.Week,
                )
            }
            if (freq == "MONTHLY" && parts["BYDAY"] == null && parts["BYMONTHDAY"] == null) {
                return RepeatState(
                    freq = RepeatFreq.Custom,
                    interval = interval,
                    unit = CustomUnit.Month,
                    monthlyMode = MonthlyMode.DayOfMonth,
                )
            }
            val ord = parts["BYDAY"]?.let(::nthWeekdayOrdinal)
            if (freq == "MONTHLY" && ord != null) {
                return RepeatState(
                    freq = RepeatFreq.Custom,
                    interval = interval,
                    unit = CustomUnit.Month,
                    monthlyMode = MonthlyMode.NthWeekday,
                    monthlyOrdinal = ord,
                )
            }
            if (freq == "YEARLY") {
                return RepeatState(freq = RepeatFreq.Custom, interval = interval, unit = CustomUnit.Year)
            }
        }

        // Anything else → preserve the raw rule in the advanced field.
        return RepeatState(freq = RepeatFreq.Custom, custom = raw)
    }

    /**
     * Plain-English description of a rule (the picker's live summary). [start] gives the
     * monthly nth-weekday phrasing a weekday name. Falls back to the raw rule for shapes it
     * doesn't recognise, so the summary is never empty for a real rule.
     */
    fun describeRrule(rule: String?, start: LocalDate): String {
        if (rule.isNullOrEmpty()) return "Does not repeat"
        val parts = ruleParts(stripPrefix(rule))
        val freq = parts["FREQ"].orEmpty()
        val n = parts["INTERVAL"]?.toIntOrNull()?.let { maxOf(1, it) } ?: 1
        val byday = parts["BYDAY"]?.split(",").orEmpty()
        fun every(unit: String) = if (n == 1) "Every $unit" else "Every $n ${unit}s"

        val base: String = when {
            freq == "DAILY" && parts["BYDAY"] == null -> every("day")

            freq == "WEEKLY" && byday.joinToString(",") == WEEKDAY_SET ->
                if (n == 1) "Every weekday (Mon–Fri)" else "Every $n weeks on Mon–Fri"

            freq == "WEEKLY" && byday.isNotEmpty() && byday.all { it in plainDay } ->
                "${every("week")} on ${dayList(byday)}"

            freq == "WEEKLY" && parts["BYDAY"] == null ->
                "${every("week")} on ${dayName[weekdayCode(start)].orEmpty()}"

            freq == "MONTHLY" && parts["BYDAY"] != null -> describeMonthlyByday(parts["BYDAY"]!!, ::every)

            freq == "MONTHLY" && parts["BYMONTHDAY"] == null -> every("month")

            freq == "YEARLY" -> every("year")

            else -> null
        } ?: return rule // unrecognised — show the raw rule

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

    /** Strip a leading `RRULE:` (case-insensitive) and surrounding whitespace. */
    private fun stripPrefix(value: String): String =
        value.trim().removePrefix("RRULE:").removePrefix("rrule:").trim()

    private fun ruleParts(raw: String): Map<String, String> =
        raw.uppercase().split(";").mapNotNull { segment ->
            val kv = segment.split("=", limit = 2)
            if (kv.size == 2) kv[0] to kv[1] else null
        }.toMap()

    private fun dayList(codes: List<String>): String =
        codes.joinToString(", ") { dayName[it] ?: it }

    /**
     * The ordinal in a single `<n><WD>` BYDAY token ("2TU" → 2, "-1FR" → -1), or null if it
     * isn't a single nth-weekday token.
     */
    fun nthWeekdayOrdinal(byday: String): Int? {
        val token = byday.uppercase()
        if (!nthWeekdayToken.matches(token)) return null
        return token.dropLast(2).toIntOrNull()
    }
}
