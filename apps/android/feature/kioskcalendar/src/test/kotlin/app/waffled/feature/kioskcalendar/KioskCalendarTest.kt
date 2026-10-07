package app.waffled.feature.kioskcalendar

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.Person
import app.waffled.core.sync.EventBucketing
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.calendar.Agenda
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.EventPeople
import app.waffled.feature.calendar.EventRow
import app.waffled.feature.kioskcalendar.KioskCalendar.Mode
import app.waffled.feature.kioskcalendar.KioskCalendar.Position
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// The iPad calendar's rules, lifted out of iOS `KioskCalendarView.swift` (and its
// `CalTimeGrid`). iOS has no unit tests for that view — these are written fresh from its
// code, not translated. People bucketing and the span/chip-cap rules it reuses are already
// covered by `feature:calendar` (PeopleColumnsTest, PhoneCalendarLayoutTest).

private val ny: ZoneId = ZoneId.of("America/New_York")
private fun d(key: String): LocalDate = LocalDate.parse(key)

private fun timedEvent(
    id: String,
    start: String,
    minutes: Long? = 60,
    personId: String? = null,
): SyncedEvent {
    val s = LocalDateTime.parse(start.replace(' ', 'T'))
    return SyncedEvent(
        id = id,
        householdId = "h",
        title = id,
        startsAt = s.atZone(ny).toInstant().toString(),
        endsAt = minutes?.let { s.plusMinutes(it).atZone(ny).toInstant().toString() },
        personId = personId,
    )
}

private fun allDayEvent(id: String, day: String): SyncedEvent =
    SyncedEvent(id = id, householdId = "h", title = id, startsAt = day, endsAt = null, allDay = true)

private fun rowsOf(
    vararg events: SyncedEvent,
    participants: Map<String, Set<String>> = emptyMap(),
    colors: Map<String, String> = emptyMap(),
): Map<LocalDate, List<EventRow>> =
    Agenda.buildRows(EventBucketing.byDay(events.toList(), ny), ny) { e ->
        EventPeople(
            ownerPersonId = e.personId,
            ownerColorHex = e.personId?.let(colors::get),
            participantIds = participants[e.id].orEmpty(),
        )
    }

class KioskCalendarModeTest {
    @Test
    fun theFiveModesInIPadOrder() {
        assertEquals(listOf("Month", "Week", "Day", "People", "Agenda"), Mode.entries.map { it.label })
    }

    @Test
    fun agendaHasNoSteppersAndPeopleHasNoPersonFilter() {
        assertFalse(Mode.Agenda.showsSteppers)
        assertTrue(Mode.entries.filter { it != Mode.Agenda }.all { it.showsSteppers })
        assertFalse(Mode.People.showsPersonFilter)
        assertTrue(Mode.entries.filter { it != Mode.People }.all { it.showsPersonFilter })
    }
}

class KioskCalendarNavigationTest {
    private val start = Position(monthAnchor = d("2026-09-15"), selectedDay = d("2026-09-15"))

    @Test
    fun monthStepsTheAnchorAndLeavesTheSelectedDay() {
        val next = KioskCalendar.step(Mode.Month, start, 1)
        assertEquals(d("2026-10-15"), next.monthAnchor)
        assertEquals(d("2026-09-15"), next.selectedDay)
        assertEquals(d("2026-08-15"), KioskCalendar.step(Mode.Month, start, -1).monthAnchor)
    }

    @Test
    fun weekStepsSevenDaysAndDayAndPeopleStepOne() {
        assertEquals(d("2026-09-22"), KioskCalendar.step(Mode.Week, start, 1).selectedDay)
        assertEquals(d("2026-09-08"), KioskCalendar.step(Mode.Week, start, -1).selectedDay)
        assertEquals(d("2026-09-16"), KioskCalendar.step(Mode.Day, start, 1).selectedDay)
        assertEquals(d("2026-09-14"), KioskCalendar.step(Mode.People, start, -1).selectedDay)
        assertEquals(start.monthAnchor, KioskCalendar.step(Mode.Week, start, 1).monthAnchor)
    }

    @Test
    fun agendaDoesNotStep() {
        assertEquals(start, KioskCalendar.step(Mode.Agenda, start, 1))
    }

    @Test
    fun todayResetsBothAnchors() {
        assertEquals(Position(d("2026-10-07"), d("2026-10-07")), KioskCalendar.jumpToToday(d("2026-10-07")))
    }

