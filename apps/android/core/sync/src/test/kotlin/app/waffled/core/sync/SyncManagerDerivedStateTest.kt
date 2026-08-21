package app.waffled.core.sync

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The derived flows, not the pure functions.
 *
 * `EventVisibilityTest` and `EventBucketingTest` cover the *rules*; this covers the
 * plumbing that feeds them — which is where the interesting bug lives. Both inputs
 * change at runtime after data has already loaded:
 *
 *  - the **viewer** changes when someone claims a shared kiosk,
 *  - the **timezone** arrives from the server after the household loads.
 *
 * If the derived state only recomputes when the event list changes, a person claim
 * silently fails to refilter and a personal event stays on screen for the wrong viewer.
 */
class SyncManagerDerivedStateTest {

    private fun event(id: String, visibility: String, owner: String?, startsAt: String) =
        SyncedEvent(
            id = id,
            householdId = "h1",
            title = id,
            startsAt = startsAt,
            visibility = visibility,
            ownerPersonId = owner,
        )

    private val events = listOf(
        event("family", "family", null, "2026-08-22T01:30:00Z"),
        event("alices", "personal", "alice", "2026-08-22T01:30:00Z"),
        event("bobs", "personal", "bob", "2026-08-22T01:30:00Z"),
    )

    @Test
    fun changingTheViewerRefiltersAlreadyLoadedEvents() = runTest {
        val derived = DerivedEventState()
        derived.setEvents(events)

        derived.setViewer("alice")
        assertEquals(listOf("family", "alices"), derived.visible.first().map { it.id })

        // The kiosk case: a different person claims the device. Nothing about the event
        // list changed, so this only works if the viewer is itself an input.
        derived.setViewer("bob")
        assertEquals(listOf("family", "bobs"), derived.visible.first().map { it.id })

        // Handed back to nobody — personal events must disappear entirely.
        derived.setViewer(null)
        assertEquals(listOf("family"), derived.visible.first().map { it.id })
    }

    @Test
    fun changingTheZoneRebucketsAlreadyLoadedEvents() = runTest {
        val derived = DerivedEventState()
        derived.setEvents(listOf(event("late", "family", null, "2026-08-22T01:30:00Z")))
        derived.setViewer("alice")

        derived.setZone(ZoneId.of("UTC"))
        assertEquals(setOf("2026-08-22"), derived.byDay.first().keys.map { it.toString() }.toSet())

        // The household timezone arrives from the server AFTER events have loaded.
        derived.setZone(ZoneId.of("America/New_York"))
        assertEquals(setOf("2026-08-21"), derived.byDay.first().keys.map { it.toString() }.toSet())
    }

    @Test
    fun eventsArrivingLaterAreFilteredWithTheCurrentViewer() = runTest {
        val derived = DerivedEventState()
        derived.setViewer("alice")
        derived.setEvents(events)
        assertEquals(listOf("family", "alices"), derived.visible.first().map { it.id })
    }
}
