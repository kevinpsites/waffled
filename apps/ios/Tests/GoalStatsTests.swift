import Foundation
import Testing
@testable import Waffled

// Mirrors apps/web/src/lib/goalStats.test.ts — same fixtures, same expectations —
// so the derived stats stay identical across platforms. See GoalStats.swift.
@Suite struct GoalStatsTests {

    // MARK: local-date key helpers (no timestamp-drift gotcha)

    @Test func roundTripsDateKey() {
        var c = DateComponents()
        c.year = 2026; c.month = 7; c.day = 17
        let cal = Calendar(identifier: .gregorian)
        let d = cal.date(from: c)!
        #expect(GoalDateKey.toKey(d) == "2026-07-17")
        let back = GoalDateKey.parse("2026-07-17")
        let comps = cal.dateComponents([.year, .month, .day], from: back)
        #expect(comps.year == 2026 && comps.month == 7 && comps.day == 17)
    }

    @Test func addDaysRollsOverMonthAndYearBoundaries() {
        #expect(GoalDateKey.addDays("2026-01-31", 1) == "2026-02-01")
        #expect(GoalDateKey.addDays("2026-12-31", 1) == "2027-01-01")
        #expect(GoalDateKey.addDays("2026-03-01", -1) == "2026-02-28") // 2026 not a leap year
        #expect(GoalDateKey.addDays("2024-03-01", -1) == "2024-02-29") // 2024 IS a leap year
    }

    @Test func addDaysCrossesSpringForwardDSTBoundary() {
        // US DST 2026 spring-forward is Mar 8. Adding 1 calendar day must land on Mar 9.
        #expect(GoalDateKey.addDays("2026-03-08", 1) == "2026-03-09")
    }

    @Test func diffDaysCountsWholeDaysBetweenKeys() {
        #expect(GoalDateKey.diffDays("2026-01-10", "2026-01-01") == 9)
        #expect(GoalDateKey.diffDays("2026-01-01", "2026-01-10") == -9)
        #expect(GoalDateKey.diffDays("2026-01-01", "2026-01-01") == 0)
    }

    // MARK: heat ramp

    @Test func heatRampEndsAndClamps() {
        #expect(GoalStats.heat(0) == (233, 245, 236))
        #expect(GoalStats.heat(1) == (18, 99, 61))
        #expect(GoalStats.heat(-5) == GoalStats.heat(0))
        #expect(GoalStats.heat(5) == GoalStats.heat(1))
    }

    // MARK: timeframe classification

    @Test func classifyTimeframe() {
        #expect(GoalStats.classifyTimeframe(startDate: "2026-01-01", endDate: nil) == .openEnded)
        #expect(GoalStats.classifyTimeframe(startDate: "2026-07-01", endDate: "2026-07-14") == .short)
        #expect(GoalStats.classifyTimeframe(startDate: "2026-01-01", endDate: "2026-12-31") == .long)
        #expect(GoalStats.classifyTimeframe(startDate: "2026-01-01", endDate: "2028-01-01") == .long)
    }

    // MARK: goal-type -> view mapping

    @Test func totalGoalViewMapping() {
        #expect(GoalStats.defaultView(goalType: "total", timeframe: .long) == .pace)
        #expect(GoalStats.availableViews(goalType: "total", timeframe: .long) == [.week, .month, .year, .pace, .yearRing, .byPerson])
        #expect(GoalStats.availableViews(goalType: "total", timeframe: .short) == [.week, .pace, .byPerson])
        #expect(GoalStats.defaultView(goalType: "total", timeframe: .short) == .pace)
    }

    @Test func countGoalViewMapping() {
        #expect(GoalStats.defaultView(goalType: "count", timeframe: .long) == .collection)
        #expect(GoalStats.availableViews(goalType: "count", timeframe: .long) == [.month, .pace, .collection])
        #expect(GoalStats.availableViews(goalType: "count", timeframe: .short) == [.pace, .collection])
    }

