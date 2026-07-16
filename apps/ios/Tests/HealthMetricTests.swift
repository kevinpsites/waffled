import Foundation
import HealthKit
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
        "workout_running_minutes", "workout_running_sessions",
        "workout_cycling_minutes", "workout_cycling_sessions",
        "workout_swimming_minutes", "workout_swimming_sessions",
        "workout_yoga_minutes", "workout_yoga_sessions",
        "workout_strength_minutes", "workout_strength_sessions",
        "workout_any_minutes", "workout_any_sessions",
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
        for m in HealthKitBridge.Metric.allCases where !m.isBoolean && !m.isWorkout {
            #expect(m.applies(toGoalType: "total"))
            #expect(m.applies(toGoalType: "count"))
            #expect(m.applies(toGoalType: "habit"))
            #expect(!m.applies(toGoalType: "checklist"))
        }
    }

    // Workout metrics bake the *measure* into the key, so each key has one unambiguous
    // number per day. The measure decides the goal shapes it fits: minutes SUM (a total,
    // or a daily-minutes habit) while sessions COUNT (a count of workouts, or a
    // "worked out today" habit day). Neither fits the other's shape, none are booleans.
    @Test func workoutMinutesApplyToTotalAndHabitOnly() {
        for m in HealthKitBridge.Metric.allCases where m.workoutMeasure == .minutes {
            #expect(m.isWorkout && !m.isBoolean)
            #expect(m.applies(toGoalType: "total"))
            #expect(m.applies(toGoalType: "habit"))
            #expect(!m.applies(toGoalType: "count"))
            #expect(!m.applies(toGoalType: "checklist"))
        }
    }

    @Test func workoutSessionsApplyToCountAndHabitOnly() {
        for m in HealthKitBridge.Metric.allCases where m.workoutMeasure == .sessions {
            #expect(m.isWorkout && !m.isBoolean)
            #expect(m.applies(toGoalType: "count"))
            #expect(m.applies(toGoalType: "habit"))
            #expect(!m.applies(toGoalType: "total"))
            #expect(!m.applies(toGoalType: "checklist"))
        }
    }

    @Test func workoutMetricsAreExactlyActivityTimesMeasure() {
        let workouts = HealthKitBridge.Metric.allCases.filter(\.isWorkout)
        #expect(workouts.count == 12)   // 6 activities × {minutes, sessions}
        for m in workouts { #expect(m.workoutMeasure != nil) }
        for m in HealthKitBridge.Metric.allCases where !m.isWorkout {
            #expect(m.workoutMeasure == nil)
        }
    }

    // The sibling map powers the habit qualification flip ("any workout" ↔ "at least N
    // min") and the goal-type remap — same activity, other measure, nil off workouts.
    @Test func workoutSiblingFlipsTheMeasureAndKeepsTheActivity() {
        #expect(HealthKitBridge.Metric.workoutYogaMinutes.workoutSibling == .workoutYogaSessions)
        #expect(HealthKitBridge.Metric.workoutAnySessions.workoutSibling == .workoutAnyMinutes)
        #expect(HealthKitBridge.Metric.steps.workoutSibling == nil)
        for m in HealthKitBridge.Metric.allCases where m.isWorkout {
            #expect(m.workoutSibling?.workoutSibling == m)   // involution
        }
    }

    // A day's workouts are fetched ONCE (one HKSampleQuery) and every workout metric is
    // derived from the same list in pure code — filtered by activity (strength matches
    // both of Apple's strength types; "any" matches all), then counted or summed.
    @Test func workoutValueFiltersTheDaysWorkoutsByActivity() {
        let day: [(type: HKWorkoutActivityType, minutes: Double)] = [
            (.yoga, 40), (.running, 20.5), (.functionalStrengthTraining, 25),
        ]
        #expect(HealthKitBridge.Metric.workoutYogaMinutes.workoutValue(fromDay: day) == 40)
        #expect(HealthKitBridge.Metric.workoutStrengthMinutes.workoutValue(fromDay: day) == 25)
        #expect(HealthKitBridge.Metric.workoutRunningSessions.workoutValue(fromDay: day) == 1)
        #expect(HealthKitBridge.Metric.workoutAnySessions.workoutValue(fromDay: day) == 3)
        #expect(HealthKitBridge.Metric.workoutAnyMinutes.workoutValue(fromDay: day) == 85.5)
        #expect(HealthKitBridge.Metric.workoutCyclingSessions.workoutValue(fromDay: day) == 0)
        #expect(HealthKitBridge.Metric.steps.workoutValue(fromDay: day) == nil)
    }

    // The one pure step of the new HKWorkout read path: collapsing a day's workout
    // durations into the metric's number — sessions count them, minutes sum them.
    @Test func workoutValueCountsSessionsAndSumsMinutes() {
        #expect(HealthKitBridge.Metric.workoutValue(measure: .sessions, durationsMinutes: [30, 12.5]) == 2)
        #expect(HealthKitBridge.Metric.workoutValue(measure: .minutes, durationsMinutes: [30, 12.5]) == 42.5)
        #expect(HealthKitBridge.Metric.workoutValue(measure: .sessions, durationsMinutes: []) == 0)
        #expect(HealthKitBridge.Metric.workoutValue(measure: .minutes, durationsMinutes: []) == 0)
    }

    // Every habit metric syncs a day-number the daily threshold compares against; a
    // sessions habit defaults to 1 ("any workout that day") while quantity habits keep
    // their real suggested amount.
    @Test func sessionsHabitsDefaultToOnePerDay() {
        for m in HealthKitBridge.Metric.allCases where m.workoutMeasure == .sessions {
            #expect(m.suggestedDailyTarget == 1)
        }
        #expect(HealthKitBridge.Metric.steps.suggestedDailyTarget == HealthKitBridge.Metric.steps.suggestedTarget)
    }

    // The grouped picker: sections depend on the goal type (mocks: an "adds up" list for
    // total/count vs a "qualifying days" list for habits), every listed metric must
    // actually fit the goal type, and no metric appears twice.
    @Test func pickerSectionsMatchGoalTypeAndNeverDuplicate() {
        for goalType in ["total", "count", "habit"] {
            let sections = HealthKitBridge.Metric.sections(forGoalType: goalType)
            #expect(!sections.isEmpty)
            let all = sections.flatMap(\.metrics)
            #expect(Set(all).count == all.count)   // no duplicates
            for m in all { #expect(m.applies(toGoalType: goalType)) }
        }
    }

    @Test func pickerSectionsPickTheMeasureForTheGoalType() {
        // total → workout MINUTES; count/habit → workout SESSIONS (habit's threshold
        // control can still flip an individual goal to minutes).
        let totalWorkouts = HealthKitBridge.Metric.sections(forGoalType: "total").flatMap(\.metrics).filter(\.isWorkout)
        #expect(!totalWorkouts.isEmpty && totalWorkouts.allSatisfy { $0.workoutMeasure == .minutes })
        for t in ["count", "habit"] {
            let w = HealthKitBridge.Metric.sections(forGoalType: t).flatMap(\.metrics).filter(\.isWorkout)
            #expect(!w.isEmpty && w.allSatisfy { $0.workoutMeasure == .sessions })
        }
        // Habit leads with the rings (the mock's ordering); totals lead with Everyday.
        #expect(HealthKitBridge.Metric.sections(forGoalType: "habit").first?.metrics.contains(.ringsAll) == true)
        #expect(HealthKitBridge.Metric.sections(forGoalType: "total").first?.metrics.contains(.steps) == true)
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
