import Foundation
import Testing
@testable import Waffled

// The Apple Health metric set is mirrored on the server (goals.service.ts HEALTH_METRICS)
// and drives which chips appear per goal type. These lock the pure metadata: keys stay in
// sync with the API, keys round-trip through the enum, and the boolean (rings / mood) vs
// quantity split — which decides whether a metric rides the daily-threshold-of-1 habit path
// and whether it's offered on non-habit goals — is exactly right.
@Suite struct HealthMetricTests {
    /// Must equal apps/api/src/modules/goals/goals.service.ts `HEALTH_METRICS`.
    static let apiKeys: Set<String> = [
        "steps", "flights", "exercise_minutes", "active_energy",
        "move_ring", "exercise_ring", "stand_ring", "rings_all", "mindful_minutes", "mood",
    ]

    @Test func everyMetricKeyMatchesTheServerSet() {
        #expect(Set(HealthKitBridge.Metric.allCases.map(\.key)) == Self.apiKeys)
    }

    @Test func keysRoundTrip() {
        for m in HealthKitBridge.Metric.allCases {
            #expect(HealthKitBridge.Metric(key: m.key) == m)
        }
        #expect(HealthKitBridge.Metric(key: "heartbeats") == nil)
        #expect(HealthKitBridge.Metric(key: nil) == nil)
    }

    @Test func booleanMetricsAreExactlyRingsAndMood() {
        let boolean = Set(HealthKitBridge.Metric.allCases.filter(\.isBoolean).map(\.key))
        #expect(boolean == ["move_ring", "exercise_ring", "stand_ring", "rings_all", "mood"])
    }

    @Test func booleanMetricsApplyToHabitsOnly() {
        for m in HealthKitBridge.Metric.allCases where m.isBoolean {
            #expect(m.applies(toGoalType: "habit"))
            #expect(!m.applies(toGoalType: "total"))
            #expect(!m.applies(toGoalType: "count"))
            #expect(!m.applies(toGoalType: "checklist"))
        }
    }

    @Test func quantityMetricsApplyToNumericAndHabitGoals() {
        for m in HealthKitBridge.Metric.allCases where !m.isBoolean {
            #expect(m.applies(toGoalType: "total"))
            #expect(m.applies(toGoalType: "count"))
            #expect(m.applies(toGoalType: "habit"))
            #expect(!m.applies(toGoalType: "checklist"))
        }
    }
}
