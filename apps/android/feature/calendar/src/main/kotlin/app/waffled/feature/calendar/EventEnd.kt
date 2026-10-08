package app.waffled.feature.calendar

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.roundToLong

/**
 * The event editor's Ends field — the port of iOS `EventEnd`. An all-day end is EXCLUSIVE,
 * the day after the last day — the same shape Google sends — so `EventBucketing.dayKeys`
 * spreads an event made here exactly like a synced one.
 */
object EventEnd {

    /** Shortest timed event the Ends picker produces. */
    const val MIN_MINUTES: Long = 15

    /**
     * Noon rather than midnight, like the editor's all-day start, so a zone difference
     * between the device and the household can't pull it onto the neighbouring day.
     */
    fun allDayExclusiveEnd(lastDay: LocalDate, zone: ZoneId): Instant =
        lastDay.plusDays(1).atTime(LocalTime.NOON).atZone(zone).toInstant()

    /** The last day an all-day event covers. No end, or one by the start's next day, is one day. */
    fun allDayLastDay(start: Instant, end: Instant?, zone: ZoneId): LocalDate {
        val first = start.atZone(zone).toLocalDate()
        val endDay = end?.atZone(zone)?.toLocalDate() ?: return first
        return if (endDay.isAfter(first)) maxOf(first, endDay.minusDays(1)) else first
    }

    /** A timed event's length from its Ends picker, rounded, never under [MIN_MINUTES]. */
    fun minutes(start: Instant, end: Instant): Long =
        maxOf(MIN_MINUTES, ((end.epochSecond - start.epochSecond) / 60.0).roundToLong())

    /** "Sep 14, 2026" — both date pills read the same way. */
    fun dayLabel(date: LocalDate, locale: Locale = Locale.getDefault()): String =
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale).format(date)

    /** "5:00 PM". */
    fun timeLabel(time: LocalTime, locale: Locale = Locale.getDefault()): String =
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(time)
}
