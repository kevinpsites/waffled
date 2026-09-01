import Foundation
import Testing
@testable import Waffled

// "Week starts on" is a HOUSEHOLD setting, and the meal planner grids ignored it: they
// were cut by `Cal.weekStart`, which follows the *device region's* first day. A monday
// household on a US phone therefore planned — and shopped — a Sunday-led week, which is
// not the week the server keys its grocery list by.
//
// `Cal.weekStart(_:_:_:)` is the household-aware cut. The device-following overload is
// left alone: some screens legitimately want the phone's own idea of a week.
@Suite("Planner grids cut the week where the household does")
struct PlannerWeekStartTests {
    private let tz = TimeZone(identifier: "America/Chicago")!
    private func day(_ s: String) -> Date { DateFmt.date(s, "yyyy-MM-dd", TimeZone(identifier: "America/Chicago")!)! }
    private func ymd(_ d: Date) -> String { DateFmt.string(d, "yyyy-MM-dd", tz) }

    // Wednesday 2026-08-19.
    private var midweek: Date { day("2026-08-19") }

    @Test("a monday household's week starts on the Monday before")
    func mondayHouseholdCutsOnMonday() {
        #expect(ymd(Cal.weekStart(midweek, tz, .monday)) == "2026-08-17")
    }

    @Test("a sunday household's week starts on the Sunday before")
    func sundayHouseholdCutsOnSunday() {
        #expect(ymd(Cal.weekStart(midweek, tz, .sunday)) == "2026-08-16")
    }

    @Test("a day that IS the household's first day is its own week start")
    func firstDayIsItsOwnWeekStart() {
        #expect(ymd(Cal.weekStart(day("2026-08-17"), tz, .monday)) == "2026-08-17")
        #expect(ymd(Cal.weekStart(day("2026-08-16"), tz, .sunday)) == "2026-08-16")
    }

    @Test("a monday household's Sunday belongs to the week that just ended")
    func sundayBelongsToTheOutgoingWeek() {
        // The trap: Sunday 2026-08-23 is the LAST day of the Aug 17 week for a monday
        // household, not the first day of a new one. Getting this backwards is what
        // straddled two grocery weeks.
        #expect(ymd(Cal.weekStart(day("2026-08-23"), tz, .monday)) == "2026-08-17")
        #expect(ymd(Cal.weekStart(day("2026-08-23"), tz, .sunday)) == "2026-08-23")
    }

    @Test("the month grid starts on the household's first day on or before the 1st")
    func monthGridLeadsWithTheHouseholdsDay() {
        // September 2026 starts on a Tuesday.
        let sept = day("2026-09-01")
        #expect(ymd(Cal.weekStart(sept, tz, .monday)) == "2026-08-31")
        #expect(ymd(Cal.weekStart(sept, tz, .sunday)) == "2026-08-30")
    }

    @Test("the weekday headings are read from the household's first day")
    func headingsRotate() {
        #expect(Cal.weekdaySymbols(from: .sunday) == ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"])
        #expect(Cal.weekdaySymbols(from: .monday) == ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"])
    }

    @Test("any weekday row rotates, whatever its label width")
    func rowsRotate() {
        // The grids draw different widths — one letter on a phone month, three on the
        // kiosk — so only the ORDER is shared.
        #expect(Cal.rotated(["S", "M", "T", "W", "T", "F", "S"], from: .monday) == ["M", "T", "W", "T", "F", "S", "S"])
        #expect(Cal.rotated(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], from: .monday)
                == ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
        #expect(Cal.rotated(["S", "M", "T", "W", "T", "F", "S"], from: .sunday) == ["S", "M", "T", "W", "T", "F", "S"])
    }

    @Test("a month grid's leading blanks count from the household's first day")
    func leadCells() {
        // September 2026 starts on a Tuesday.
        let sept = day("2026-09-01")
        #expect(Cal.monthLeadCells(sept, tz, .monday) == 1)   // Mon only
        #expect(Cal.monthLeadCells(sept, tz, .sunday) == 2)   // Sun, Mon
    }
}

// The goal heatmaps bucket by calendar week too, and their logic is mirrored 1:1 with
// the web's `goalStats.ts` — these assertions match `goalStats.test.ts` exactly so the
// two platforms can't drift apart.
@Suite("Goal heatmaps cut the week where the household does")
struct GoalWeekStartTests {
    @Test("a monday household's week starts on the Monday before")
    func mondayCut() {
        #expect(GoalDateKey.startOfWeek("2026-08-19", .monday) == "2026-08-17")
    }

    @Test("a sunday household's week starts on the Sunday before")
    func sundayCut() {
        #expect(GoalDateKey.startOfWeek("2026-08-19", .sunday) == "2026-08-16")
    }

    @Test("the first day is its own week start")
    func firstDayIsOwnStart() {
        #expect(GoalDateKey.startOfWeek("2026-08-17", .monday) == "2026-08-17")
        #expect(GoalDateKey.startOfWeek("2026-08-16", .sunday) == "2026-08-16")
    }

    @Test("a monday household's Sunday belongs to the week that just ended")
    func sundayClosesTheWeek() {
        #expect(GoalDateKey.startOfWeek("2026-08-23", .monday) == "2026-08-17")
        #expect(GoalDateKey.startOfWeek("2026-08-23", .sunday) == "2026-08-23")
    }
}
