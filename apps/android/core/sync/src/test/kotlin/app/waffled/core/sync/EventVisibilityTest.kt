package app.waffled.core.sync

import app.waffled.core.model.WaffledDates
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.assertNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * PowerSync streams the WHOLE household's events to every device — the server does not
 * filter per viewer. So the client must, or a personal event shows up on the shared
 * kitchen tablet.
 *
 * Twin of `visibleEvents(_:me:)` on the iOS SyncManager, whose behaviour is locked by
 * `SyncLogicTests.swift`.
 */
class EventVisibilityTest {

    private fun event(
        id: String,
        visibility: String? = "family",
        owner: String? = null,
        startsAt: String = "2026-08-21T14:00:00Z",
    ) = SyncedEvent(
        id = id,
        householdId = "h1",
        title = "Event $id",
        startsAt = startsAt,
        visibility = visibility,
        ownerPersonId = owner,
    )

    @Test
    fun familyEventsAreVisibleToEveryone() {
        val e = event("1", visibility = "family")
        assertTrue(EventVisibility.isVisible(e, viewerPersonId = "p1"))
        assertTrue(EventVisibility.isVisible(e, viewerPersonId = "p2"))
        assertTrue(EventVisibility.isVisible(e, viewerPersonId = null))
    }

    @Test
    fun personalEventsAreVisibleOnlyToTheirOwner() {
        val e = event("1", visibility = "personal", owner = "p1")
        assertTrue(EventVisibility.isVisible(e, viewerPersonId = "p1"))
        assertFalse(EventVisibility.isVisible(e, viewerPersonId = "p2"))
    }

    @Test
    fun aPersonalEventIsHiddenOnASharedDeviceWithNoClaimedPerson() {
        // The kiosk case: nobody has claimed the device, so nothing personal shows.
        val e = event("1", visibility = "personal", owner = "p1")
        assertFalse(EventVisibility.isVisible(e, viewerPersonId = null))
    }

    @Test
    fun anUnknownOrMissingVisibilityIsTreatedAsFamily() {
        // Older rows predate the column. Defaulting to hidden would make events vanish;
        // defaulting to family matches the server's own reading.
        assertTrue(EventVisibility.isVisible(event("1", visibility = null), "p1"))
        assertTrue(EventVisibility.isVisible(event("2", visibility = ""), "p1"))
        assertTrue(EventVisibility.isVisible(event("3", visibility = "something-new"), "p1"))
    }

    @Test
    fun aPersonalEventWithNoOwnerIsHiddenRatherThanLeaked() {
        // Malformed: marked personal but nobody owns it. Hiding is the safe reading.
        assertFalse(EventVisibility.isVisible(event("1", visibility = "personal"), "p1"))
    }

    @Test
    fun filteringKeepsOrderAndDropsOnlyTheInvisible() {
        val events = listOf(
            event("a", "family"),
            event("b", "personal", owner = "p2"),
            event("c", "personal", owner = "p1"),
            event("d", "family"),
        )
        assertEquals(
            listOf("a", "c", "d"),
            EventVisibility.visible(events, viewerPersonId = "p1").map { it.id },
        )
    }
}

/**
 * Day bucketing must use the household's timezone. This is the bug class where an
 * evening event lands on tomorrow because the client bucketed in UTC.
 */
class EventBucketingTest {

    private val nyc = ZoneId.of("America/New_York")

    private fun event(id: String, startsAt: String) = SyncedEvent(
        id = id,
        householdId = "h1",
        title = id,
        startsAt = startsAt,
    )

    @Test
    fun eventsBucketByLocalDayNotUtcDay() {
        // 01:30Z on the 22nd is 21:30 on the 21st in New York.
        val events = listOf(event("late", "2026-08-22T01:30:00Z"))
        val byDay = EventBucketing.byDay(events, nyc)

        assertEquals(listOf("late"), byDay[WaffledDates.parseInstant("2026-08-21", nyc)!!.let {
            WaffledDates.localDay(it, nyc)
        }]?.map { it.id })
    }

    @Test
    fun eventsOnTheSameLocalDayShareABucketAndStaySortedByStart() {
        val events = listOf(
            event("evening", "2026-08-21T23:00:00Z"),
            event("morning", "2026-08-21T13:00:00Z"),
            event("noon", "2026-08-21T16:00:00Z"),
        )
        val byDay = EventBucketing.byDay(events, ZoneId.of("UTC"))
        val day = WaffledDates.localDay(WaffledDates.parseInstant("2026-08-21T13:00:00Z")!!, ZoneId.of("UTC"))

        assertEquals(listOf("morning", "noon", "evening"), byDay[day]?.map { it.id })
    }

