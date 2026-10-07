package app.waffled.feature.kioskcalendar

import androidx.compose.runtime.Immutable
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.Person
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CalendarModel
import app.waffled.feature.calendar.CountdownFormat
import app.waffled.feature.calendar.EventRow
import app.waffled.feature.calendar.PhoneCalendar
import app.waffled.feature.calendar.TimeLanes
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The tablet calendar's rules — Month / Week / Day / People / Agenda — kept out of the
 * composables so they can be tested. Twin of the logic inside iOS `KioskCalendarView` and
 * its `CalTimeGrid`; the bucketing and span rules come from `feature:calendar`.
 */
object KioskCalendar {

    /** People is tablet-only: a phone column is too narrow to read. */
    enum class Mode(val label: String) {
        Month("Month"), Week("Week"), Day("Day"), People("People"), Agenda("Agenda");

        val showsSteppers: Boolean get() = this != Agenda

        /** People's columns already ARE the per-person split, so a filter on top is redundant. */
        val showsPersonFilter: Boolean get() = this != People
    }

    /** Month pages by [monthAnchor]; Week, Day and People page by [selectedDay]. */
    @Immutable
    data class Position(val monthAnchor: LocalDate, val selectedDay: LocalDate)

    fun step(mode: Mode, pos: Position, n: Int): Position = when (mode) {
        Mode.Month -> pos.copy(monthAnchor = pos.monthAnchor.plusMonths(n.toLong()))
        Mode.Week -> pos.copy(selectedDay = pos.selectedDay.plusDays(7L * n))
        Mode.Day, Mode.People -> pos.copy(selectedDay = pos.selectedDay.plusDays(n.toLong()))
        Mode.Agenda -> pos
    }

    fun jumpToToday(today: LocalDate): Position = Position(today, today)

    private fun fmt(day: LocalDate, pattern: String, locale: Locale): String =
        DateTimeFormatter.ofPattern(pattern, locale).format(day)

    fun navTitle(
        mode: Mode,
        pos: Position,
        today: LocalDate,
        firstDay: HouseholdWeekStart,
        locale: Locale = Locale.getDefault(),
    ): String = when (mode) {
        Mode.Month -> fmt(pos.monthAnchor, "MMMM yyyy", locale)
        Mode.Week -> {
            val days = weekDays(pos.selectedDay, firstDay)
            "${fmt(days.first(), "MMM d", locale)} – ${fmt(days.last(), "MMM d", locale)}"
        }
        Mode.Day, Mode.People -> fmt(pos.selectedDay, "EEEE, MMM d", locale)
        Mode.Agenda -> fmt(today, "EEE, MMMM d", locale)
    }

    fun relativeLabel(day: LocalDate, today: LocalDate, locale: Locale = Locale.getDefault()): String = when (day) {
        today -> "Today"
        today.plusDays(1) -> "Tomorrow"
        else -> fmt(day, "EEEE", locale)
    }

    fun weekDays(day: LocalDate, firstDay: HouseholdWeekStart): List<LocalDate> = PhoneCalendar.weekDays(day, firstDay)

    /** Always six rows, so the grid's height never jumps as you page. */
    fun monthRows(anchor: LocalDate, firstDay: HouseholdWeekStart): List<List<CalendarModel.MonthCell>> =
        CalendarModel.monthCells(anchor, firstDay).chunked(7)

    private val SUNDAY_FIRST_SHORT = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

    fun weekdayHeaders(firstDay: HouseholdWeekStart): List<String> = firstDay.rotated(SUNDAY_FIRST_SHORT)

    fun miniWeekdayHeaders(firstDay: HouseholdWeekStart): List<String> = CalendarModel.weekdayInitials(firstDay)

    // The tablet cell: 7dp padding, a 24dp day number and 3dp stack spacing put lane 0 at 34.
    const val SPAN_TOP: Float = 34f
    const val SPAN_HEIGHT: Float = 18f
    const val SPAN_GAP: Float = 3f
    const val SPAN_SPACING: Float = 6f
    const val SPAN_INSET: Float = 5f

    /** iOS `MonthSpanBars.reservedHeight(lanes:kiosk: true)`. */
    fun spanReservedHeight(lanes: Int): Float =
        if (lanes > 0) lanes * SPAN_HEIGHT + (lanes - 1) * SPAN_GAP else 0f

    fun spanBarTop(lane: Int): Float = SPAN_TOP + lane * (SPAN_HEIGHT + SPAN_GAP)

