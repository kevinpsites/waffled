import Foundation
import Testing
@testable import Waffled

// The Family hub's deep-link mapping — the string names `WAFFLED_OPEN_HUB` accepts.
// A green build proves a destination exists; it cannot prove anything navigates there,
// so the mapping gets a test.
@Suite struct FamilyHubRouteTests {

    @Test func planningIsReachableByName() {
        #expect(FamilyView.route(for: "planning") == .weeklyPlanning)
    }

    @Test func theEstablishedNamesStillResolve() {
        #expect(FamilyView.route(for: "chores") == .chores)
        #expect(FamilyView.route(for: "goals") == .goals)
        #expect(FamilyView.route(for: "settings") == .settings)
        // "display" deliberately maps to a SETTINGS sub-route, not a top-level page.
        #expect(FamilyView.route(for: "display") == .settingsDisplay)
    }

    @Test func anUnknownNameIsNilRatherThanADefault() {
        // A typo must leave you where you were — a wrong screen reads as a bug in the screen.
        #expect(FamilyView.route(for: "planing") == nil)
        #expect(FamilyView.route(for: "") == nil)
    }

    // The config panel has its own name so its switches can be verified headlessly. It is
    // NOT the session: `planning` starts/resumes one, this one only configures it.
    @Test func theSettingsPanelHasItsOwnName() {
        #expect(FamilyView.route(for: "settingsPlanning") == .settingsWeeklyPlanning)
        #expect(FamilyView.route(for: "planning") == .weeklyPlanning)
    }
}
