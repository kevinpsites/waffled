import Foundation
import PowerSync
import Testing
@testable import Waffled

// The 🔁 marker on a calendar event — iOS parity for the web's `RhythmMark`.
//
// A scheduling-shape rhythm books an ordinary calendar event and points it back at
// itself (`events.rhythm_id`), so there is no rhythm entity to draw on the calendar —
// only a marker saying this slot is somebody's rhythm. Deliberately NOT follow-through
// language: getting the opportunity onto the calendar IS the outcome, and we never ask
// whether it happened. That is the line between a rhythm and a goal.
//
// These lock the two things that fail SILENTLY — no crash, no error, just a marker that
// never appears:
//
//  1. **The column has to be declared.** PowerSync projects only the columns in the
//     client schema through its views. The server sync rules are `SELECT * FROM events`,
//     so `rhythm_id` reaches the device either way — but leave it out of `SyncSchema`
//     and every read comes back NULL.
//  2. **BOTH branches of the agenda UNION have to select it.** A recurring master
//     carries the link, and its occurrences render *instead of* the master — so an
//     auto-scheduled rhythm (the third-weekend outing, trash night) is only ever drawn
//     from the occurrence branch. Miss `m.rhythm_id` there and the marker works for
//     one-off bookings and vanishes for exactly the recurring case that matters most.
//     This is the client-side twin of the `auto_schedule` satisfaction hole the server
//     tests cover.
//
// Asserting on a SQL string is ugly, and normally the wrong instinct. It earns its place
// here because the query lives inside a `db.watch` that needs a live PowerSync database
// to run: there is no cheaper seam that can tell the two branches apart, and the failure
// it guards against is invisible until someone looks at a real calendar.

private func event(_ id: String, rhythmId: String? = nil) -> SyncedEvent {
    SyncedEvent(id: id, title: id, startsAtRaw: nil, startsAt: nil,
                allDay: false, personId: nil, colorHex: nil, emoji: nil,
                rhythmId: rhythmId)
}

@Suite struct RhythmMarkSchemaTests {
    private var eventColumns: [String] {
        SyncSchema.schema.tables.first { $0.name == "events" }?.columns.map(\.name) ?? []
    }

    @Test func eventsTableDeclaresRhythmId() {
        #expect(eventColumns.contains("rhythm_id"))
    }

    @Test func agendaQuerySelectsRhythmIdFromTheSingleEvent() {
        #expect(EventQuery.agenda.contains("e.rhythm_id"))
    }

    /// The one that actually breaks: an occurrence has no `rhythm_id` of its own, so it
    /// has to take the master's.
    @Test func agendaQuerySelectsRhythmIdFromTheOccurrencesMaster() {
        #expect(EventQuery.agenda.contains("m.rhythm_id"))
    }
}

@Suite struct RhythmMarkModelTests {
    @Test func anEventLinkedToARhythmIsMarked() {
        #expect(event("e1", rhythmId: "rh-1").isRhythm)
    }

    @Test func anOrdinaryEventIsNot() {
        #expect(!event("e1").isRhythm)
    }

    /// The marker means "rhythm", never "recurring" — a repeating standup is not a
    /// rhythm, and marking it would make the glyph meaningless.
    @Test func recurrenceAloneDoesNotMarkAnEvent() {
        var e = event("e1")
        e.occurrenceStart = "2026-09-19T15:00:00Z"
        #expect(!e.isRhythm)
    }
}

@Suite struct RhythmMarkLabelTests {
    /// Two of the kiosk's chips are a bare `Text` with padding + background chained onto
    /// it, so the glyph goes in the string rather than into an HStack — restructuring
    /// them would move where the chip's background lands.
    @Test func prefixesTheGlyphForAChipTitle() {
        #expect(RhythmMark.prefixed("Temple visit", isRhythm: true) == "🔁 Temple visit")
    }

    @Test func leavesAnOrdinaryTitleAlone() {
        #expect(RhythmMark.prefixed("Dentist", isRhythm: false) == "Dentist")
    }

    /// VoiceOver has to say what the glyph means; the emoji alone reads as "repeat
    /// button", which is the recurrence meaning we're specifically not claiming.
    @Test func spellsTheMarkerOutForVoiceOver() {
        #expect(RhythmMark.accessibilityLabel("Temple visit", isRhythm: true)
                == "Temple visit, part of a rhythm")
        #expect(RhythmMark.accessibilityLabel("Dentist", isRhythm: false) == "Dentist")
    }
}