    /** Month cells cap at three chips, less the row's bar lanes. */
    const val CELL_CHIP_CAP: Int = 3

    /**
     * Distinct colours for the mini-month dots; whole-family events already resolve to the
     * family colour. `null` is unassigned — the view paints it grey rather than dropping it.
     */
    fun dotColors(rows: List<EventRow>): List<String?> = rows.map { it.colorHex }.distinct()

    /** Event days ∪ countdown days, today forward, so a countdown-only day still appears. */
    fun agendaDays(eventDays: Set<LocalDate>, countdownDates: Set<String>, today: LocalDate): List<LocalDate> {
        val countdownDays = countdownDates.mapNotNull(CountdownFormat::parse).filter { !it.isBefore(today) }
        return (eventDays + countdownDays).sorted()
    }

    @Immutable
    data class BusyRow(val person: Person, val count: Int)

    /** "Whose week is busy?": events per member this week, counting owner ∪ participants once. */
    fun busyRows(byDay: Map<LocalDate, List<EventRow>>, week: List<LocalDate>, members: List<Person>): List<BusyRow> {
        val counts = HashMap<String, Int>()
        for (day in week) {
            for (row in byDay[day].orEmpty()) {
                for (id in row.people.allPersonIds) counts[id] = (counts[id] ?: 0) + 1
            }
        }
        return members.mapNotNull { m -> counts[m.id]?.takeIf { it > 0 }?.let { BusyRow(m, it) } }
            .sortedByDescending { it.count }
    }

    sealed interface CountdownTarget {
        data class Edit(val countdown: CalendarApi.Countdown) : CountdownTarget
        data class Detail(val row: EventRow) : CountdownTarget
        data object None : CountdownTarget
    }

    /**
     * A tapped countdown: standalone → its editor; event-sourced (its id IS the event's) →
     * that event's detail; a birthday → nowhere, it lives on the person's profile.
     */
    fun route(countdown: CalendarApi.Countdown, rows: Map<LocalDate, List<EventRow>>): CountdownTarget =
        when (countdown.source) {
            "standalone" -> CountdownTarget.Edit(countdown)
            "event" -> rows.values.asSequence().flatten().firstOrNull { it.id == countdown.id }
                ?.let { CountdownTarget.Detail(it) } ?: CountdownTarget.None
            else -> CountdownTarget.None
        }

    // ---- time grid (Week / Day / People) ----------------------------------------------

    const val HOUR_HEIGHT: Float = 56f
    const val GUTTER: Float = 56f
    const val ALL_DAY_CHIP_HEIGHT: Float = 24f
    const val ALL_DAY_CHIP_GAP: Float = 3f
    const val DEFAULT_OPENING_HOUR: Int = 7

    fun hourLabel(hour: Int): String {
        val h = if (hour % 12 == 0) 12 else hour % 12
        return "$h ${if (hour < 12) "AM" else "PM"}"
    }

    @Immutable
    data class Block(val y: Float, val height: Float)

    /** A timed block's top and height (dp): at least 30 minutes long, never under 26dp tall. */
    fun block(row: EventRow, zone: ZoneId, hourHeight: Float = HOUR_HEIGHT): Block? {
        val start = row.startsAt ?: return null
        val minutes = Duration.between(start, TimeLanes.end(row)).toMinutes().toFloat()
        return Block(
            y = nowOffset(start, zone, hourHeight),
            height = maxOf(26f, minutes / 60f * hourHeight - 3f),
        )
    }

    fun nowOffset(at: Instant, zone: ZoneId, hourHeight: Float = HOUR_HEIGHT): Float {
        val t = at.atZone(zone)
        return (t.hour + t.minute / 60f) * hourHeight
    }

    /** People opens an hour before the day's first timed event, else at 7 AM. */
    fun peopleScrollHour(rows: List<EventRow>, zone: ZoneId): Int {
        val first = rows.filter { !it.allDay }.mapNotNull { it.startsAt }.minOrNull() ?: return DEFAULT_OPENING_HOUR
        return maxOf(0, first.atZone(zone).hour - 1)
    }

    /** One height for every all-day separator: the tallest column's chip stack. */
    fun allDayContentHeight(counts: List<Int>): Float {
        val n = maxOf(1, counts.maxOrNull() ?: 1)
        return n * ALL_DAY_CHIP_HEIGHT + (n - 1) * ALL_DAY_CHIP_GAP
    }

    fun showsNowLine(days: List<LocalDate>, today: LocalDate): Boolean = today in days
}
