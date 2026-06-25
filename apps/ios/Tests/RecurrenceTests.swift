import Foundation
import Testing
@testable import Nook

// Mirror of the web's `apps/web/src/kiosk/components/recurrence.test.ts` — the picker's
// RRULE build / parse / describe logic must stay byte-identical to the web's so an event
// made recurring on one surface round-trips on the other.

private func st(_ apply: (inout RepeatState) -> Void) -> RepeatState {
    var s = RepeatState.none
    apply(&s)
    return s
}

// A fixed-offset calendar so weekday/ordinal derivation is deterministic regardless of
// the machine's locale/timezone (the picker uses Calendar.current with device-local
// dates; here we pin UTC and feed UTC-noon dates).
private let cal: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}()

private func date(_ iso: String) -> Date {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(identifier: "UTC")!
    return f.date(from: iso)!
}

// Reference dates: a Monday, a Wednesday, and the 2nd Tuesday of June 2026.
private let MON = date("2026-06-22T12:00:00Z")
private let WED = date("2026-06-10T12:00:00Z")
private let TUE_2ND = date("2026-06-09T12:00:00Z")

@Suite struct RecurrenceBuildTests {
    @Test func presets() {
        #expect(Recurrence.buildRrule(st { $0.freq = .none }, start: MON, cal) == nil)
        #expect(Recurrence.buildRrule(st { $0.freq = .daily }, start: MON, cal) == "FREQ=DAILY")
        #expect(Recurrence.buildRrule(st { $0.freq = .weekdays }, start: MON, cal) == "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")
        #expect(Recurrence.buildRrule(st { $0.freq = .weekly; $0.byday = [] }, start: WED, cal) == "FREQ=WEEKLY;BYDAY=WE")
        #expect(Recurrence.buildRrule(st { $0.freq = .weekly; $0.byday = ["MO", "TH"] }, start: WED, cal) == "FREQ=WEEKLY;BYDAY=MO,TH")
        #expect(Recurrence.buildRrule(st { $0.freq = .monthly }, start: MON, cal) == "FREQ=MONTHLY")
    }

    @Test func customBuilder() {
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .day; $0.interval = 3 }, start: MON, cal) == "FREQ=DAILY;INTERVAL=3")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .week; $0.interval = 2; $0.byday = ["TU", "TH"] }, start: MON, cal) == "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .week; $0.interval = 2; $0.byday = [] }, start: MON, cal) == "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .month; $0.interval = 2; $0.monthlyMode = .day }, start: TUE_2ND, cal) == "FREQ=MONTHLY;INTERVAL=2")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .month; $0.interval = 1; $0.monthlyMode = .weekday }, start: TUE_2ND, cal) == "FREQ=MONTHLY;BYDAY=2TU")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .month; $0.interval = 1; $0.monthlyMode = .lastWeekday }, start: TUE_2ND, cal) == "FREQ=MONTHLY;BYDAY=-1TU")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .year; $0.interval = 2 }, start: MON, cal) == "FREQ=YEARLY;INTERVAL=2")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .day; $0.interval = 1 }, start: MON, cal) == "FREQ=DAILY")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.custom = "RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=TU" }, start: MON, cal) == "FREQ=WEEKLY;COUNT=5;BYDAY=TU")
        #expect(Recurrence.buildRrule(st { $0.freq = .custom; $0.unit = .week; $0.interval = 1; $0.byday = [] }, start: MON, cal) == "FREQ=WEEKLY;BYDAY=MO")
    }
}

@Suite struct RecurrenceParseTests {
    @Test func empty() {
        #expect(Recurrence.parseRepeat(nil) == RepeatState.none)
        #expect(Recurrence.parseRepeat("") == RepeatState.none)
    }

    @Test func presets() {
        #expect(Recurrence.parseRepeat("FREQ=DAILY") == st { $0.freq = .daily })
        #expect(Recurrence.parseRepeat("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") == st { $0.freq = .weekdays })
        #expect(Recurrence.parseRepeat("FREQ=WEEKLY;BYDAY=MO,TH") == st { $0.freq = .weekly; $0.byday = ["MO", "TH"] })
        #expect(Recurrence.parseRepeat("FREQ=MONTHLY") == st { $0.freq = .monthly })
    }

