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

private func span(_ id: String, _ start: String, _ end: String?, allDay: Bool = true) -> SyncedEvent {
    SyncedEvent(id: id, title: id, startsAtRaw: start, startsAt: EventTime.parse(start), allDay: allDay,
                personId: nil, colorHex: nil, emoji: nil, endsAt: EventTime.parse(end))
}

// Multi-day all-day events (a synced Google trip) cover every day they span. Google's all-day
// end is EXCLUSIVE — a 7/27 → 8/3 row is the 27th through the 2nd — and the server stores it
// as local midnight in UTC, the same shape as the start.
@Suite struct AgendaSpanTests {
    private let trip = span("trip", "2026-07-27 06:00:00+00", "2026-08-03 06:00:00+00")

    @Test func anAllDayTripCoversEveryDayUpToItsExclusiveEnd() {
        #expect(Agenda.dayKeys(trip, denver) == [
            "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02",
        ])
        let byDay = Agenda.byDay([trip], denver)
        #expect(byDay.count == 7)
        #expect(byDay["2026-07-30"]?.map(\.id) == ["trip"])
        #expect(byDay["2026-08-03"] == nil)
    }

    @Test func aOneDayAllDayEventAndAnOpenEndedOneStayOnTheirDay() {
        #expect(Agenda.dayKeys(span("one", "2026-07-11 06:00:00+00", "2026-07-12 06:00:00+00"), denver) == ["2026-07-11"])
        #expect(Agenda.dayKeys(span("bare", "2026-06-16", nil), denver) == ["2026-06-16"])
    }

    @Test func aTimedEventStaysOnItsStartDayEvenPastMidnight() {
        let late = span("late", "2026-07-11T02:00:00Z", "2026-07-11T16:00:00Z", allDay: false)
        #expect(Agenda.dayKeys(late, denver) == ["2026-07-10"])
    }

    @Test func aTripIsNotPastUntilItsLastDayIsBehindToday() {
        let midTrip = EventTime.parse("2026-08-02T18:00:00Z")!
        let dayAfter = EventTime.parse("2026-08-03T18:00:00Z")!
        #expect(!Agenda.isPast(trip, denver, now: midTrip))
        #expect(Agenda.isPast(trip, denver, now: dayAfter))
    }

    @Test func forDayFindsATripOnAMiddleDay() {
        #expect(Agenda.forDay([trip], day: "2026-07-30", tz: denver).map(\.id) == ["trip"])
        #expect(Agenda.covers(trip, day: "2026-08-02", tz: denver))
        #expect(!Agenda.covers(trip, day: "2026-08-03", tz: denver))
    }

    @Test func aCorruptFarFutureEndIsCapped() {
        let runaway = span("runaway", "2026-01-01 07:00:00+00", "2031-01-01 07:00:00+00")
        #expect(Agenda.dayKeys(runaway, denver).count == Agenda.maxSpanDays)
    }
}

// The calendar's person filter narrows the prebuilt day index instead of re-bucketing every
// event per render (phone and iPad share it).
@Suite struct AgendaFilteredByDayTests {
    private func owned(_ id: String, _ raw: String, person: String?, participants: [String] = []) -> SyncedEvent {
        SyncedEvent(id: id, title: id, startsAtRaw: raw, startsAt: EventTime.parse(raw), allDay: false,
                    personId: person, colorHex: nil, emoji: nil, participantIds: participants)
    }

    @Test func keepsTheirOwnAndJoinedEventsAndDropsEmptiedDays() {
        let byDay = Agenda.byDay([
            owned("mine", "2026-06-16T15:00:00Z", person: "p1"),
            owned("joined", "2026-06-16T18:00:00Z", person: "p2", participants: ["p1"]),
            owned("theirs", "2026-06-17T18:00:00Z", person: "p2"),
        ], denver)
        let filtered = Agenda.filtered(byDay: byDay, person: "p1")
        #expect(filtered["2026-06-16"]?.map(\.id) == ["mine", "joined"])
        #expect(filtered["2026-06-17"] == nil)
    }

    @Test func noPersonIsTheIndexUnchanged() {
        let byDay = Agenda.byDay([owned("a", "2026-06-16T15:00:00Z", person: "p1")], denver)
        #expect(Agenda.filtered(byDay: byDay, person: nil) == byDay)
    }
}
