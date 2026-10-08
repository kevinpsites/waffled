package app.waffled.feature.calendar

import app.waffled.core.sync.SyncedEvent
import org.junit.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/ReadOnlyEventTests.swift`.
 *
 * Events imported from an ICS subscription are somebody else's calendar: Waffled polls the
 * feed and has nowhere to push a change back to. The server refuses to edit or delete them
 * (409 ReadOnlyEvent on REST, and the PowerSync upload sink drops non-PUT ops on them), so
 * an app that still offers Edit/Delete produces the worst outcome available — the change
 * appears to work, then silently reverts on the next poll. The UI has to know BEFORE it
 * offers the action.
 *
 * Google/Outlook events are NOT read-only: those have a write-target calendar and Waffled
 * pushes changes back out.
 */
class EventOriginTest {

    @Test
    fun treatsIcsImportsAsReadOnly() {
        assertTrue(EventOrigin.isReadOnly("ics"))
    }

    @Test
    fun leavesSyncedProviderEventsEditable() {
        assertFalse(EventOrigin.isReadOnly("google"))
        assertFalse(EventOrigin.isReadOnly("microsoft"))
    }

    @Test
    fun leavesWaffledOwnedEventsEditable() {
        // Waffled's own events carry no origin (or "waffled").
        assertFalse(EventOrigin.isReadOnly(null))
        assertFalse(EventOrigin.isReadOnly(""))
        assertFalse(EventOrigin.isReadOnly("waffled"))
    }

    @Test
    fun surfacesTheFlagOnAnEventFromTheMirror() {
        assertTrue(SyncedEvent(id = "1", householdId = "h", title = "Thanksgiving", startsAt = null, origin = "ics").isReadOnly)
        assertFalse(SyncedEvent(id = "2", householdId = "h", title = "Dentist", startsAt = null).isReadOnly)
    }

    @Test
    fun prefersTheServerDetailButFallsBackToTheMirror() {
        // The detail screen loads a richer DTO over REST; offline it never arrives, so the
        // gate must fall back to the mirror's origin rather than defaulting to "editable"
        // and letting the user make a change that can't land.
        assertTrue(EventOrigin.isReadOnly(detailOrigin = "ics", mirrorOrigin = null))
        assertTrue(EventOrigin.isReadOnly(detailOrigin = null, mirrorOrigin = "ics"))
        assertFalse(EventOrigin.isReadOnly(detailOrigin = null, mirrorOrigin = null))
        assertFalse(EventOrigin.isReadOnly(detailOrigin = "google", mirrorOrigin = null))
    }

    @Test
    fun blocksEditingAFeedEventWhicheverScreenOpenedIt() {
        // The editor is the thing worth protecting, not any one route into it: gating only
        // the detail screen left another day list still offering Save and Delete on a feed
        // event, so the gate belongs on the sheet every entry point passes through.
        val feedEvent = SyncedEvent(id = "1", householdId = "h", title = "Band concert", startsAt = null, origin = "ics")
        assertTrue(EventOrigin.blocksEditing(feedEvent))
    }

    @Test
    fun leavesOwnAndProviderEventsEditableInTheSheet() {
        val own = SyncedEvent(id = "2", householdId = "h", title = "Dentist", startsAt = null)
        val google = SyncedEvent(id = "3", householdId = "h", title = "Standup", startsAt = null, origin = "google")
        assertFalse(EventOrigin.blocksEditing(own))
        assertFalse(EventOrigin.blocksEditing(google))
    }

    @Test
    fun neverBlocksCreatingANewEvent() {
        // The same sheet creates events, and a brand-new event has no origin yet — it must
        // not be gated, or the app can't add events at all.
        assertFalse(EventOrigin.blocksEditing(null))
    }
}
