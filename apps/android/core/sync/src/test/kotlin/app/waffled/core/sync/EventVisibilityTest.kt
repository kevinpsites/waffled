package app.waffled.core.sync

import app.waffled.core.model.WaffledDates
import java.time.ZoneId
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
}
