import Foundation
import Testing
@testable import Waffled

// Events imported from an ICS subscription are somebody else's calendar: Waffled
// polls the feed and has nowhere to push a change back to. The server refuses to
// edit or delete them (409 ReadOnlyEvent on REST, and the PowerSync upload sink
// drops non-PUT ops on them), so an app that still offers Edit/Delete produces the
// worst outcome available — the change appears to work, then silently reverts on
// the next poll. The UI has to know before it offers the action.
//
// Google/Outlook events are NOT read-only: those have a write-target calendar and
// Waffled pushes changes back out.
struct ReadOnlyEventTests {
    @Test func treatsIcsImportsAsReadOnly() {
        #expect(EventOrigin.isReadOnly("ics"))
    }

    @Test func leavesSyncedProviderEventsEditable() {
        #expect(!EventOrigin.isReadOnly("google"))
        #expect(!EventOrigin.isReadOnly("microsoft"))
    }

    // Waffled's own events carry no origin (or "waffled").
    @Test func leavesWaffledOwnedEventsEditable() {
        #expect(!EventOrigin.isReadOnly(nil))
        #expect(!EventOrigin.isReadOnly(""))
        #expect(!EventOrigin.isReadOnly("waffled"))
    }

    @Test func surfacesTheFlagOnAnEventFromTheMirror() {
        let feedEvent = SyncedEvent(id: "1", title: "Thanksgiving", startsAtRaw: nil, startsAt: nil,
                                    allDay: true, personId: nil, colorHex: nil, emoji: nil, origin: "ics")
        let ownEvent = SyncedEvent(id: "2", title: "Dentist", startsAtRaw: nil, startsAt: nil,
                                   allDay: false, personId: nil, colorHex: nil, emoji: nil)
        #expect(feedEvent.isReadOnly)
        #expect(!ownEvent.isReadOnly)
    }

    // The detail screen loads a richer DTO over REST; offline it never arrives, so
    // the gate must fall back to the mirror's origin rather than defaulting to
    // "editable" and letting the user make a change that can't land.
    @Test func prefersTheServerDetailButFallsBackToTheMirror() {
        #expect(EventOrigin.isReadOnly(detailOrigin: "ics", mirrorOrigin: nil))
        #expect(EventOrigin.isReadOnly(detailOrigin: nil, mirrorOrigin: "ics"))
        #expect(!EventOrigin.isReadOnly(detailOrigin: nil, mirrorOrigin: nil))
        #expect(!EventOrigin.isReadOnly(detailOrigin: "google", mirrorOrigin: nil))
    }

    // The editor is the thing worth protecting, not any one route into it. Gating
    // only the detail screen left `PersonView`'s day list — which opens the edit
    // sheet directly — still offering Save and Delete on a feed event, so the gate
    // belongs on the sheet where every entry point has to pass through it.
    @Test func blocksEditingAFeedEventWhicheverScreenOpenedIt() {
        let feedEvent = SyncedEvent(id: "1", title: "Band concert", startsAtRaw: nil, startsAt: nil,
                                    allDay: false, personId: "emma", colorHex: nil, emoji: nil, origin: "ics")
        #expect(EventOrigin.blocksEditing(feedEvent))
    }

    @Test func leavesOwnAndProviderEventsEditableInTheSheet() {
        let ownEvent = SyncedEvent(id: "2", title: "Dentist", startsAtRaw: nil, startsAt: nil,
                                   allDay: false, personId: nil, colorHex: nil, emoji: nil)
        let googleEvent = SyncedEvent(id: "3", title: "Standup", startsAtRaw: nil, startsAt: nil,
                                      allDay: false, personId: nil, colorHex: nil, emoji: nil, origin: "google")
        #expect(!EventOrigin.blocksEditing(ownEvent))
        #expect(!EventOrigin.blocksEditing(googleEvent))
    }

    // The same sheet creates events, and a brand-new event has no origin yet — it
    // must not be gated, or the app can't add events at all.
    @Test func neverBlocksCreatingANewEvent() {
        #expect(!EventOrigin.blocksEditing(nil))
    }
}
