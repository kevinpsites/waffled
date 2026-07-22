import Foundation
import Testing
@testable import Waffled

// The precomputed event index (SyncManager.events / eventsByDay) that the iPad
// calendar + Today dashboard read per render. The grouping/visibility math lives
// in pure functions so a day tap is an O(1) dictionary lookup, not a re-scan of
// every synced event. Run: xcodebuild test -scheme Waffled -destination '…'.

private let denver = TimeZone(identifier: "America/Denver")!

private func event(_ id: String, _ raw: String?, allDay: Bool = false,
                   visibility: String = "family", owner: String? = nil) -> SyncedEvent {
    SyncedEvent(id: id, title: id, startsAtRaw: raw, startsAt: EventTime.parse(raw),
                allDay: allDay, personId: nil, colorHex: nil, emoji: nil,
                visibility: visibility, ownerPersonId: owner)
}

@Suite struct AgendaByDayTests {
    @Test func groupsByHouseholdDayAndSortsWithinEachDay() {
        // 2026-06-16 17:49 UTC = 11:49 in Denver; 2026-06-17 03:00 UTC = June 16 21:00 Denver.
        let morning = event("morning", "2026-06-16T17:49:00Z")
        let evening = event("evening", "2026-06-17T03:00:00Z")
        let allDay = event("allday", "2026-06-16", allDay: true)
        let nextDay = event("next", "2026-06-17T18:00:00Z")

        let byDay = Agenda.byDay([allDay, nextDay, evening, morning], denver)

        #expect(byDay.count == 2)
        // Within a day: timed events first (by start), then all-day — matches Agenda.before.
        #expect(byDay["2026-06-16"]?.map(\.id) == ["morning", "evening", "allday"])
        #expect(byDay["2026-06-17"]?.map(\.id) == ["next"])
    }

    @Test func dropsEventsWithNoResolvableDay() {
        let ghost = event("ghost", nil)
        let real = event("real", "2026-06-16T12:00:00Z")
        let byDay = Agenda.byDay([ghost, real], denver)
        #expect(byDay.count == 1)
        #expect(byDay["2026-06-16"]?.map(\.id) == ["real"])
    }
}

@Suite struct AgendaUpcomingByDayTests {
    @Test func returnsDaysFromCutoffAscendingWithItemOrderPreserved() {
        let byDay = Agenda.byDay([
            event("past", "2026-06-10T12:00:00Z"),
            event("today-late", "2026-06-16T22:00:00Z"),
            event("today-early", "2026-06-16T14:00:00Z"),
            event("future", "2026-06-20T12:00:00Z"),
        ], denver)

        let groups = Agenda.upcoming(byDay: byDay, from: "2026-06-16")

        #expect(groups.map(\.day) == ["2026-06-16", "2026-06-20"])
        #expect(groups[0].items.map(\.id) == ["today-early", "today-late"])
    }

    @Test func emptyWhenEverythingIsPast() {
        let byDay = Agenda.byDay([event("past", "2026-06-10T12:00:00Z")], denver)
        #expect(Agenda.upcoming(byDay: byDay, from: "2026-06-16").isEmpty)
    }
}

@Suite struct VisibleEventsTests {
    @Test func familyEventsAreVisibleToEveryone() {
        let all = [event("fam", "2026-06-16T12:00:00Z", owner: "alice")]
        #expect(SyncManager.visibleEvents(all, me: "bob").map(\.id) == ["fam"])
        #expect(SyncManager.visibleEvents(all, me: nil).map(\.id) == ["fam"])
    }

    @Test func personalEventsAreOnlyVisibleToTheirOwner() {
        let all = [
            event("mine", "2026-06-16T12:00:00Z", visibility: "personal", owner: "me"),
            event("theirs", "2026-06-16T13:00:00Z", visibility: "personal", owner: "other"),
            event("orphan", "2026-06-16T14:00:00Z", visibility: "personal", owner: nil),
        ]
        #expect(SyncManager.visibleEvents(all, me: "me").map(\.id) == ["mine"])
        #expect(SyncManager.visibleEvents(all, me: nil).isEmpty)
    }
}
