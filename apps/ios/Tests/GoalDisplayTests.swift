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
    stepDone: Int? = nil,
    streakDays: Int = 0,
    targetBasis: String? = nil,
    people: Int = 0,
    loggedTodayBy: [String]? = nil
) -> WaffledAPI.Goal {
    WaffledAPI.Goal(id: "g", goalListId: nil, title: "G", emoji: nil, category: nil,
                    goalType: goalType, unit: nil, habitPeriod: habitPeriod,
                    habitTargetPerPeriod: habitTargetPerPeriod, trackingMode: "shared_total",
                    participantMode: nil, targetBasis: targetBasis, deadline: nil, isFeatured: false,
                    isSpotlight: nil, target: target, totalProgress: totalProgress,
                    milestoneTotal: 0, milestoneReached: 0, periodDone: periodDone,
                    stepTotal: stepTotal, stepDone: stepDone, streakDays: streakDays,
                    loggedTodayBy: loggedTodayBy,
                    autoFromCalendar: false, healthMetric: nil, createdAt: nil,
                    participants: (0..<people).map {
                        .init(personId: "p\($0)", name: "P\($0)", colorHex: nil,
                              avatarEmoji: nil, target: target, progress: 0)
                    })
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

    @Test func perPersonTargetIsThePerPersonNumberTimesTheMembers() {
        // "read 12 books EACH", 2 people, both read 12 → 24 of 24, not 24 of 12.
        // Mirrors goals-display.test.ts's per_person case.
        let g = goal(goalType: "count", target: 12, totalProgress: 24, targetBasis: "per_person", people: 2)
        #expect(GoalDisplay.target(g) == 24)
        #expect(GoalDisplay.progress(g) == 24)
        #expect(GoalDisplay.fraction(g) == 1) // full, not overflowing past 100%
    }

    @Test func perPersonWithNoMembersYetKeepsTheFlatTarget() {
        let g = goal(goalType: "count", target: 12, totalProgress: 0, targetBasis: "per_person", people: 0)
        #expect(GoalDisplay.target(g) == 12)
    }

    @Test func familyBasisTargetIsTheFlatNumber() {
        let g = goal(goalType: "total", target: 1000, totalProgress: 312, targetBasis: "family", people: 4)
        #expect(GoalDisplay.target(g) == 1000)
    }

    @Test func fractionClampsAtFullAndSurvivesAMissingTarget() {
        #expect(GoalDisplay.fraction(goal(goalType: "count", target: 10, totalProgress: 25)) == 1)
        #expect(GoalDisplay.fraction(goal(goalType: "count", target: nil, totalProgress: 25)) == 0)
        #expect(GoalDisplay.fraction(goal(goalType: "count", target: 0, totalProgress: 25)) == 0)
    }

    // MARK: milestones — the axis the SERVER used to decide `reached`

    @Test func habitMilestonesAreMeasuredInStreakDays() {
        // A habit's milestones are streak days server-side ("🔥 7 days"), so a lifetime
        // log count would mark them reached far too early — and 99 logs would claim a
        // 7-day milestone was long past when the streak is only 3.
        let g = goal(goalType: "habit", target: 5, totalProgress: 99,
                     habitPeriod: "week", habitTargetPerPeriod: 5, periodDone: 2, streakDays: 3)
        #expect(GoalDisplay.milestoneAxis(g) == 3)
        #expect(GoalDisplay.milestoneToGo(g, threshold: 7, fmt: goalFmt) == "4-day streak to go")
    }

    @Test func checklistMilestonesAreMeasuredInPercentComplete() {
        let g = goal(goalType: "checklist", totalProgress: 3, stepTotal: 5, stepDone: 3)
        #expect(GoalDisplay.milestoneAxis(g) == 60)
        #expect(GoalDisplay.milestoneToGo(g, threshold: 75, fmt: goalFmt) == "15% to go")
    }

    @Test func emptyChecklistIsZeroPercentNotADivideByZero() {
        let g = goal(goalType: "checklist", stepTotal: 0, stepDone: 0)
        #expect(GoalDisplay.milestoneAxis(g) == 0)
    }

    @Test func numericMilestonesStayOnTheCumulativeTotal() {
        let g = goal(goalType: "total", target: 1000, totalProgress: 312)
        #expect(GoalDisplay.milestoneAxis(g) == 312)
        #expect(GoalDisplay.milestoneToGo(g, threshold: 500, fmt: goalFmt) == "188 to go")
    }

    @Test func aPassedMilestoneNeverReadsNegative() {
        let g = goal(goalType: "total", target: 1000, totalProgress: 900)
        #expect(GoalDisplay.milestoneToGo(g, threshold: 500, fmt: goalFmt) == "0 to go")
    }

    // MARK: "already done today" — a habit is once per day PER PERSON

    @Test func aHabitIsDoneTodayWhenEveryonePickedHasAlreadyLogged() {
        let g = goal(goalType: "habit", habitTargetPerPeriod: 5, periodDone: 1, loggedTodayBy: ["p0"])
        #expect(GoalDisplay.doneToday(g, who: ["p0"]))
    }

    @Test func aHabitIsNotDoneTodayWhileSomeonePickedStillOwesToday() {
        // Two people picked, only one has logged — the other's completion is still live,
        // and the server will write it (it dedupes per person, not per goal).
        let g = goal(goalType: "habit", habitTargetPerPeriod: 5, periodDone: 1, loggedTodayBy: ["p0"])
        #expect(!GoalDisplay.doneToday(g, who: ["p0", "p1"]))
    }

    @Test func aFamilyLogCountsUnderItsOwnSentinel() {
        // A no-person (shared) log comes back as "__family__", not a person id.
        let g = goal(goalType: "habit", habitTargetPerPeriod: 5, periodDone: 1,
                     loggedTodayBy: ["__family__"])
        #expect(GoalDisplay.doneToday(g, who: ["__family__"]))
        #expect(!GoalDisplay.doneToday(g, who: ["p0"]))
    }

    @Test func nothingIsBlockedWithNobodyPickedOrOnANonHabit() {
        let habit = goal(goalType: "habit", habitTargetPerPeriod: 5, loggedTodayBy: ["p0"])
        #expect(!GoalDisplay.doneToday(habit, who: []))
        // Only habits are once-a-day; a count goal can be logged all day long.
        let count = goal(goalType: "count", target: 20, loggedTodayBy: ["p0"])
        #expect(!GoalDisplay.doneToday(count, who: ["p0"]))
    }

    @Test func anOlderResponseWithoutLoggedTodayByBlocksNothing() {
        // Missing the field must not gate the button shut — the server still dedupes.
        let g = goal(goalType: "habit", habitTargetPerPeriod: 5, loggedTodayBy: nil)
        #expect(!GoalDisplay.doneToday(g, who: ["p0"]))
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

    @Test func anOverviewHabitCarriesItsPeriodCountIntoTheGoalItPushes() throws {
        // The overview measures each goal on its own axis, so `progress` here IS the
        // period count. Tapping the row pushes a goal detail; its hero must open on the
        // same number the row showed, not a blank ring.
        let json = """
        {"id":"g1","title":"Move","emoji":null,"category":null,"unit":null,
         "goalType":"habit","progress":2,"target":5,"pct":40,"streakDays":3,
         "periodDone":2,"habitPeriod":"week","habitTargetPerPeriod":5}
        """
        let row = try JSONDecoder().decode(WaffledAPI.PersonOverview.Goal.self, from: Data(json.utf8))
        #expect(GoalDisplay.progress(row.asGoal) == 2)
        #expect(GoalDisplay.target(row.asGoal) == 5)
    }

    @Test func anOverviewHabitFromAnOlderServerDoesNotPassOffALifetimeTotal() throws {
        // No `periodDone` means an older server, where `progress` was the LIFETIME count.
        // Carrying it over would put the original bug back on the pushed detail ("99 of 5
        // this week"), so the period axis stays unknown here.
        let json = """
        {"id":"g1","title":"Move","emoji":null,"category":null,"unit":null,
         "goalType":"habit","progress":99,"target":5,"pct":100,"streakDays":3}
        """
        let row = try JSONDecoder().decode(WaffledAPI.PersonOverview.Goal.self, from: Data(json.utf8))
        #expect(row.asGoal.periodDone == nil)
        #expect(GoalDisplay.progress(row.asGoal) == 0)
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
