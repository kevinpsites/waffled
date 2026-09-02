import Testing
@testable import Waffled

// Linking a calendar event to a rhythm from the event editor.
//
// A scheduling rhythm is settled by an event landing in its period, and plenty of those
// events are put on the calendar the ordinary way rather than booked from the register.
// Until there was a way to say so, the rhythm went on asking you to book the outing that
// was already on the calendar.
//
// The link is carried on the PATCH body, and the interesting part is the DEFAULT: the
// upload sink treats an absent `rhythm_id` as "leave it alone" precisely so a client that
// predates the column can't blank a link by omission. So every caller that isn't editing
// the link must leave it out entirely, and unlinking has to be an explicit null — the
// same shape `rrule`/`clearRrule` already use.
@Suite struct EventRhythmLinkTests {
    private func body(
        rhythmId: String? = nil,
        clearRhythmId: Bool = false,
        scope: String? = nil
    ) -> [String: JSONValue] {
        WaffledAPI.eventUpdateBody(
            title: "Zoo trip",
            startsAtISO: "2026-06-22T22:00:00Z",
            endsAtISO: nil,
            allDay: false,
            location: nil,
            personIds: ["person-a"],
            goalId: nil,
            goalStepId: nil,
            rhythmId: rhythmId,
            clearRhythmId: clearRhythmId,
            rrule: nil,
            clearRrule: false,
            recurrenceEndAt: nil,
            clearRecurrenceEndAt: false,
            scope: scope,
            occurrenceStart: nil,
            isCountdown: false)
    }

    @Test func anEditThatDoesNotTouchTheLinkLeavesItAlone() {
        // The important one. `rhythmId` absent means "don't touch"; sending .null here
        // would silently unlink every event edited by a client that never showed a picker.
        #expect(body()["rhythmId"] == nil)
    }

    @Test func linkingCarriesTheRhythmId() {
        #expect(body(rhythmId: "rh-1")["rhythmId"] == .string("rh-1"))
    }

    @Test func unlinkingIsStatedAsAnExplicitNull() {
        #expect(body(clearRhythmId: true)["rhythmId"] == .null)
    }

    @Test func oneOccurrenceOverrideCarriesNoLink() {
        // A per-occurrence override represents time/title/location only — the link lives
        // on the master, and a single occurrence can't own a different one.
        #expect(body(rhythmId: "rh-1", scope: "this")["rhythmId"] == nil)
    }
}