    @Test
    fun titlesFollowTheMode() {
        val today = d("2026-10-07")
        val us = Locale.US
        val pos = Position(monthAnchor = d("2026-09-01"), selectedDay = d("2026-09-16"))
        assertEquals("September 2026", KioskCalendar.navTitle(Mode.Month, pos, today, HouseholdWeekStart.Sunday, us))
        // Month named on both ends, even within one month — unlike the phone's compact title.
        assertEquals("Sep 13 – Sep 19", KioskCalendar.navTitle(Mode.Week, pos, today, HouseholdWeekStart.Sunday, us))
        assertEquals("Sep 14 – Sep 20", KioskCalendar.navTitle(Mode.Week, pos, today, HouseholdWeekStart.Monday, us))
        assertEquals("Wednesday, Sep 16", KioskCalendar.navTitle(Mode.Day, pos, today, HouseholdWeekStart.Sunday, us))
        assertEquals("Wednesday, Sep 16", KioskCalendar.navTitle(Mode.People, pos, today, HouseholdWeekStart.Sunday, us))
        assertEquals("Wed, October 7", KioskCalendar.navTitle(Mode.Agenda, pos, today, HouseholdWeekStart.Sunday, us))
    }

    @Test
    fun relativeLabels() {
        val today = d("2026-10-07")
        assertEquals("Today", KioskCalendar.relativeLabel(today, today, Locale.US))
        assertEquals("Tomorrow", KioskCalendar.relativeLabel(d("2026-10-08"), today, Locale.US))
        assertEquals("Friday", KioskCalendar.relativeLabel(d("2026-10-09"), today, Locale.US))
        assertEquals("Monday", KioskCalendar.relativeLabel(d("2026-10-05"), today, Locale.US))
    }
}

class KioskCalendarMonthTest {
    @Test
    fun alwaysSixRowsOfSevenCutOnTheHouseholdWeekStart() {
        val rows = KioskCalendar.monthRows(d("2026-09-20"), HouseholdWeekStart.Monday)
        assertEquals(6, rows.size)
        assertTrue(rows.all { it.size == 7 })
        assertEquals(d("2026-08-31"), rows.first().first().date)
        assertFalse(rows.first().first().inMonth)
        assertTrue(rows.first()[1].inMonth)

        val sunday = KioskCalendar.monthRows(d("2026-09-20"), HouseholdWeekStart.Sunday)
        assertEquals(d("2026-08-30"), sunday.first().first().date)
    }

    @Test
    fun weekdayHeadersRotateWithTheWeekStart() {
        assertEquals("Mon", KioskCalendar.weekdayHeaders(HouseholdWeekStart.Monday).first())
        assertEquals("Sun", KioskCalendar.weekdayHeaders(HouseholdWeekStart.Monday).last())
        assertEquals(listOf("S", "M", "T", "W", "T", "F", "S"), KioskCalendar.miniWeekdayHeaders(HouseholdWeekStart.Sunday))
        assertEquals("M", KioskCalendar.miniWeekdayHeaders(HouseholdWeekStart.Monday).first())
    }

    @Test
    fun spanBarsReserveTheIPadLaneHeight() {
        assertEquals(0f, KioskCalendar.spanReservedHeight(0))
        assertEquals(18f, KioskCalendar.spanReservedHeight(1))
        assertEquals(39f, KioskCalendar.spanReservedHeight(2))
    }

    @Test
    fun spanBarTopForEachLane() {
        assertEquals(34f, KioskCalendar.spanBarTop(0))
        assertEquals(55f, KioskCalendar.spanBarTop(1))
    }

    @Test
    fun miniMonthDotsAreDistinctAndKeepAnUnassignedDot() {
        val rows = rowsOf(
            timedEvent("a", "2026-09-16 09:00", personId = "p1"),
            timedEvent("b", "2026-09-16 10:00", personId = "p1"),
            timedEvent("c", "2026-09-16 11:00", personId = "p2"),
            timedEvent("d", "2026-09-16 12:00"),
            colors = mapOf("p1" to "#2F7FED", "p2" to "#E0548B"),
        )
        assertEquals(listOf("#2F7FED", "#E0548B", null), KioskCalendar.dotColors(rows[d("2026-09-16")].orEmpty()))
    }
}

class KioskCalendarAgendaTest {
    private val today = d("2026-10-07")

    @Test
    fun agendaDaysMergeEventDaysWithCountdownDaysFromToday() {
        val days = KioskCalendar.agendaDays(
            eventDays = setOf(d("2026-10-07"), d("2026-10-10")),
            countdownDates = setOf("2026-10-09", "2026-10-10", "2026-10-01", "nonsense"),
            today = today,
        )
        assertEquals(listOf(d("2026-10-07"), d("2026-10-09"), d("2026-10-10")), days)
    }

