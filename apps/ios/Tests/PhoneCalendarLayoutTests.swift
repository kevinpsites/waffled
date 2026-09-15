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
    @Test func aDaySavedByAnOlderBuildReopensOnMonth() {
        #expect(PhoneCalendar.Mode.restored(stored: .day, override: nil) == .month)
        #expect(PhoneCalendar.Mode.restored(stored: .week, override: nil) == .week)
        #expect(PhoneCalendar.Mode.restored(stored: .agenda, override: nil) == .agenda)
    }

    @Test func aLaunchOverrideCanStillOpenDay() {
        #expect(PhoneCalendar.Mode.restored(stored: .month, override: .day) == .day)
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
        let c = PhoneCalendar.cellChips(eventCount: 7, countdownCount: 0, rowHeight: 128)
        #expect(c.shown == 4)
        #expect(c.more == 3)
        #expect(c.showsCountdown == false)
    }

    @Test func aCountdownCostsOneTitleSlot() {
        let c = PhoneCalendar.cellChips(eventCount: 7, countdownCount: 1, rowHeight: 128)
        #expect(c.showsCountdown)
        #expect(c.shown == 3)
        #expect(c.more == 4)
    }

    @Test func onlyOneCountdownShowsAndTheRestCountTowardMore() {
        let c = PhoneCalendar.cellChips(eventCount: 2, countdownCount: 3, rowHeight: 128)
        #expect(c.showsCountdown)
        #expect(c.shown == 2)
        #expect(c.more == 2)
    }

    @Test func aQuietDayShowsEverythingWithNoMoreLine() {
        let c = PhoneCalendar.cellChips(eventCount: 2, countdownCount: 0, rowHeight: 128)
        #expect(c.shown == 2)
        #expect(c.more == 0)
    }

    @Test func aShorterSixRowCellHoldsFewerTitles() {
        let c = PhoneCalendar.cellChips(eventCount: 7, countdownCount: 0, rowHeight: 100)
        #expect(c.shown < 4)
        #expect(c.shown + c.more == 7)
    }

    @Test func aCellTooShortForAnyChipStillCountsEverything() {
        let c = PhoneCalendar.cellChips(eventCount: 3, countdownCount: 2, rowHeight: 30)
        #expect(c.shown == 0)
        #expect(c.showsCountdown == false)
        #expect(c.more == 5)
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

@Suite struct PhoneCalendarWeekPagingTests {
    @Test func theStripPagesThroughTheRailsWholeWeeks() {
        let days = PhoneCalendar.railDays(around: "2026-09-16", weeksEachSide: 1, tz: ny, firstDay: .monday)
        #expect(PhoneCalendar.railWeeks(days) == ["2026-09-07", "2026-09-14", "2026-09-21"])
    }

    @Test func stripWeeksCrossMonthsAndYears() {
        let days = PhoneCalendar.railDays(around: "2026-12-31", weeksEachSide: 1, tz: ny, firstDay: .sunday)
        #expect(PhoneCalendar.railWeeks(days) == ["2026-12-20", "2026-12-27", "2027-01-03"])
    }

    @Test func theRailRunsWholeWeeksEitherSideOfTheSelectedDay() {
        let days = PhoneCalendar.railDays(around: "2026-09-16", weeksEachSide: 2, tz: ny, firstDay: .monday)
        #expect(days.count == 35)
        #expect(days.first == "2026-08-31")
        #expect(days.last == "2026-10-04")
        #expect(days.contains("2026-09-16"))
    }

    @Test func theRailCrossesDaylightSavingWithoutSkippingOrRepeatingADay() {
        let days = PhoneCalendar.railDays(around: "2026-11-01", weeksEachSide: 1, tz: ny, firstDay: .sunday)
        #expect(Set(days).count == days.count)
        #expect(days.contains("2026-11-01") && days.contains("2026-11-02"))
    }

    @Test func theRailRecentersOnlyNearItsEnds() {
        let days = PhoneCalendar.railDays(around: "2026-09-16", weeksEachSide: 4, tz: ny, firstDay: .monday)
        #expect(PhoneCalendar.railNeedsRecenter(selected: "2026-09-16", days: days) == false)
        #expect(PhoneCalendar.railNeedsRecenter(selected: days[3], days: days) == true)
        #expect(PhoneCalendar.railNeedsRecenter(selected: days[days.count - 2], days: days) == true)
        #expect(PhoneCalendar.railNeedsRecenter(selected: "2027-06-01", days: days) == true)
    }
}

@Suite struct PhoneCalendarMealEventTests {
    private func event(_ title: String, origin: String?, at time: String = "2026-09-14 18:00") -> SyncedEvent {
        var e = timed(title, time)
        e.origin = origin
        return e
    }

    @Test func mealPlanAndThawEventsAreRecognisedByOrigin() {
        #expect(PhoneCalendar.EventKind(origin: "meal_plan") == .meal)
        #expect(PhoneCalendar.EventKind(origin: "meal_prep") == .prep)
        #expect(PhoneCalendar.EventKind(origin: nil) == .regular)
        #expect(PhoneCalendar.EventKind(origin: "google") == .regular)
    }

    @Test func theFooterNamesTonightsPlannedDinner() {
        let events = [event("🧊 Thaw for Dinner · Salmon", origin: "meal_prep", at: "2026-09-14 08:00"),
                      event("🍽️ Dinner · Sheet-pan salmon", origin: "meal_plan")]
        #expect(PhoneCalendar.dinnerFooter(events) == "Dinner · Sheet-pan salmon")
    }

    @Test func withOnlyAThawReminderTheFooterSaysWhatToThaw() {
        let events = [event("🧊 Thaw for Dinner · Chicken thighs", origin: "meal_prep", at: "2026-09-14 08:00")]
        #expect(PhoneCalendar.dinnerFooter(events) == "Thaw · Chicken thighs")
    }

    @Test func lunchIsNotDinnerAndAManualDinnerIsNotAPlannedMeal() {
        let events = [event("🍽️ Lunch · Tacos", origin: "meal_plan", at: "2026-09-14 12:00"),
                      event("Dinner at Monk's", origin: nil)]
        #expect(PhoneCalendar.dinnerFooter(events) == nil)
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

// Multi-day all-day events draw as one bar across a month row (like Google's month view)
// instead of a separate chip in every day they cover.
private func trip(_ id: String, _ first: String, throughExclusive end: String) -> SyncedEvent {
    SyncedEvent(id: id, title: id, startsAtRaw: nil, startsAt: day(first), allDay: true,
                personId: nil, colorHex: nil, emoji: nil, endsAt: day(end))
}

@Suite struct PhoneMonthSpanTests {
    private let week = ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"]

    @Test func aTripDrawsOneBarAcrossItsDaysAndLeavesTheirChips() {
        let t = trip("hamptons", "2026-09-15", throughExclusive: "2026-09-18")
        let dinner = timed("dinner", "2026-09-16 18:00")
        let spans = PhoneCalendar.weekSpans(week, byDay: Agenda.byDay([t, dinner], ny), tz: ny, maxLanes: 3)
        #expect(spans.bars.map(\.event.id) == ["hamptons"])
        #expect(spans.bars.first?.startCol == 2)
        #expect(spans.bars.first?.endCol == 4)
        #expect(spans.bars.first?.lane == 0)
        #expect(spans.lanes == 1)
        #expect(spans.chipsByDay["2026-09-16"]?.map(\.id) == ["dinner"])
        #expect(spans.chipsByDay["2026-09-15"]?.isEmpty ?? true)
    }

    @Test func aTripCrossingTheRowEdgeIsCutThereAndSaysSo() {
        let t = trip("camping", "2026-09-18", throughExclusive: "2026-09-23")
        let bar = PhoneCalendar.weekSpans(week, byDay: Agenda.byDay([t], ny), tz: ny, maxLanes: 3).bars.first
        #expect(bar?.startCol == 5)
        #expect(bar?.endCol == 6)
        #expect(bar?.continuesBefore == false)
        #expect(bar?.continuesAfter == true)
    }

    @Test func overlappingTripsTakeSeparateLanesAndLaterOnesReuseAFreeLane() {
        let a = trip("a", "2026-09-14", throughExclusive: "2026-09-17")
        let b = trip("b", "2026-09-15", throughExclusive: "2026-09-19")
        let c = trip("c", "2026-09-17", throughExclusive: "2026-09-20")
        let spans = PhoneCalendar.weekSpans(week, byDay: Agenda.byDay([a, b, c], ny), tz: ny, maxLanes: 3)
        let lanes = Dictionary(uniqueKeysWithValues: spans.bars.map { ($0.event.id, $0.lane) })
        #expect(lanes == ["a": 0, "b": 1, "c": 0])
        #expect(spans.lanes == 2)
    }

    @Test func oneDayEventsStayChips() {
        let birthday = trip("birthday", "2026-09-16", throughExclusive: "2026-09-17")
        let spans = PhoneCalendar.weekSpans(week, byDay: Agenda.byDay([birthday], ny), tz: ny, maxLanes: 3)
        #expect(spans.bars.isEmpty)
        #expect(spans.lanes == 0)
        #expect(spans.chipsByDay["2026-09-16"]?.map(\.id) == ["birthday"])
    }

    @Test func tripsPastTheLaneCapFallBackToChips() {
        let a = trip("a", "2026-09-14", throughExclusive: "2026-09-17")
        let b = trip("b", "2026-09-15", throughExclusive: "2026-09-17")
        let spans = PhoneCalendar.weekSpans(week, byDay: Agenda.byDay([a, b], ny), tz: ny, maxLanes: 1)
        #expect(spans.bars.map(\.event.id) == ["a"])
        #expect(spans.chipsByDay["2026-09-15"]?.map(\.id) == ["b"])
    }

    @Test func aDayCellLeavesRoomForTheRowsBarLanes() {
        let c = PhoneCalendar.cellChips(eventCount: 3, countdownCount: 0, rowHeight: 200, reservedSlots: 2)
        #expect(c.shown == 2)
        #expect(c.more == 1)
    }
}
