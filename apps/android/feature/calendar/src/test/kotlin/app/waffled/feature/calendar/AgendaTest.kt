package app.waffled.feature.calendar

import app.waffled.core.sync.EventBucketing
import app.waffled.core.sync.SyncedEvent
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The agenda-shaping half of `apps/ios/Tests/EventIndexTests.swift` (`AgendaByDayTests` /
 * `AgendaUpcomingByDayTests`), plus the `isPast` fade rule.
 *
 * ⚠️ Deliberately NOT a second copy of the bucketing. `core:sync` already owns day
 * bucketing and per-viewer visibility ([EventBucketing], `EventVisibility`) and locks them
 * with its own tests; re-implementing either here would give a green suite over a copy the
 * app never renders. What this module adds — and therefore what is tested here — is the
 * agenda ORDER within a day and the upcoming grouping the screen reads.
 */
class AgendaTest {

    private val denver: ZoneId = ZoneId.of("America/Denver")

    private fun event(id: String, startsAt: String?, allDay: Boolean = false, endsAt: String? = null) =
        SyncedEvent(id = id, householdId = "h", title = id, startsAt = startsAt, endsAt = endsAt, allDay = allDay)

    private fun rows(vararg events: SyncedEvent): Map<LocalDate, List<EventRow>> =
        Agenda.buildRows(EventBucketing.byDay(events.toList(), denver), denver)

    @Test
    fun ordersTimedEventsBeforeAllDayAndThenByStart() {
        // 2026-06-16 17:49 UTC = 11:49 in Denver; 2026-06-17 03:00 UTC = June 16 21:00 Denver.
        val byDay = rows(
            event("allday", "2026-06-16", allDay = true),
            event("next", "2026-06-17T18:00:00Z"),
            event("evening", "2026-06-17T03:00:00Z"),
            event("morning", "2026-06-16T17:49:00Z"),
        )

        assertEquals(2, byDay.size)
        assertEquals(
            listOf("morning", "evening", "allday"),
            byDay[LocalDate.of(2026, 6, 16)]?.map { it.id },
        )
        assertEquals(listOf("next"), byDay[LocalDate.of(2026, 6, 17)]?.map { it.id })
    }

    @Test
    fun dropsEventsWithNoResolvableDay() {
        val byDay = rows(event("ghost", null), event("real", "2026-06-16T12:00:00Z"))
        assertEquals(1, byDay.size)
        assertEquals(listOf("real"), byDay[LocalDate.of(2026, 6, 16)]?.map { it.id })
    }

    @Test
    fun upcomingReturnsDaysFromTheCutoffAscendingWithItemOrderPreserved() {
        val byDay = rows(
            event("past", "2026-06-10T12:00:00Z"),
            event("today-late", "2026-06-16T22:00:00Z"),
            event("today-early", "2026-06-16T14:00:00Z"),
            event("future", "2026-06-20T12:00:00Z"),
        )

        val groups = Agenda.upcoming(byDay, from = LocalDate.of(2026, 6, 16))

        assertEquals(listOf(LocalDate.of(2026, 6, 16), LocalDate.of(2026, 6, 20)), groups.map { it.day })
        assertEquals(listOf("today-early", "today-late"), groups[0].items.map { it.id })
    }

    @Test
    fun upcomingIsEmptyWhenEverythingIsPast() {
        val byDay = rows(event("past", "2026-06-10T12:00:00Z"))
        assertTrue(Agenda.upcoming(byDay, from = LocalDate.of(2026, 6, 16)).isEmpty())
    }

    @Test
    fun forDayLooksUpASingleDayWithoutRescanning() {
        val byDay = rows(
            event("a", "2026-06-16T14:00:00Z"),
            event("b", "2026-06-20T12:00:00Z"),
        )
        assertEquals(listOf("a"), Agenda.forDay(byDay, LocalDate.of(2026, 6, 16)).map { it.id })
        assertTrue(Agenda.forDay(byDay, LocalDate.of(2026, 6, 18)).isEmpty())
    }

    // ---- the "already finished" fade -------------------------------------------

    @Test
    fun aTimedEventIsPastOnceItsEndHasGone() {
        val now = Instant.parse("2026-06-16T20:00:00Z")
        val byDay = rows(
            event("done", "2026-06-16T17:00:00Z", endsAt = "2026-06-16T18:00:00Z"),
            event("running", "2026-06-16T19:30:00Z", endsAt = "2026-06-16T21:00:00Z"),
        )
        val day = byDay.getValue(LocalDate.of(2026, 6, 16))
        assertTrue(Agenda.isPast(day.first { it.id == "done" }, denver, now))
        assertFalse(Agenda.isPast(day.first { it.id == "running" }, denver, now))
    }

    @Test
    fun anOpenEndedEventFallsBackToItsStart() {
        val now = Instant.parse("2026-06-16T20:00:00Z")
        val byDay = rows(event("open", "2026-06-16T17:00:00Z"))
        assertTrue(Agenda.isPast(byDay.getValue(LocalDate.of(2026, 6, 16)).first(), denver, now))
    }

    @Test
    fun anAllDayEventIsPastOnlyOnceItsDayIsBehindUs() {
        // 2026-06-17 01:00 UTC is still June 16 in Denver, so today's all-day row must not
        // fade — that is exactly the UTC-bucketing bug the household zone exists to avoid.
        val now = Instant.parse("2026-06-17T01:00:00Z")
        val byDay = rows(
            event("today", "2026-06-16", allDay = true),
            event("yesterday", "2026-06-15", allDay = true),
        )
        assertFalse(Agenda.isPast(byDay.getValue(LocalDate.of(2026, 6, 16)).first(), denver, now))
        assertTrue(Agenda.isPast(byDay.getValue(LocalDate.of(2026, 6, 15)).first(), denver, now))
    }
}
