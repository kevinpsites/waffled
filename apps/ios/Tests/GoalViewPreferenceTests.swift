import Foundation
import Testing
@testable import Waffled

// Mirrors apps/web/src/kiosk/goalViews/persist.test.ts — same per-goal keying.
@Suite struct GoalViewPreferenceTests {
    private func freshDefaults(_ name: String) -> UserDefaults {
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func returnsNilWhenNothingSaved() {
        let d = freshDefaults("test.goalview.empty")
        #expect(GoalViewPreference.get("g1", defaults: d) == nil)
    }

    @Test func roundTripsASavedView() {
        let d = freshDefaults("test.goalview.roundtrip")
        GoalViewPreference.set("g1", .month, defaults: d)
        #expect(GoalViewPreference.get("g1", defaults: d) == .month)
    }

    @Test func keepsDifferentGoalsIndependent() {
        let d = freshDefaults("test.goalview.independent")
        GoalViewPreference.set("g1", .month, defaults: d)
        GoalViewPreference.set("g2", .pace, defaults: d)
        #expect(GoalViewPreference.get("g1", defaults: d) == .month)
        #expect(GoalViewPreference.get("g2", defaults: d) == .pace)
    }
}