    @Test
    fun busyRowsCountOwnersAndParticipantsOncePerEventSortedBusiestFirst() {
        val people = listOf(Person(id = "p1", name = "Jerry"), Person(id = "p2", name = "Elaine"), Person(id = "p3", name = "Kramer"))
        val rows = rowsOf(
            timedEvent("a", "2026-10-07 09:00", personId = "p1"),
            timedEvent("b", "2026-10-08 09:00", personId = "p2"),
            timedEvent("c", "2026-10-09 09:00", personId = "p2"),
            // Owner also listed as a participant: still one count.
            timedEvent("d", "2026-10-09 10:00", personId = "p2"),
            // Outside the week.
            timedEvent("e", "2026-10-20 09:00", personId = "p1"),
            participants = mapOf("d" to setOf("p2", "p1")),
        )
        val week = KioskCalendar.weekDays(today, HouseholdWeekStart.Sunday)
        val busy = KioskCalendar.busyRows(rows, week, people)
        assertEquals(listOf("p2" to 3, "p1" to 2), busy.map { it.person.id to it.count })
    }

    @Test
    fun countdownsRouteByTheirSource() {
        val rows = rowsOf(timedEvent("e1", "2026-10-09 09:00"))
        fun cd(id: String, source: String) =
            CalendarApi.Countdown(id = id, title = id, date = "2026-10-09", daysLeft = 2, source = source)

        val standalone = cd("s1", "standalone")
        assertEquals(KioskCalendar.CountdownTarget.Edit(standalone), KioskCalendar.route(standalone, rows))
        val target = KioskCalendar.route(cd("e1", "event"), rows)
        assertTrue(target is KioskCalendar.CountdownTarget.Detail && target.row.id == "e1")
        assertEquals(KioskCalendar.CountdownTarget.None, KioskCalendar.route(cd("gone", "event"), rows))
        assertEquals(KioskCalendar.CountdownTarget.None, KioskCalendar.route(cd("b1", "birthday"), rows))
    }
}

class KioskTimeGridTest {
    @Test
    fun hourLabels() {
        assertEquals("12 AM", KioskCalendar.hourLabel(0))
        assertEquals("9 AM", KioskCalendar.hourLabel(9))
        assertEquals("12 PM", KioskCalendar.hourLabel(12))
        assertEquals("11 PM", KioskCalendar.hourLabel(23))
    }

    @Test
    fun blockSitsAtItsStartAndSpansItsDuration() {
        val row = rowsOf(timedEvent("a", "2026-10-07 09:30", minutes = 90)).values.first().first()
        val b = KioskCalendar.block(row, ny)!!
        assertEquals(9.5f * 56f, b.y)
        assertEquals(1.5f * 56f - 3f, b.height)
    }

    @Test
    fun shortAndOpenEndedBlocksStayReadable() {
        val short = rowsOf(timedEvent("a", "2026-10-07 09:00", minutes = 10)).values.first().first()
        assertEquals(0.5f * 56f - 3f, KioskCalendar.block(short, ny)!!.height)
        val open = rowsOf(timedEvent("b", "2026-10-07 09:00", minutes = null)).values.first().first()
        assertEquals(56f - 3f, KioskCalendar.block(open, ny)!!.height)
        // The 26dp floor only bites on a smaller hour height.
        assertEquals(26f, KioskCalendar.block(short, ny, hourHeight = 20f)!!.height)
    }

    @Test
    fun nowLineOffset() {
        val at = LocalDateTime.parse("2026-10-07T14:15").atZone(ny).toInstant()
        assertEquals(14.25f * 56f, KioskCalendar.nowOffset(at, ny))
    }

    @Test
    fun peopleGridOpensAnHourBeforeTheFirstTimedEventElseSeven() {
        val rows = rowsOf(
            timedEvent("late", "2026-10-07 15:00"),
            timedEvent("early", "2026-10-07 10:30"),
            allDayEvent("trip", "2026-10-07"),
        )[d("2026-10-07")].orEmpty()
        assertEquals(9, KioskCalendar.peopleScrollHour(rows, ny))
        assertEquals(7, KioskCalendar.peopleScrollHour(emptyList(), ny))
        val midnight = rowsOf(timedEvent("m", "2026-10-07 00:15"))[d("2026-10-07")].orEmpty()
        assertEquals(0, KioskCalendar.peopleScrollHour(midnight, ny))
    }

    @Test
    fun allDaySeparatorsFitTheTallestStack() {
        assertEquals(24f, KioskCalendar.allDayContentHeight(listOf(0, 0)))
        assertEquals(24f, KioskCalendar.allDayContentHeight(listOf(1)))
        assertEquals(3 * 24f + 2 * 3f, KioskCalendar.allDayContentHeight(listOf(1, 3, 2)))
    }

    @Test
    fun weekGridShowsTheNowLineOnlyWhenTodayIsVisible() {
        val today = d("2026-10-07")
        assertTrue(KioskCalendar.showsNowLine(KioskCalendar.weekDays(today, HouseholdWeekStart.Sunday), today))
        assertFalse(KioskCalendar.showsNowLine(listOf(d("2026-10-20")), today))
    }
}
