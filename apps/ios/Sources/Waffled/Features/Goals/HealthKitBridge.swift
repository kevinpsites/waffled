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

        /// Short label shown next to the value ("7,340 steps").
        var label: String {
            switch self {
            case .steps:           return "steps"
            case .flights:         return "flights"
            case .exerciseMinutes: return "min"
            case .activeEnergy:    return "cal"
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
