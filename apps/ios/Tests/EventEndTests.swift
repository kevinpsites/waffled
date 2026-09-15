import Foundation
import Testing
@testable import Waffled

// The event editor's Ends field. All-day events store an EXCLUSIVE end (the day after the last
// day), the same shape Google sends, so `Agenda.dayKeys` spreads an event made here exactly like
// a synced trip. Timed events keep minutes as the source of truth so moving the start keeps the length.
private let denver = TimeZone(identifier: "America/Denver")!
private var cal: Calendar { Cal.gregorian(denver) }
private func local(_ key: String, hour: Int = 0) -> Date {
    cal.date(bySettingHour: hour, minute: 0, second: 0, of: DateFmt.date(key, "yyyy-MM-dd", denver)!)!
}

@Suite struct EventEndTests {
    @Test func anAllDayEndIsNoonOnTheDayAfterTheLastDay() {
        let end = EventEnd.allDayExclusiveEnd(lastDay: local("2026-07-30", hour: 9), cal: cal)
        #expect(end == local("2026-07-31", hour: 12))
    }

    @Test func editingASyncedTripStartsFromItsLastDay() {
        let start = EventTime.parse("2026-07-27 06:00:00+00")!
        let end = EventTime.parse("2026-08-03 06:00:00+00")!
        let last = EventEnd.allDayLastDay(start: start, end: end, cal: cal)
        #expect(EventTime.dayKey(last, denver) == "2026-08-02")
    }

    @Test func aOneDayOrOpenEndedAllDayEventEndsOnItsStartDay() {
        let start = local("2026-07-11", hour: 12)
        #expect(EventTime.dayKey(EventEnd.allDayLastDay(start: start, end: nil, cal: cal), denver) == "2026-07-11")
        let nextDay = local("2026-07-12", hour: 12)
        #expect(EventTime.dayKey(EventEnd.allDayLastDay(start: start, end: nextDay, cal: cal), denver) == "2026-07-11")
    }

    @Test func aMadeHereTripSpreadsLikeASyncedOne() {
        let start = local("2026-07-27", hour: 12)
        let end = EventEnd.allDayExclusiveEnd(lastDay: local("2026-07-30"), cal: cal)
        let ev = SyncedEvent(id: "t", title: "t", startsAtRaw: nil, startsAt: start, allDay: true,
                             personId: nil, colorHex: nil, emoji: nil, endsAt: end)
        #expect(Agenda.dayKeys(ev, denver) == ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"])
    }

    @Test func aDatePickerAndATimePickerEachKeepTheOtherHalf() {
        let current = cal.date(bySettingHour: 18, minute: 30, second: 0, of: local("2026-09-14"))!
        let pickedDay = local("2026-09-16", hour: 9)
        #expect(EventEnd.combine(day: pickedDay, time: current, cal: cal)
            == cal.date(bySettingHour: 18, minute: 30, second: 0, of: local("2026-09-16")))
        let pickedTime = cal.date(bySettingHour: 7, minute: 15, second: 0, of: local("2026-01-01"))!
        #expect(EventEnd.combine(day: current, time: pickedTime, cal: cal)
            == cal.date(bySettingHour: 7, minute: 15, second: 0, of: local("2026-09-14")))
    }

    @Test func everyWhenPillReadsTheSameWay() {
        let us = Locale(identifier: "en_US")
        let at = cal.date(bySettingHour: 17, minute: 0, second: 0, of: local("2026-09-14"))!
        #expect(EventEnd.dayLabel(at, locale: us, tz: denver) == "Sep 14, 2026")
        #expect(EventEnd.dayLabel(local("2026-09-17"), locale: us, tz: denver) == "Sep 17, 2026")
        #expect(EventEnd.timeLabel(at, locale: us, tz: denver).replacingOccurrences(of: "\u{202F}", with: " ") == "5:00 PM")
    }

    @Test func theTimedEndsPickerMapsToWholeMinutesWithAFloor() {
        let start = local("2026-07-11", hour: 17)
        #expect(EventEnd.minutes(from: start, to: start.addingTimeInterval(90 * 60)) == 90)
        #expect(EventEnd.minutes(from: start, to: start.addingTimeInterval(-3600)) == 15)
        #expect(EventEnd.minutes(from: start, to: start.addingTimeInterval(26 * 3600)) == 26 * 60)
    }
}