    @Test func intervalRules() {
        #expect(Recurrence.parseRepeat("FREQ=DAILY;INTERVAL=3") == st { $0.freq = .custom; $0.unit = .day; $0.interval = 3 })
        #expect(Recurrence.parseRepeat("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH") == st { $0.freq = .custom; $0.unit = .week; $0.interval = 2; $0.byday = ["TU", "TH"] })
        #expect(Recurrence.parseRepeat("FREQ=MONTHLY;INTERVAL=2") == st { $0.freq = .custom; $0.unit = .month; $0.interval = 2; $0.monthlyMode = .day })
        #expect(Recurrence.parseRepeat("FREQ=MONTHLY;BYDAY=2TU") == st { $0.freq = .custom; $0.unit = .month; $0.interval = 1; $0.monthlyMode = .weekday })
        #expect(Recurrence.parseRepeat("FREQ=MONTHLY;BYDAY=-1TU") == st { $0.freq = .custom; $0.unit = .month; $0.interval = 1; $0.monthlyMode = .lastWeekday })
        #expect(Recurrence.parseRepeat("FREQ=YEARLY;INTERVAL=2") == st { $0.freq = .custom; $0.unit = .year; $0.interval = 2 })
    }

    @Test func boundedRulesPreservedAsAdvanced() {
        let parsed = Recurrence.parseRepeat("FREQ=WEEKLY;COUNT=5;BYDAY=TU")
        #expect(parsed.freq == .custom)
        #expect(parsed.custom == "FREQ=WEEKLY;COUNT=5;BYDAY=TU")
    }

    @Test func roundTrip() {
        let rules = [
            "FREQ=DAILY",
            "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
            "FREQ=WEEKLY;BYDAY=MO,TH",
            "FREQ=MONTHLY",
            "FREQ=DAILY;INTERVAL=3",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
            "FREQ=MONTHLY;INTERVAL=2",
            "FREQ=MONTHLY;BYDAY=2TU",
            "FREQ=MONTHLY;BYDAY=-1TU",
            "FREQ=YEARLY;INTERVAL=2",
        ]
        for rule in rules {
            #expect(Recurrence.buildRrule(Recurrence.parseRepeat(rule), start: TUE_2ND, cal) == rule)
        }
    }
}

@Suite struct RecurrenceDescribeTests {
    @Test func plainEnglish() {
        #expect(Recurrence.describeRrule(nil, start: MON, cal) == "Does not repeat")
        #expect(Recurrence.describeRrule("FREQ=DAILY", start: MON, cal) == "Every day")
        #expect(Recurrence.describeRrule("FREQ=DAILY;INTERVAL=3", start: MON, cal) == "Every 3 days")
        #expect(Recurrence.describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", start: MON, cal) == "Every weekday (Mon–Fri)")
        #expect(Recurrence.describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH", start: MON, cal) == "Every 2 weeks on Tue, Thu")
        #expect(Recurrence.describeRrule("FREQ=MONTHLY;BYDAY=2TU", start: MON, cal) == "Every month on the second Tuesday")
        #expect(Recurrence.describeRrule("FREQ=MONTHLY;BYDAY=-1FR", start: MON, cal) == "Every month on the last Friday")
        #expect(Recurrence.describeRrule("FREQ=YEARLY;INTERVAL=2", start: MON, cal) == "Every 2 years")
    }

    @Test func countAndFallback() {
        #expect(Recurrence.describeRrule("FREQ=DAILY;COUNT=5", start: MON, cal) == "Every day, 5 times")
        #expect(Recurrence.describeRrule("FREQ=HOURLY", start: MON, cal) == "FREQ=HOURLY")
    }
}

@Suite struct RecurrenceHelperTests {
    @Test func weekdayCode() {
        #expect(Recurrence.weekdayCode(MON, cal) == "MO")
    }

    @Test func nthWeekday() {
        #expect(Recurrence.nthWeekdayOfMonth(TUE_2ND, cal) == 2)
        #expect(Recurrence.nthWeekdayOfMonth(date("2026-06-02T12:00:00Z"), cal) == 1)
    }
}
