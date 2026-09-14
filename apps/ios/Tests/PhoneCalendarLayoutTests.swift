import Foundation
import Testing
@testable import Waffled

// The iPhone calendar's Month → Week → Day layout rules (the handoff build in
// docs/product/ios-calendar-redesign.md): full-height month rows with a week-number gutter,
// how many titles a day cell can hold, the day timeline's hour range, and overlap lanes.

private let ny = TimeZone(identifier: "America/New_York")!

private func day(_ key: String) -> Date { DateFmt.date(key, "yyyy-MM-dd", ny)! }

private func timed(_ id: String, _ start: String, minutes: Double? = 60) -> SyncedEvent {
    let s = DateFmt.date(start, "yyyy-MM-dd HH:mm", ny)!
    var e = SyncedEvent(id: id, title: id, startsAtRaw: nil, startsAt: s, allDay: false,
                        personId: nil, colorHex: nil, emoji: nil)
    e.endsAt = minutes.map { s.addingTimeInterval($0 * 60) }
    return e
}

@Suite struct PhoneCalendarModeTests {
    @Test func cycleRunsMonthWeekDayAndBackToMonth() {
        #expect(PhoneCalendar.Mode.month.cycled == .week)
        #expect(PhoneCalendar.Mode.week.cycled == .day)
        #expect(PhoneCalendar.Mode.day.cycled == .month)
    }

    @Test func agendaIsOffTheCycleAndReturnsToMonth() {
        #expect(PhoneCalendar.Mode.agenda.cycled == .month)
    }

    @Test func spreadingZoomsInAndPinchingZoomsOut() {
        #expect(PhoneCalendar.Mode.month.zoomed(in: true) == .week)
        #expect(PhoneCalendar.Mode.week.zoomed(in: true) == .day)
        #expect(PhoneCalendar.Mode.day.zoomed(in: true) == .day)
        #expect(PhoneCalendar.Mode.day.zoomed(in: false) == .week)
        #expect(PhoneCalendar.Mode.week.zoomed(in: false) == .month)
        #expect(PhoneCalendar.Mode.month.zoomed(in: false) == .month)
    }

    @Test func aStoredModeFromAnOlderBuildStillDecodes() {
        #expect(PhoneCalendar.Mode(rawValue: "agenda") == .agenda)
        #expect(PhoneCalendar.Mode(rawValue: "people") == nil)
    }
}

@Suite struct PhoneCalendarMonthRowsTests {
    @Test func aFiveWeekMonthOnAMondayHouseholdHasFiveRowsLedByMonday() {
        let rows = PhoneCalendar.monthRows(day("2026-09-15"), tz: ny, firstDay: .monday)
        #expect(rows.count == 5)
        #expect(rows.first?.days.first?.key == "2026-08-31")
        #expect(rows.last?.days.last?.key == "2026-10-04")
        #expect(rows.map(\.weekNumber) == [36, 37, 38, 39, 40])
    }

    @Test func aSundayHouseholdNumbersEachRowByTheMondayInsideIt() {
        let rows = PhoneCalendar.monthRows(day("2026-09-15"), tz: ny, firstDay: .sunday)
        #expect(rows.count == 5)
        #expect(rows.first?.days.first?.key == "2026-08-30")
        #expect(rows.map(\.weekNumber) == [36, 37, 38, 39, 40])
    }

    @Test func aMonthThatNeedsSixWeeksGetsSixRows() {
        let rows = PhoneCalendar.monthRows(day("2026-08-10"), tz: ny, firstDay: .sunday)
        #expect(rows.count == 6)
        #expect(rows.first?.days.first?.key == "2026-07-26")
        #expect(rows.first?.weekNumber == 31)
    }

    @Test func daysOutsideTheMonthAreMarked() {
        let rows = PhoneCalendar.monthRows(day("2026-09-15"), tz: ny, firstDay: .monday)
        let first = rows[0].days
        #expect(first[0].inMonth == false)
        #expect(first[1].key == "2026-09-01")
        #expect(first[1].inMonth == true)
        #expect(first[1].day == 1)
    }

    @Test func theWeekNumberFollowsIsoAcrossTheYearBoundary() {
        let rows = PhoneCalendar.monthRows(day("2027-01-12"), tz: ny, firstDay: .monday)
        #expect(rows.first?.days.first?.key == "2026-12-28")
        #expect(rows.first?.weekNumber == 53)
        #expect(rows[1].weekNumber == 1)
    }
}

@Suite struct PhoneCalendarCellChipsTests {
    @Test func aTallCellShowsFourTitlesThenMore() {
        let c = PhoneCalendar.cellChips(eventCount: 7, hasCountdown: false, rowHeight: 128)
        #expect(c.shown == 4)
        #expect(c.more == 3)
    }

