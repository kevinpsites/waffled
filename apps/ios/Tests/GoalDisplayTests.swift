import Foundation
import Testing
@testable import Waffled

// Mirrors apps/web/src/lib/api/goals-display.test.ts — same fixtures, same expectations —
// so a goal reads identically on both platforms. See GoalDisplay.swift.
//
// The bug this locks down: a habit ("5× a week") was showing its LIFETIME log count on
// every iOS goal surface, so logging once last week and once this week read "2 of 5"
// instead of resetting to "1 of 5" at the start of the week. The server has always sent
// the per-period count (`periodDone`); iOS simply never decoded it.

private func goal(
    goalType: String = "total",
    target: Double? = nil,
    totalProgress: Double = 0,
    habitPeriod: String? = nil,
    habitTargetPerPeriod: Int? = nil,
    periodDone: Double? = nil,
    stepTotal: Int? = nil,
    stepDone: Int? = nil
) -> WaffledAPI.Goal {
    WaffledAPI.Goal(id: "g", goalListId: nil, title: "G", emoji: nil, category: nil,
                    goalType: goalType, unit: nil, habitPeriod: habitPeriod,
                    habitTargetPerPeriod: habitTargetPerPeriod, trackingMode: "shared_total",
                    participantMode: nil, targetBasis: nil, deadline: nil, isFeatured: false,
                    isSpotlight: nil, target: target, totalProgress: totalProgress,
                    milestoneTotal: 0, milestoneReached: 0, periodDone: periodDone,
                    stepTotal: stepTotal, stepDone: stepDone, streakDays: 0,
                    autoFromCalendar: false, healthMetric: nil, createdAt: nil, participants: [])
}

@Suite struct GoalDisplayTests {

    // MARK: habit — the reported bug

    @Test func habitShowsThisPeriodNotTheLifetimeTotal() {
        // 99 logs all-time, 2 of them this week: the ring is 2 of 5, not 99 of 5.
        let g = goal(goalType: "habit", target: 5, totalProgress: 99,
                     habitPeriod: "week", habitTargetPerPeriod: 5, periodDone: 2)
        #expect(GoalDisplay.progress(g) == 2)
        #expect(GoalDisplay.target(g) == 5)
        #expect(abs(GoalDisplay.fraction(g) - 0.4) < 0.0001)
    }

    @Test func habitFallsBackToTheGoalTargetWhenCadenceIsMissing() {
        // Older goals stored the cadence only in target_value.
        let g = goal(goalType: "habit", target: 3, totalProgress: 9,
                     habitPeriod: "week", habitTargetPerPeriod: nil, periodDone: 1)
        #expect(GoalDisplay.target(g) == 3)
    }

    @Test func habitFromAnOlderResponseWithoutPeriodDoneReadsZeroNotTheTotal() {
        // A cached/older payload must never fall back to the lifetime total — that is
        // exactly the wrong number, and showing 0 makes the staleness obvious instead.
        let g = goal(goalType: "habit", target: 5, totalProgress: 99,
                     habitPeriod: "week", habitTargetPerPeriod: 5, periodDone: nil)
        #expect(GoalDisplay.progress(g) == 0)
    }

    @Test func habitPeriodLabelNamesTheWindow() {
        #expect(GoalDisplay.periodLabel(goal(goalType: "habit", habitPeriod: "day")) == "today")
        #expect(GoalDisplay.periodLabel(goal(goalType: "habit", habitPeriod: "week")) == "this week")
        #expect(GoalDisplay.periodLabel(goal(goalType: "habit", habitPeriod: "month")) == "this month")
        // Unset cadence defaults to the week, matching the web goals list.
        #expect(GoalDisplay.periodLabel(goal(goalType: "habit", habitPeriod: nil)) == "this week")
        // Only habits carry a period.
        #expect(GoalDisplay.periodLabel(goal(goalType: "total")) == nil)
    }

    // MARK: checklist — steps, not the log total

    @Test func checklistShowsStepsDoneOverStepTotal() {
        let g = goal(goalType: "checklist", target: nil, totalProgress: 3, stepTotal: 5, stepDone: 3)
        #expect(GoalDisplay.progress(g) == 3)
        #expect(GoalDisplay.target(g) == 5)
        #expect(abs(GoalDisplay.fraction(g) - 0.6) < 0.0001)
    }

    @Test func emptyChecklistHasNoTargetAndAnEmptyBar() {
        let g = goal(goalType: "checklist", target: nil, totalProgress: 0, stepTotal: 0, stepDone: 0)
        #expect(GoalDisplay.target(g) == nil)
        #expect(GoalDisplay.fraction(g) == 0)
    }

    // MARK: everything else keeps the cumulative axis

    @Test func numericGoalStillShowsTheCumulativeTotal() {
        let g = goal(goalType: "total", target: 1000, totalProgress: 312)
        #expect(GoalDisplay.progress(g) == 312)
        #expect(GoalDisplay.target(g) == 1000)
        #expect(abs(GoalDisplay.fraction(g) - 0.312) < 0.0001)
    }

    @Test func fractionClampsAtFullAndSurvivesAMissingTarget() {
        #expect(GoalDisplay.fraction(goal(goalType: "count", target: 10, totalProgress: 25)) == 1)
        #expect(GoalDisplay.fraction(goal(goalType: "count", target: nil, totalProgress: 25)) == 0)
        #expect(GoalDisplay.fraction(goal(goalType: "count", target: 0, totalProgress: 25)) == 0)
    }

    // MARK: decoding — the new fields must be optional

    @Test func decodesAGoalPayloadCarryingTheNewFields() throws {
        let json = """
        {"id":"g1","goalListId":null,"title":"Move","emoji":null,"category":null,
         "goalType":"habit","unit":null,"habitPeriod":"week","habitTargetPerPeriod":5,
         "trackingMode":"shared_total","participantMode":"count_once","targetBasis":"family",
         "deadline":null,"isFeatured":false,"isSpotlight":false,"target":5,"totalProgress":9,
         "milestoneTotal":0,"milestoneReached":0,"periodDone":2,"stepTotal":0,"stepDone":0,
         "streakDays":3,"autoFromCalendar":false,"healthMetric":null,"createdAt":null,
         "participants":[]}
        """
        let g = try JSONDecoder().decode(WaffledAPI.Goal.self, from: Data(json.utf8))
        #expect(g.periodDone == 2)
        #expect(GoalDisplay.progress(g) == 2)
    }

    @Test func decodesAnOlderGoalPayloadWithoutTheNewFields() throws {
        // A response from an older server (or a cached one) must still decode — a strict
        // Decodable failure surfaces to the user as a bogus "couldn't reach server".
        let json = """
        {"id":"g1","goalListId":null,"title":"Move","emoji":null,"category":null,
         "goalType":"habit","unit":null,"habitPeriod":"week","habitTargetPerPeriod":5,
         "trackingMode":"shared_total","participantMode":"count_once","targetBasis":"family",
         "deadline":null,"isFeatured":false,"isSpotlight":false,"target":5,"totalProgress":9,
         "milestoneTotal":0,"milestoneReached":0,
         "streakDays":3,"autoFromCalendar":false,"healthMetric":null,"createdAt":null,
         "participants":[]}
        """
        let g = try JSONDecoder().decode(WaffledAPI.Goal.self, from: Data(json.utf8))
        #expect(g.periodDone == nil)
        #expect(g.stepTotal == nil)
    }
}
