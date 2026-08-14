import Foundation
import Testing
@testable import Waffled

// Per-person calendar columns. An event belongs in its OWNER's column
// (`personId` — the assignee that drives the colour, not `ownerPersonId`, which is
// the personal-calendar visibility flag) and additionally in every participant's
// column, so a shared event reads from each person's lane.
//
// Mirrors the web's `peopleColumns` (apps/web/src/kiosk/components/cal-people.ts) —
// keep the two in step.

private func person(_ id: String, _ name: String) -> PeopleColumns.Member {
    PeopleColumns.Member(id: id, name: name, colorHex: nil, avatarEmoji: nil)
}

private func event(_ id: String, owner: String? = nil, participants: [String] = [],
                   at offset: TimeInterval = 0, minutes: Double = 60) -> SyncedEvent {
    let start = Date(timeIntervalSince1970: 1_787_000_000 + offset)
    var e = SyncedEvent(id: id, title: id, startsAtRaw: "2026-08-28T19:30:00Z",
                        startsAt: start, allDay: false,
                        personId: owner, colorHex: nil, emoji: nil)
    e.endsAt = start.addingTimeInterval(minutes * 60)
    e.participantIds = participants
    return e
}

private let family = [person("p1", "Jerry"), person("p2", "Elaine"), person("p3", "George")]

/// Which column ids an event landed in.
private func landedIn(_ cols: [PeopleColumns.Column], _ eventId: String) -> [String] {
    cols.filter { $0.events.contains { $0.id == eventId } }.map(\.id)
}

@Suite struct PeopleColumnsTests {
    @Test func ownedEventGoesInTheOwnersColumn() {
        let cols = PeopleColumns.build([event("e1", owner: "p1")], people: family)
        #expect(landedIn(cols, "e1") == ["p1"])
    }

    // The point of the feature.
    @Test func sharedEventRepeatsInEveryParticipantsColumn() {
        let e = event("e1", owner: "p1", participants: ["p1", "p2"])
        #expect(landedIn(PeopleColumns.build([e], people: family), "e1") == ["p1", "p2"])
    }

    // The write paths disagree about whether the owner is ALSO a participant row
    // (the iOS editor derives personId from participants.first; meal/goal paths
    // don't). Union both so it doesn't matter which one wrote the event.
    @Test func unionsOwnerAndParticipantsWithoutDuplicating() {
        let e = event("e1", owner: "p1", participants: ["p2"])
        let cols = PeopleColumns.build([e], people: family)
        #expect(landedIn(cols, "e1") == ["p1", "p2"])
        #expect(cols.first { $0.id == "p1" }?.events.count == 1)
    }

    // Participant rows may name someone outside the household (migration 0009
    // allows a null person_id with an external_email). Bucketing is column-driven,
    // so an unknown id has no column to land in — it must not invent one.
    @Test func ignoresParticipantsOutsideTheHousehold() {
        let e = event("e1", owner: "p1", participants: ["newman"])
        #expect(PeopleColumns.build([e], people: family).map(\.id) == ["p1", "p2", "p3"])
    }

    @Test func keepsAColumnForEveryPersonEvenAnEmptyOne() {
        let cols = PeopleColumns.build([event("e1", owner: "p1")], people: family)
        #expect(cols.map(\.id) == ["p1", "p2", "p3"])
        #expect(cols.first { $0.id == "p3" }?.events.isEmpty == true)
    }

    // An event belonging to nobody must not vanish.
    @Test func unassignedEventsGetALeadingEveryoneColumn() {
        let cols = PeopleColumns.build([event("e1"), event("e2", owner: "p1")], people: family)
        #expect(cols.first?.id == PeopleColumns.unassignedId)
        #expect(landedIn(cols, "e1") == [PeopleColumns.unassignedId])
    }

    @Test func omitsTheEveryoneColumnWhenEverythingHasSomeone() {
        let cols = PeopleColumns.build([event("e1", owner: "p1")], people: family)
        #expect(!cols.contains { $0.id == PeopleColumns.unassignedId })
    }

    // Lanes are packed per column. An event shown in several columns must be full
    // width in the ones where nothing else overlaps it — packing globally would
    // shrink it everywhere because of a clash in someone else's column.
    @Test func lanesArePackedPerColumnNotGlobally() {
        let shared = event("shared", owner: "p1", participants: ["p1", "p2"], minutes: 90)
        let jerryOnly = event("solo", owner: "p1", at: 1800, minutes: 90)
        let cols = PeopleColumns.build([shared, jerryOnly], people: family)
        let jerry = PeopleColumns.lanes(for: cols.first { $0.id == "p1" }!.events)
        let elaine = PeopleColumns.lanes(for: cols.first { $0.id == "p2" }!.events)
        #expect(jerry["shared"]?.lanes == 2)
        #expect(elaine["shared"]?.lanes == 1)
    }
}

// The People view is iPad-only. A phone column is too narrow to be worth the mode —
// at four members the titles already truncate to "Dinn…" — so the iPhone calendar
// keeps Agenda/Month/Day. `PeopleColumns` itself stays: the iPad still uses it.
@Suite struct IPhoneCalendarModesTests {
    @Test func theIPhoneCalendarHasNoPeopleMode() {
        #expect(CalendarView.CalMode.allCases.map(\.rawValue) == ["agenda", "month", "day"])
    }

    // A phone that had People selected has "people" persisted under
    // `waffled.calendarMode`. @AppStorage can't decode an unknown raw value, so it
    // falls back to the property's default (.agenda) instead of crashing.
    @Test func aPersistedPeopleModeNoLongerDecodes() {
        #expect(CalendarView.CalMode(rawValue: "people") == nil)
    }
}
