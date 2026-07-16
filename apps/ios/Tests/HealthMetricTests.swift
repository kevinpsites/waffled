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
        "steps", "flights", "exercise_minutes", "active_energy", "walk_run_distance",
        "cycling_distance", "swimming_distance", "wheelchair_distance",
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

    @Test func booleanMetricsApplyToHabitAndCountGoals() {
        // A ring/mood is met-or-not per day, so it can drive a habit (a streak) or a COUNT
        // of met-days ("close the Exercise ring 15× this month"). There's nothing to *sum*,
        // so it's never offered on a total, and never on a checklist.
        for m in HealthKitBridge.Metric.allCases where m.isBoolean {
            #expect(m.applies(toGoalType: "habit"))
            #expect(m.applies(toGoalType: "count"))
            #expect(!m.applies(toGoalType: "total"))
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

    /// All four distance metrics — walk+run (Tier 1) plus cycling / swimming / wheelchair
    /// (Tier 2 slice 1). They ride the same fractional cumulative-sum path.
    static let distanceMetrics: [HealthKitBridge.Metric] = [
        .walkRunDistance, .cyclingDistance, .swimmingDistance, .wheelchairDistance,
    ]

    // Distance metrics are fractional *quantity* metrics — they must behave like steps
    // (numeric + habit, never boolean) so they ride the existing cumulative-sum path.
    @Test func distanceMetricsAreQuantityMetrics() {
        for d in Self.distanceMetrics {
            #expect(!d.isBoolean)
            #expect(d.applies(toGoalType: "total"))
            #expect(d.applies(toGoalType: "habit"))
            #expect(d.quantityType != nil)   // reads via a cumulative-sum HKQuantityType
        }
    }

    // Every distance metric shares the locale-aware km/mi unit + label, so the stored
    // number always matches the word shown next to it.
    @Test func distanceMetricsShareTheLocaleAwareUnit() {
        let expected = HealthKitBridge.Metric.walkRunDistance.quantityUnit
        for d in Self.distanceMetrics {
            #expect(d.quantityUnit == expected)
            #expect(d.label == HealthKitBridge.Metric.walkRunDistance.label)
        }
    }

    // Units follow the device's measurement system: metric locales read/label kilometers,
    // everyone else miles. The helper is pure so both branches are locked here.
    @Test func distanceUnitLabelFollowsMeasurementSystem() {
        #expect(HealthKitBridge.Metric.distanceLabel(usesMetric: true) == "km")
        #expect(HealthKitBridge.Metric.distanceLabel(usesMetric: false) == "mi")
    }

    // "3.2 mi today" — distance is fractional, so it must NOT truncate to an Int the way
    // steps/flights do.
    @Test func distanceFormatsWithOneDecimal() {
        for d in Self.distanceMetrics {
            #expect(d.formatCurrent(3.24).contains("3.2"))
        }
    }
}
