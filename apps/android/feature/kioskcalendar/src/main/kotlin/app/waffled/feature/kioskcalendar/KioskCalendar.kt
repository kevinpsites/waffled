package app.waffled.feature.kioskcalendar

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.Person
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CalendarModel
import app.waffled.feature.calendar.EventRow
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

object KioskCalendar {
    enum class Mode(val label: String) {
        Month("Month"), Week("Week"), Day("Day"), People("People"), Agenda("Agenda");

        val showsSteppers: Boolean get() = true
        val showsPersonFilter: Boolean get() = true
    }

    data class Position(val monthAnchor: LocalDate, val selectedDay: LocalDate)

    fun step(mode: Mode, pos: Position, n: Int): Position = pos
    fun jumpToToday(today: LocalDate): Position = Position(today, today.minusDays(1))
    fun navTitle(mode: Mode, pos: Position, today: LocalDate, firstDay: HouseholdWeekStart, locale: Locale = Locale.getDefault()): String = ""
    fun relativeLabel(day: LocalDate, today: LocalDate, locale: Locale = Locale.getDefault()): String = ""
    fun weekDays(day: LocalDate, firstDay: HouseholdWeekStart): List<LocalDate> = emptyList()
    fun monthRows(anchor: LocalDate, firstDay: HouseholdWeekStart): List<List<CalendarModel.MonthCell>> = emptyList()
    fun weekdayHeaders(firstDay: HouseholdWeekStart): List<String> = listOf("")
    fun miniWeekdayHeaders(firstDay: HouseholdWeekStart): List<String> = listOf("")
    fun spanReservedHeight(lanes: Int): Float = -1f
    fun spanBarTop(lane: Int): Float = -1f
    fun dotColors(rows: List<EventRow>): List<String?> = emptyList()
    fun agendaDays(eventDays: Set<LocalDate>, countdownDates: Set<String>, today: LocalDate): List<LocalDate> = emptyList()

    data class BusyRow(val person: Person, val count: Int)

    fun busyRows(byDay: Map<LocalDate, List<EventRow>>, week: List<LocalDate>, members: List<Person>): List<BusyRow> = emptyList()

    sealed interface CountdownTarget {
        data class Edit(val countdown: CalendarApi.Countdown) : CountdownTarget
        data class Detail(val row: EventRow) : CountdownTarget
        data object None : CountdownTarget
    }

    fun route(countdown: CalendarApi.Countdown, rows: Map<LocalDate, List<EventRow>>): CountdownTarget = CountdownTarget.None
    fun hourLabel(hour: Int): String = ""

    data class Block(val y: Float, val height: Float)

    fun block(row: EventRow, zone: ZoneId, hourHeight: Float = 56f): Block? = Block(0f, 0f)
    fun nowOffset(at: Instant, zone: ZoneId, hourHeight: Float = 56f): Float = -1f
    fun peopleScrollHour(rows: List<EventRow>, zone: ZoneId): Int = -1
    fun allDayContentHeight(counts: List<Int>): Float = -1f
    fun showsNowLine(days: List<LocalDate>, today: LocalDate): Boolean = false
}