    @Test func aCountdownCostsOneTitleSlot() {
        let c = PhoneCalendar.cellChips(eventCount: 7, hasCountdown: true, rowHeight: 128)
        #expect(c.shown == 3)
        #expect(c.more == 4)
    }

    @Test func aQuietDayShowsEverythingWithNoMoreLine() {
        let c = PhoneCalendar.cellChips(eventCount: 2, hasCountdown: false, rowHeight: 128)
        #expect(c.shown == 2)
        #expect(c.more == 0)
    }

    @Test func aShorterSixRowCellHoldsFewerTitles() {
        let c = PhoneCalendar.cellChips(eventCount: 7, hasCountdown: false, rowHeight: 100)
        #expect(c.shown < 4)
        #expect(c.shown + c.more == 7)
    }

    @Test func aCellTooShortForAnyTitleStillCountsTheDay() {
        let c = PhoneCalendar.cellChips(eventCount: 3, hasCountdown: true, rowHeight: 30)
        #expect(c.shown == 0)
        #expect(c.more == 3)
    }
}

@Suite struct PhoneCalendarDayHoursTests {
    @Test func anOrdinaryDayRunsSevenToEight() {
        let hours = PhoneCalendar.dayHours([timed("a", "2026-09-14 09:00")], tz: ny)
        #expect(hours == 7...20)
    }

    @Test func anEmptyDayRunsSevenToEight() {
        #expect(PhoneCalendar.dayHours([], tz: ny) == 7...20)
    }

    @Test func anEarlyEventPullsTheStartBack() {
        let hours = PhoneCalendar.dayHours([timed("a", "2026-09-14 05:30")], tz: ny)
        #expect(hours == 5...20)
    }

    @Test func aLateEventPushesTheEndOutToTheHourItFinishesIn() {
        let hours = PhoneCalendar.dayHours([timed("a", "2026-09-14 21:00", minutes: 75)], tz: ny)
        #expect(hours == 7...23)
    }

    @Test func theDayOpensAnHourBeforeTheFirstTimedEvent() {
        let events = [timed("late", "2026-09-14 16:00"), timed("early", "2026-09-14 11:30")]
        #expect(PhoneCalendar.openingHour(events, hours: 7...20, tz: ny) == 10)
    }

    @Test func anEmptyDayOpensAtTheTopOfTheGrid() {
        #expect(PhoneCalendar.openingHour([], hours: 7...20, tz: ny) == 7)
    }

    @Test func theOpeningHourStaysInsideTheGrid() {
        #expect(PhoneCalendar.openingHour([timed("dawn", "2026-09-14 05:00")], hours: 5...20, tz: ny) == 5)
        #expect(PhoneCalendar.openingHour([timed("night", "2026-09-14 22:00")], hours: 7...23, tz: ny) == 21)
    }

    @Test func anEventRunningPastMidnightStopsTheGridAtMidnight() {
        let hours = PhoneCalendar.dayHours([timed("a", "2026-09-14 22:00", minutes: 240)], tz: ny)
        #expect(hours == 7...24)
    }
}

@Suite struct PhoneCalendarWeekTests {
    @Test func theWeekIsCutOnTheHouseholdsFirstDay() {
        #expect(PhoneCalendar.weekDays(containing: "2026-09-16", tz: ny, firstDay: .monday)
                == ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17",
                    "2026-09-18", "2026-09-19", "2026-09-20"])
        #expect(PhoneCalendar.weekDays(containing: "2026-09-16", tz: ny, firstDay: .sunday).first
                == "2026-09-13")
    }

    @Test func theWeekTitleNamesTheMonthOnceUnlessTheWeekCrossesIntoTheNext() {
        #expect(PhoneCalendar.weekTitle(PhoneCalendar.weekDays(containing: "2026-09-16", tz: ny, firstDay: .monday), tz: ny)
                == "Sep 14 – 20")
        #expect(PhoneCalendar.weekTitle(PhoneCalendar.weekDays(containing: "2026-09-30", tz: ny, firstDay: .monday), tz: ny)
                == "Sep 28 – Oct 4")
    }

    @Test func cardTimesAreCompact() {
        #expect(PhoneCalendar.shortTime(DateFmt.date("2026-09-14 09:30", "yyyy-MM-dd HH:mm", ny)!, tz: ny) == "9:30a")
        #expect(PhoneCalendar.shortTime(DateFmt.date("2026-09-14 12:00", "yyyy-MM-dd HH:mm", ny)!, tz: ny) == "12p")
        #expect(PhoneCalendar.shortTime(DateFmt.date("2026-09-14 00:05", "yyyy-MM-dd HH:mm", ny)!, tz: ny) == "12:05a")
    }

    @Test func allDayEventsLeadThenTimedOnesByStart() {
        var birthday = SyncedEvent(id: "bday", title: "bday", startsAtRaw: "2026-09-14", startsAt: nil,
                                   allDay: true, personId: nil, colorHex: nil, emoji: nil)
        birthday.endsAt = nil
        let ordered = PhoneCalendar.displayOrder([timed("late", "2026-09-14 15:00"), birthday,
                                                  timed("early", "2026-09-14 08:00")])
        #expect(ordered.map(\.id) == ["bday", "early", "late"])
    }

    @Test func steppingAWeekMovesTheSelectedDaySevenDays() {
        #expect(PhoneCalendar.shift("2026-09-30", byDays: 7, tz: ny) == "2026-10-07")
        #expect(PhoneCalendar.shift("2026-09-03", byDays: -7, tz: ny) == "2026-08-27")
    }
}