    @Test func habitGoalViewMapping() {
        #expect(GoalStats.defaultView(goalType: "habit", timeframe: .long) == .consistency)
        #expect(GoalStats.availableViews(goalType: "habit", timeframe: .long) == [.consistency, .week])
        #expect(GoalStats.availableViews(goalType: "habit", timeframe: .short) == [.week])
        #expect(GoalStats.defaultView(goalType: "habit", timeframe: .short) == .week)
    }

    @Test func checklistGoalHasNoSwitcher() {
        #expect(GoalStats.availableViews(goalType: "checklist", timeframe: .long) == [])
        #expect(GoalStats.defaultView(goalType: "checklist", timeframe: .long) == nil)
    }

    // MARK: computeGoalStats

    private let days: [DayEntry] = [
        DayEntry(dateKey: "2026-07-10", total: 8.3, perMember: ["wally": 4, "kevin": 4.3]),
        DayEntry(dateKey: "2026-07-11", total: 5.9, perMember: ["wally": 5.9]),
        DayEntry(dateKey: "2026-07-15", total: 1.5, perMember: ["wally": 1.5]),
        DayEntry(dateKey: "2026-07-16", total: 3.9, perMember: ["kelly": 2, "wally": 1.9]),
        DayEntry(dateKey: "2026-07-17", total: 2.5, perMember: ["wally": 2.5]),
    ]

    @Test func sumsTotalAndTracksBestDay() {
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: days)
        let expectedTotal: Double = 8.3 + 5.9 + 1.5 + 3.9 + 2.5
        #expect(abs(s.total - expectedTotal) < 0.001)
        #expect(s.bestDay?.dateKey == "2026-07-10")
        #expect(s.bestDay?.total == 8.3)
    }

    @Test func dayEntryZeroFillsQuietly() {
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: days)
        #expect(s.byDay["2026-07-12"] == nil)
        let filled = s.dayEntry("2026-07-12")
        #expect(filled.total == 0 && filled.perMember.isEmpty)
        #expect(s.dayEntry("2026-07-10").total == 8.3)
    }

    @Test func currentStreakCountsConsecutiveActiveDaysEndingToday() {
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: days)
        #expect(s.currentStreak == 3) // Jul 15-16-17
    }

    @Test func currentStreakIsZeroWhenStale() {
        let stale = [DayEntry(dateKey: "2026-07-10", total: 3, perMember: [:])]
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: stale)
        #expect(s.currentStreak == 0)
    }

    @Test func longestStreakFindsTheLongestRun() {
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: days)
        #expect(s.longestStreak == 3)
    }

    @Test func weekMaxIsMaxOfLast7DaysEndingToday() {
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: days)
        #expect(s.weekMax == 5.9) // Jul 11..17, excludes Jul 10
    }

    @Test func paceIsNilForOpenEndedGoal() {
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: days)
        #expect(s.pace == nil)
    }

    @Test func paceDerivesFromTheGoalsOwnWindow() {
        let shortDays = [DayEntry(dateKey: "2026-07-03", total: 60, perMember: [:])]
        let s = GoalStats.compute(today: "2026-07-06", startDate: "2026-07-01", endDate: "2026-07-11", target: 100, days: shortDays)
        #expect(s.pace?.paceValue == 50) // 100 * 5/10
        #expect(s.pace?.delta == 10) // 60 - 50
    }

    @Test func paceClampsElapsedOncePastTheEndDate() {
        let s = GoalStats.compute(today: "2026-08-01", startDate: "2026-07-01", endDate: "2026-07-11", target: 100, days: [])
        #expect(s.pace?.paceValue == 100)
    }

    @Test func byMonthPerMemberBucketsPerCalendarMonth() {
        let s = GoalStats.compute(today: "2026-07-17", startDate: "2026-01-01", endDate: nil, target: 1000, days: days)
        let july = s.byMonthPerMember[6]
        let wally: Double = july["wally"] ?? 0
        let expectedWally: Double = 4 + 5.9 + 1.5 + 1.9 + 2.5
        #expect(abs(wally - expectedWally) < 0.001)
        #expect(july["kevin"] == 4.3)
        #expect(july["kelly"] == 2)
        #expect(s.byMonthPerMember[0].isEmpty)
    }
}
