package app.waffled.feature.settingshousehold

import app.waffled.core.sync.SyncedEvent
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `NotificationIdentifierTests.swift`, plus the reconcile rules iOS keeps inside
 * `NotificationManager.apply()` — lifted into a pure planner here so they can be pinned.
 */
class EventReminderPlannerTest {

    private val nyc = ZoneId.of("America/New_York")
    private val now = Instant.parse("2026-09-14T12:00:00Z")

    private fun event(
        id: String,
        startsAt: String?,
        allDay: Boolean = false,
        personId: String? = null,
        location: String? = null,
        title: String = "Event $id",
    ) = SyncedEvent(
        id = id, householdId = "h", title = title, startsAt = startsAt, allDay = allDay,
        personId = personId, location = location,
    )

    private val prefs = ReminderPrefs(enabled = true, leadMinutes = 15, allDayHour = 8, myEventsOnly = false)

    @Test
    fun eventReminderCleanupOwnsOnlyEventNamespaces() {
        assertTrue(EventReminderPlanner.isEventReminderIdentifier("waffled.evt.event-1"))
        assertTrue(EventReminderPlanner.isEventReminderIdentifier("waffled.snz.event-1"))

        assertFalse(EventReminderPlanner.isEventReminderIdentifier("waffled.cook.timer-1"))
        assertFalse(EventReminderPlanner.isEventReminderIdentifier("waffled.some-future-feature"))
        assertFalse(EventReminderPlanner.isEventReminderIdentifier("another-app.event-1"))
    }

    @Test
    fun aTimedEventFiresLeadMinutesEarly() {
        val fire = EventReminderPlanner.fireAt(event("a", "2026-09-14T15:00:00Z"), prefs, nyc)
        assertEquals(Instant.parse("2026-09-14T14:45:00Z"), fire)
    }

    // All-day reminders fire at the chosen hour on the event's HOUSEHOLD-local day.
    @Test
    fun anAllDayEventFiresAtTheMorningHourInTheHouseholdZone() {
        val fire = EventReminderPlanner.fireAt(event("a", "2026-09-15", allDay = true), prefs, nyc)
        assertEquals(Instant.parse("2026-09-15T12:00:00Z"), fire)   // 08:00 EDT
    }

    @Test
    fun anUntimeableEventIsSkipped() {
        assertNull(EventReminderPlanner.fireAt(event("a", null), prefs, nyc))
    }

    @Test
    fun planDropsThePastSortsSoonestFirstAndNamespacesIds() {
        val plan = EventReminderPlanner.plan(
            events = listOf(
                event("late", "2026-09-14T20:00:00Z"),
                event("past", "2026-09-14T12:05:00Z"),   // fires 11:50 — already gone
                event("soon", "2026-09-14T13:00:00Z"),
            ),
            prefs = prefs, zone = nyc, myPersonId = null, names = emptyMap(), now = now,
        )
        assertEquals(listOf("waffled.evt.soon", "waffled.evt.late"), plan.keep.map { it.id })
        assertEquals(0, plan.droppedToCap)
    }

    @Test
    fun myEventsOnlyKeepsMineAndUnownedOut() {
        val plan = EventReminderPlanner.plan(
            events = listOf(
                event("mine", "2026-09-14T15:00:00Z", personId = "me"),
                event("theirs", "2026-09-14T15:00:00Z", personId = "you"),
                event("nobody", "2026-09-14T15:00:00Z"),
            ),
            prefs = prefs.copy(myEventsOnly = true), zone = nyc, myPersonId = "me",
            names = emptyMap(), now = now,
        )
        assertEquals(listOf("mine"), plan.keep.map { it.eventId })
    }

    @Test
    fun theCapIsNeverSilent() {
        val events = (1..5).map { event("e$it", "2026-09-14T1${it + 2}:30:00Z") }
        val plan = EventReminderPlanner.plan(events, prefs, nyc, null, emptyMap(), now, cap = 3)
        assertEquals(3, plan.keep.size)
        assertEquals(2, plan.droppedToCap)
    }

    @Test
    fun disabledPlansNothing() {
        val plan = EventReminderPlanner.plan(
            listOf(event("a", "2026-09-14T15:00:00Z")), prefs.copy(enabled = false), nyc, null, emptyMap(), now,
        )
        assertTrue(plan.keep.isEmpty())
    }

    @Test
    fun theBodyNamesTimePlaceAndWhoseItIs() {
        val e = event("a", "2026-09-14T15:00:00Z", personId = "p1", location = "  Gym ")
        assertEquals(
            "11:00 AM · Gym · Elaine",
            EventReminderPlanner.body(e, prefs, nyc, mapOf("p1" to "Elaine"), Locale.US),
        )
        // With "my events only" the name would be redundant.
        assertEquals(
            "11:00 AM · Gym",
            EventReminderPlanner.body(e, prefs.copy(myEventsOnly = true), nyc, mapOf("p1" to "Elaine"), Locale.US),
        )
        assertEquals("All day", EventReminderPlanner.body(event("b", "2026-09-15", allDay = true), prefs, nyc, emptyMap(), Locale.US))
    }

    @Test
    fun hourLabelsFollowTheLocale() {
        assertEquals("8 AM", EventReminderPlanner.hourLabel(8, Locale.US))
        assertEquals("6 PM", EventReminderPlanner.hourLabel(18, Locale.US))
    }

    @Test
    fun preferencesDefaultLikeIos() {
        val d = ReminderPrefs()
        assertFalse(d.enabled)
        assertEquals(15, d.leadMinutes)
        assertEquals(8, d.allDayHour)
        assertTrue(d.myEventsOnly)
    }
}