@Suite struct PhoneCalendarDaySwipeTests {
    @Test func aSidewaysFlickStepsTheDay() {
        #expect(PhoneCalendar.daySwipeStep(startX: 200, dx: -80, dy: 5) == 1)
        #expect(PhoneCalendar.daySwipeStep(startX: 200, dx: 80, dy: 5) == -1)
    }

    @Test func aShortOrMostlyVerticalDragDoesNothing() {
        #expect(PhoneCalendar.daySwipeStep(startX: 200, dx: 30, dy: 0) == nil)
        #expect(PhoneCalendar.daySwipeStep(startX: 200, dx: 80, dy: 70) == nil)
    }

    @Test func aDragFromTheLeadingEdgeIsTheBackSwipeNotAPreviousDay() {
        #expect(PhoneCalendar.daySwipeStep(startX: 12, dx: 150, dy: 0) == nil)
    }
}

@Suite struct PhoneCalendarFocusDayTests {
    @Test func aSelectedDayInsideTheMonthIsKept() {
        #expect(PhoneCalendar.focusDay(selected: "2026-11-20", inMonthOf: day("2026-11-03"),
                                       today: "2026-09-14", tz: ny) == "2026-11-20")
    }

    @Test func todayWinsWhenTheMonthHoldsItButNotTheSelection() {
        #expect(PhoneCalendar.focusDay(selected: "2026-10-05", inMonthOf: day("2026-09-01"),
                                       today: "2026-09-14", tz: ny) == "2026-09-14")
    }

    @Test func otherwiseTheMonthOpensOnItsFirstDay() {
        #expect(PhoneCalendar.focusDay(selected: "2026-09-14", inMonthOf: day("2026-11-17"),
                                       today: "2026-09-14", tz: ny) == "2026-11-01")
    }
}

@Suite struct TimeLanesTests {
    @Test func overlappingEventsSplitIntoLanesAndReuseAFreedOne() {
        let placed = TimeLanes.place([
            timed("a", "2026-09-14 09:00"),
            timed("b", "2026-09-14 09:30"),
            timed("c", "2026-09-14 10:00"),
            timed("d", "2026-09-14 13:00"),
        ])
        let byId = Dictionary(uniqueKeysWithValues: placed.map { ($0.event.id, $0) })
        #expect(byId["a"]?.lane == 0)
        #expect(byId["b"]?.lane == 1)
        #expect(byId["c"]?.lane == 0)
        #expect(byId["a"]?.lanes == 2)
        #expect(byId["c"]?.lanes == 2)
        #expect(byId["d"]?.lane == 0)
        #expect(byId["d"]?.lanes == 1)
    }

    @Test func anEventWithNoEndOrAShortOneStillTakesUpSpace() {
        let placed = TimeLanes.place([
            timed("quick", "2026-09-14 09:00", minutes: 5),
            timed("afterQuick", "2026-09-14 09:10"),
            timed("open", "2026-09-14 11:00", minutes: nil),
            timed("afterOpen", "2026-09-14 11:45"),
        ])
        let byId = Dictionary(uniqueKeysWithValues: placed.map { ($0.event.id, $0) })
        #expect(byId["afterQuick"]?.lane == 1)
        #expect(byId["afterOpen"]?.lane == 1)
    }

    @Test func eventsArriveInAnyOrder() {
        let placed = TimeLanes.place([timed("late", "2026-09-14 11:00"), timed("early", "2026-09-14 08:00")])
        #expect(placed.map(\.event.id) == ["early", "late"])
    }
}
