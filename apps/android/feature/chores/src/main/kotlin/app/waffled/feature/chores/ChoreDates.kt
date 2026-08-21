package app.waffled.feature.chores

import app.waffled.core.model.WaffledDates
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.abs

/**
 * The day stepper's pure date helpers — the twin of iOS `ChoreDates`.
 *
 * Two deliberate differences from the Swift original:
 *  - "today" is a **parameter**, not a hidden `Date()` read, so every rule here is
 *    testable rather than clock-dependent;
 *  - the labels are computed once per load (see [ChoreRow]) and looked up by the row,
 *    keeping date math out of the render hot path.
 */
object ChoreDates {

    /** The wire format for a chore day. */
    const val DAY_PATTERN = "yyyy-MM-dd"

    /** What the header says about the day being viewed. */
    data class DayMeta(
        /** "Today" / "Tomorrow" / "In 3 days". */
        val relative: String,
        /** "Friday, Aug 21". */
        val full: String,
        val isToday: Boolean,
    )

    /** Today in [zone], in wire format. */
    fun today(zone: ZoneId = ZoneId.systemDefault()): String = LocalDate.now(zone).toString()

    /** Step [date] by [days]. An unparseable date is returned unchanged. */
    fun shift(date: String, days: Int): String =
        parse(date)?.plusDays(days.toLong())?.toString() ?: date

    /** The header's relative + full labels for [date], relative to [today]. */
    fun meta(
        date: String,
        today: LocalDate,
        locale: Locale = Locale.getDefault(),
    ): DayMeta {
        val day = parse(date) ?: return DayMeta(relative = "", full = date, isToday = true)
        val diff = ChronoUnit.DAYS.between(today, day).toInt()
        val relative = when {
            diff == 0 -> "Today"
            diff == 1 -> "Tomorrow"
            diff == -1 -> "Yesterday"
            diff > 0 -> "In $diff days"
            else -> "${abs(diff)} days ago"
        }
        return DayMeta(
            relative = relative,
            full = format(day, "EEEE, MMM d", locale),
            isToday = diff == 0,
        )
    }

    /**
     * The "since …" suffix for a carried-forward one-off whose [dueOn] is before the day
     * being viewed (web parity: `Tasks.tsx` `overdueLabel`). Null when it isn't overdue.
     */
    fun overdueLabel(
        dueOn: String?,
        viewing: String,
        locale: Locale = Locale.getDefault(),
    ): String? {
        val days = daysBetween(from = dueOn, to = viewing) ?: return null
        return when {
            days < 1 -> null
            days == 1L -> "since yesterday"
            days < 7 -> "since ${format(parse(dueOn)!!, "EEE", locale)}"
            else -> "since ${format(parse(dueOn)!!, "MMM d", locale)}"
        }
    }

    /**
     * The calm "due …" hint for a future-dated one-off that is already on the list (web
     * parity: `Tasks.tsx` `upcomingLabel`). Null once the due day is today or past —
     * that is the overdue case.
     */
    fun upcomingLabel(
        dueOn: String?,
        viewing: String,
        locale: Locale = Locale.getDefault(),
    ): String? {
        val days = daysBetween(from = viewing, to = dueOn) ?: return null
        return when {
            days < 1 -> null
            days == 1L -> "due tomorrow"
            days < 7 -> "due ${format(parse(dueOn)!!, "EEE", locale)}"
            else -> "due ${format(parse(dueOn)!!, "MMM d", locale)}"
        }
    }

    /** Render a stored `HH:mm` as a friendly "4:30 PM". Null for empty or unparseable input. */
    fun timeLabel(hhmm: String?, locale: Locale = Locale.getDefault()): String? {
        val raw = hhmm?.trim().orEmpty()
        if (raw.isEmpty()) return null
        val time = runCatching { LocalTime.parse(raw) }.getOrNull() ?: return null
        // Formatted through the shared cached formatter — never build one per row.
        return WaffledDates.formatter("h:mm a", UTC, locale)
            .format(time.atDate(EPOCH_DAY).atZone(UTC))
    }

    private fun parse(date: String?): LocalDate? =
        runCatching { LocalDate.parse(date?.trim().orEmpty()) }.getOrNull()

    private fun daysBetween(from: String?, to: String?): Long? {
        val start = parse(from) ?: return null
        val end = parse(to) ?: return null
        return ChronoUnit.DAYS.between(start, end)
    }

    private fun format(day: LocalDate, pattern: String, locale: Locale): String =
        WaffledDates.formatter(pattern, UTC, locale).format(day.atStartOfDay(UTC))

    /**
     * A chore day is a plain calendar date, so formatting it must not go through a real
     * timezone — attaching one is exactly how a date-only value slides onto the adjacent
     * day. UTC here is a formatting fixture, not a household timezone.
     */
    private val UTC: ZoneId = ZoneId.of("UTC")
    private val EPOCH_DAY: LocalDate = LocalDate.of(1970, 1, 1)
}
