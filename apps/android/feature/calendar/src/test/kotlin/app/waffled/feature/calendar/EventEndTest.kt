package app.waffled.feature.calendar

import app.waffled.core.sync.EventBucketing
import app.waffled.core.sync.SyncedEvent
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertEquals

/**
 * The event editor's Ends field — the twin of `apps/ios/Tests/EventEndTests.swift`.
 *
 * All-day events store an EXCLUSIVE end (the day after the last day), the same shape Google
 * sends, so `EventBucketing.dayKeys` spreads an event made here exactly like a synced trip.
 * Timed events keep their length as the source of truth so moving the start keeps it.
 */
class EventEndTest {

    private val denver: ZoneId = ZoneId.of("America/Denver")
    private fun d(s: String) = LocalDate.parse(s)
    private fun local(day: String, hour: Int = 0): Instant =
        d(day).atTime(hour, 0).atZone(denver).toInstant()

    @Test
    fun anAllDayEndIsNoonOnTheDayAfterTheLastDay() {
        assertEquals(local("2026-07-31", hour = 12), EventEnd.allDayExclusiveEnd(d("2026-07-30"), denver))
    }

    @Test
    fun editingASyncedTripStartsFromItsLastDay() {
        val last = EventEnd.allDayLastDay(
            start = Instant.parse("2026-07-27T06:00:00Z"),
            end = Instant.parse("2026-08-03T06:00:00Z"),
            zone = denver,
        )
        assertEquals(d("2026-08-02"), last)
    }

    @Test
    fun aOneDayOrOpenEndedAllDayEventEndsOnItsStartDay() {
        val start = local("2026-07-11", hour = 12)
        assertEquals(d("2026-07-11"), EventEnd.allDayLastDay(start, null, denver))
        assertEquals(d("2026-07-11"), EventEnd.allDayLastDay(start, local("2026-07-12", hour = 12), denver))
    }

    @Test
    fun aMadeHereTripSpreadsLikeASyncedOne() {
        val start = local("2026-07-27", hour = 12)
        val end = EventEnd.allDayExclusiveEnd(d("2026-07-30"), denver)
        val ev = SyncedEvent(
            id = "t", householdId = "h", title = "t",
            startsAt = start.toString(), endsAt = end.toString(), allDay = true,
        )
        assertEquals(
            listOf("2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30").map(::d),
            EventBucketing.dayKeys(ev, denver),
        )
    }

    @Test
    fun everyWhenPillReadsTheSameWay() {
        val us = Locale.US
        assertEquals("Sep 14, 2026", EventEnd.dayLabel(d("2026-09-14"), us))
        assertEquals("Sep 17, 2026", EventEnd.dayLabel(d("2026-09-17"), us))
        assertEquals("5:00 PM", EventEnd.timeLabel(LocalTime.of(17, 0), us).replace(' ', ' '))
    }

    @Test
    fun theTimedEndsPickerMapsToWholeMinutesWithAFloor() {
        val start = local("2026-07-11", hour = 17)
        assertEquals(90, EventEnd.minutes(start, start.plusSeconds(90 * 60)))
        assertEquals(15, EventEnd.minutes(start, start.minusSeconds(3600)))
        assertEquals(26 * 60, EventEnd.minutes(start, start.plusSeconds(26 * 3600)))
        // Rounded, not truncated: a 59.6-minute event must not reopen as 59.
        assertEquals(60, EventEnd.minutes(start, start.plusSeconds(3576)))
    }
}
