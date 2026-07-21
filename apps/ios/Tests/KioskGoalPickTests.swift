import Foundation
import Testing
@testable import Waffled

// The Family Goal card's pick order (KioskDashboard.featuredGoal): the pinned goal if
// it still exists, else the Spotlight goal, else a Pinned (isFeatured) goal, else a
// whole-family goal (every member participates, multi-member households only), else
// the first goal. This is the goal the card body's tap opens (PR #92), so the pick
// is pure + tested rather than buried in the view.

private func goal(_ id: String, spotlight: Bool = false, featured: Bool = false,
                  participants: [String] = []) -> WaffledAPI.Goal {
    WaffledAPI.Goal(id: id, goalListId: nil, title: id, emoji: nil,
                    category: nil, goalType: "total", unit: nil, habitPeriod: nil,
                    habitTargetPerPeriod: nil, trackingMode: "shared", participantMode: nil,
                    targetBasis: nil, deadline: nil, isFeatured: featured, isSpotlight: spotlight,
                    target: 10, totalProgress: 2, milestoneTotal: 0, milestoneReached: 0,
                    streakDays: 0, autoFromCalendar: false, healthMetric: nil,
                    createdAt: nil,
                    participants: participants.map {
                        .init(personId: $0, name: $0, colorHex: nil, avatarEmoji: nil,
                              target: nil, progress: 0)
                    })
}

@Suite struct KioskGoalPickTests {
    @Test func pinnedGoalWinsWhenItStillExists() {
        let goals = [goal("a", spotlight: true), goal("b")]
        #expect(KioskDashboard.featuredGoal(goals, pinnedId: "b", memberIds: [])?.id == "b")
    }

    @Test func stalePinFallsThroughToSpotlight() {
        let goals = [goal("a"), goal("b", spotlight: true)]
        #expect(KioskDashboard.featuredGoal(goals, pinnedId: "gone", memberIds: [])?.id == "b")
    }

    @Test func spotlightBeatsFeatured() {
        let goals = [goal("pinned-tier", featured: true), goal("hero", spotlight: true)]
        #expect(KioskDashboard.featuredGoal(goals, pinnedId: "", memberIds: [])?.id == "hero")
    }

    @Test func wholeFamilyGoalWhenNothingIsFeatured() {
        let goals = [goal("solo", participants: ["a"]),
                     goal("family", participants: ["a", "b", "c"])]
        #expect(KioskDashboard.featuredGoal(goals, pinnedId: "", memberIds: ["a", "b"])?.id == "family")
    }

    @Test func singleMemberHouseholdSkipsTheFamilyRule() {
        // With one member every goal is "whole family" — fall to the first goal instead.
        let goals = [goal("first", participants: ["a"]), goal("second", participants: ["a"])]
        #expect(KioskDashboard.featuredGoal(goals, pinnedId: "", memberIds: ["a"])?.id == "first")
    }

    @Test func noGoalsMeansNoCard() {
        #expect(KioskDashboard.featuredGoal([], pinnedId: "x", memberIds: ["a"]) == nil)
    }
}
