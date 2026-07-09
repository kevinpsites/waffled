import Foundation
import HealthKit

/// **Tier 0 (read & suggest)** HealthKit bridge — see `docs/design/healthkit-goals.md`.
///
/// Read-only, on-demand queries of *today's* total for a small curated metric set. No
/// background delivery, no stored goal↔metric link, nothing persisted: the goal Log sheet
/// uses this only to pre-fill an amount the user still confirms and credits themselves.
///
/// HealthKit is an **iPhone-only** framework (absent on iPad hardware even though this is
/// one universal binary), so every entry point guards on `isAvailable`. A denied read
/// returns an *empty* result — indistinguishable from "no data" by Apple's design — so we
/// simply surface no suggestion rather than trying to detect the denial.
@MainActor
final class HealthKitBridge {
    static let shared = HealthKitBridge()
    private let store = HKHealthStore()

    private init() {}

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// The metrics we can read a same-day cumulative total for in Tier 0. Tier 1 adds the
    /// stored per-goal link (activity rings / mindful / mood ride in with later tiers).
    enum Metric: CaseIterable {
        case steps, flights, exerciseMinutes, activeEnergy

        /// Canonical key persisted server-side (goals.health_metric) and sent to
        /// /health-sync. Must match the API's HEALTH_METRICS set.
        var key: String {
            switch self {
            case .steps:           return "steps"
            case .flights:         return "flights"
            case .exerciseMinutes: return "exercise_minutes"
            case .activeEnergy:    return "active_energy"
            }
        }

        init?(key: String?) {
            switch key {
            case "steps":           self = .steps
            case "flights":         self = .flights
            case "exercise_minutes": self = .exerciseMinutes
            case "active_energy":   self = .activeEnergy
            default:                return nil
            }
        }

        /// Light a suggestion up on an *existing* goal by matching its free-text `unit`,
        /// so "10,000 steps" works today with no stored link (the link lands in Tier 1).
        static func matching(unit: String?) -> Metric? {
            switch unit?.lowercased() {
            case "step", "steps":                                return .steps
            case "flight", "flights", "floor", "floors":         return .flights
            case "min", "mins", "minute", "minutes":             return .exerciseMinutes
            case "cal", "cals", "calorie", "calories", "kcal":   return .activeEnergy
            default:                                             return nil
            }
        }

        var quantityType: HKQuantityType {
            switch self {
            case .steps:           return HKQuantityType(.stepCount)
            case .flights:         return HKQuantityType(.flightsClimbed)
            case .exerciseMinutes: return HKQuantityType(.appleExerciseTime)
            case .activeEnergy:    return HKQuantityType(.activeEnergyBurned)
            }
        }

        var unit: HKUnit {
            switch self {
            case .steps, .flights: return .count()
            case .exerciseMinutes: return .minute()
            case .activeEnergy:    return .kilocalorie()
            }
        }

        /// The goal `unit` stored when this metric is picked — also what
        /// `matching(unit:)` keys off, and the label shown next to a value
        /// ("7,340 steps"). Keep the two in sync.
        var label: String {
            switch self {
            case .steps:           return "steps"
            case .flights:         return "flights"
            case .exerciseMinutes: return "min"
            case .activeEnergy:    return "cal"
            }
        }

        /// Short label for the editor's picker chip.
        var chipLabel: String {
            switch self {
            case .steps:           return "Steps"
            case .flights:         return "Flights"
            case .exerciseMinutes: return "Exercise"
            case .activeEnergy:    return "Energy"
            }
        }

        /// A sensible starting target to pre-fill when the metric is picked, so the
        /// user isn't staring at an empty number field.
        var suggestedTarget: Int {
            switch self {
            case .steps:           return 10000
            case .flights:         return 10
            case .exerciseMinutes: return 30
            case .activeEnergy:    return 500
            }
        }

        /// Plain-language "what is this?" shown under the picker so the user knows what
        /// Apple Health actually tracks for each choice.
        var explanation: String {
            switch self {
            case .steps:           return "Steps counted by your iPhone and Apple Watch."
            case .flights:         return "Flights of stairs climbed, tracked by your iPhone."
            case .exerciseMinutes: return "Apple Watch exercise minutes — the green ring."
            case .activeEnergy:    return "Active calories burned — the Apple Watch move ring."
            }
        }
    }

    /// Request *read* access for the Tier-0 quantity types. Safe to call repeatedly —
    /// HealthKit only prompts the first time and never re-reveals a prior choice.
    func requestReadAuthorization() async throws {
        guard isAvailable else { return }
        let read = Set(Metric.allCases.map { $0.quantityType as HKObjectType })
        try await store.requestAuthorization(toShare: [], read: read)
    }

    /// Shared "read today's total for `metric` and push it to `goalId`" step. Used by both
    /// the goals list and a goal's detail so a linked goal fills from wherever you view it.
    /// Ensures read access first; a denied read or no data is a silent no-op. Returns true
    /// only if a value was posted (so callers know whether to refresh).
    static func push(_ api: WaffledAPI, goalId: String, metric: Metric) async -> Bool {
        guard shared.isAvailable else { return false }
        try? await shared.requestReadAuthorization()
        guard let value = await shared.todayTotal(for: metric), value > 0 else { return false }
        let day = DateFmt.string(Date(), "yyyy-MM-dd", .current)
        do { try await api.syncGoalHealth(goalId: goalId, metric: metric.key, day: day, value: value); return true }
        catch { return false }
    }

    /// Today's cumulative total for `metric` over local-day boundaries, or `nil` when
    /// unavailable / not-yet-authorized / no samples. `nil` is intentionally ambiguous
    /// (see the denied-vs-empty note above) — callers just show nothing.
    func todayTotal(for metric: Metric) async -> Double? {
        guard isAvailable else { return nil }
        let start = Calendar.current.startOfDay(for: Date())
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        return await withCheckedContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: metric.quantityType,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum
            ) { _, stats, _ in
                continuation.resume(returning: stats?.sumQuantity()?.doubleValue(for: metric.unit))
            }
            store.execute(query)
        }
    }
}