    @Test
    fun unparseableTimestampsAreDroppedRatherThanCrashing() {
        val events = listOf(event("good", "2026-08-21T13:00:00Z"), event("bad", "nonsense"))
        val byDay = EventBucketing.byDay(events, ZoneId.of("UTC"))
        assertEquals(1, byDay.values.sumOf { it.size })
    }

    // ---- ordering + multi-day spans (EventIndexTests: AgendaByDay / AgendaSpan) ------

    private val denver = ZoneId.of("America/Denver")

    private fun span(id: String, start: String, end: String?, allDay: Boolean = true) =
        SyncedEvent(id = id, householdId = "h1", title = id, startsAt = start, endsAt = end, allDay = allDay)

    private fun d(s: String) = LocalDate.parse(s)

    // The all-day end is EXCLUSIVE: a 7/27 -> 8/3 row is the 27th through the 2nd.
    private val trip = span("trip", "2026-07-27T06:00:00Z", "2026-08-03T06:00:00Z")

    @Test
    fun withinADayTimedEventsComeFirstThenAllDay() {
        val byDay = EventBucketing.byDay(
            listOf(
                span("allday", "2026-06-16", null),
                span("next", "2026-06-17T18:00:00Z", null, allDay = false),
                span("evening", "2026-06-17T03:00:00Z", null, allDay = false),
                span("morning", "2026-06-16T17:49:00Z", null, allDay = false),
            ),
            denver,
        )
        assertEquals(2, byDay.size)
        assertEquals(listOf("morning", "evening", "allday"), byDay[d("2026-06-16")]?.map { it.id })
        assertEquals(listOf("next"), byDay[d("2026-06-17")]?.map { it.id })
    }

    @Test
    fun anAllDayTripCoversEveryDayUpToItsExclusiveEnd() {
        assertEquals(
            listOf("2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02")
                .map(::d),
            EventBucketing.dayKeys(trip, denver),
        )
        val byDay = EventBucketing.byDay(listOf(trip), denver)
        assertEquals(7, byDay.size)
        assertEquals(listOf("trip"), byDay[d("2026-07-30")]?.map { it.id })
        assertNull(byDay[d("2026-08-03")])
    }

    @Test
    fun aOneDayAllDayEventAndAnOpenEndedOneStayOnTheirDay() {
        assertEquals(
            listOf(d("2026-07-11")),
            EventBucketing.dayKeys(span("one", "2026-07-11T06:00:00Z", "2026-07-12T06:00:00Z"), denver),
        )
        assertEquals(listOf(d("2026-06-16")), EventBucketing.dayKeys(span("bare", "2026-06-16", null), denver))
    }

    @Test
    fun aTimedEventStaysOnItsStartDayEvenPastMidnight() {
        val late = span("late", "2026-07-11T02:00:00Z", "2026-07-11T16:00:00Z", allDay = false)
        assertEquals(listOf(d("2026-07-10")), EventBucketing.dayKeys(late, denver))
    }

    @Test
    fun aTripIsNotPastUntilItsLastDayIsBehindToday() {
        assertFalse(EventBucketing.isPast(trip, denver, now = Instant.parse("2026-08-02T18:00:00Z")))
        assertTrue(EventBucketing.isPast(trip, denver, now = Instant.parse("2026-08-03T18:00:00Z")))
    }

    @Test
    fun coversFindsATripOnAMiddleDay() {
        assertTrue(EventBucketing.covers(trip, d("2026-07-30"), denver))
        assertTrue(EventBucketing.covers(trip, d("2026-08-02"), denver))
        assertFalse(EventBucketing.covers(trip, d("2026-08-03"), denver))
        assertEquals(d("2026-08-03"), EventBucketing.exclusiveEndDay(trip, denver))
    }

    @Test
    fun aCorruptFarFutureEndIsCapped() {
        val runaway = span("runaway", "2026-01-01T07:00:00Z", "2031-01-01T07:00:00Z")
        assertEquals(EventBucketing.MAX_SPAN_DAYS, EventBucketing.dayKeys(runaway, denver).size)
    }
}
