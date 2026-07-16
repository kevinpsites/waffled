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
        // Declaration order drives the editor's chip order — keep the boolean rings
        // grouped together at the end, after the numeric metrics + mindful + mood.
        case steps, flights, exerciseMinutes, activeEnergy, walkRunDistance
        case cyclingDistance, swimmingDistance, wheelchairDistance
        case mindfulMinutes, mood
        case moveRing, exerciseRing, standRing, ringsAll
        // Workout-type metrics (Tier 2): one activity × one measure per case. Unlike the
        // cumulative quantities above these read HKWorkout samples, and the *measure* is
        // baked into the key so each key syncs one unambiguous number per day.
        case workoutRunningMinutes, workoutRunningSessions
        case workoutCyclingMinutes, workoutCyclingSessions
        case workoutSwimmingMinutes, workoutSwimmingSessions
        case workoutYogaMinutes, workoutYogaSessions
        case workoutStrengthMinutes, workoutStrengthSessions
        case workoutAnyMinutes, workoutAnySessions

        /// How a workout metric collapses a day's workouts into a number: summed minutes
        /// ("300 min of yoga") or a session count ("swam 12×" / "a day with a run").
        enum WorkoutMeasure { case minutes, sessions }

        /// Activity + measure + key fragment for the workout metrics; nil for everything
        /// else. `activities` is empty for the any-workout pair (no activity filter);
        /// strength matches both of Apple's strength-training activity types.
        var workoutInfo: (activities: [HKWorkoutActivityType], measure: WorkoutMeasure, slug: String)? {
            switch self {
            case .workoutRunningMinutes:   return ([.running], .minutes, "running")
            case .workoutRunningSessions:  return ([.running], .sessions, "running")
            case .workoutCyclingMinutes:   return ([.cycling], .minutes, "cycling")
            case .workoutCyclingSessions:  return ([.cycling], .sessions, "cycling")
            case .workoutSwimmingMinutes:  return ([.swimming], .minutes, "swimming")
            case .workoutSwimmingSessions: return ([.swimming], .sessions, "swimming")
            case .workoutYogaMinutes:      return ([.yoga], .minutes, "yoga")
            case .workoutYogaSessions:     return ([.yoga], .sessions, "yoga")
            case .workoutStrengthMinutes:
                return ([.traditionalStrengthTraining, .functionalStrengthTraining], .minutes, "strength")
            case .workoutStrengthSessions:
                return ([.traditionalStrengthTraining, .functionalStrengthTraining], .sessions, "strength")
            case .workoutAnyMinutes:       return ([], .minutes, "any")
            case .workoutAnySessions:      return ([], .sessions, "any")
            default:                       return nil
            }
        }
        var isWorkout: Bool { workoutInfo != nil }
        var workoutMeasure: WorkoutMeasure? { workoutInfo?.measure }

        /// The sibling workout metric with the other measure (same activity), used when a
        /// goal-type switch strands a pick — a swim-minutes total flipping to a count goal
        /// becomes swim-sessions instead of falling all the way back to steps.
        var workoutSibling: Metric? {
            guard let info = workoutInfo else { return nil }
            let other: WorkoutMeasure = info.measure == .minutes ? .sessions : .minutes
            return Metric.allCases.first { $0.workoutInfo?.slug == info.slug && $0.workoutMeasure == other }
        }

        /// The one pure step of the workout read path: a day's workout durations → the
        /// metric's number (count them or sum them).
        static func workoutValue(measure: WorkoutMeasure, durationsMinutes: [Double]) -> Double {
            measure == .sessions ? Double(durationsMinutes.count) : durationsMinutes.reduce(0, +)
        }

        /// Canonical key persisted server-side (goals.health_metric) and sent to
        /// /health-sync. Must match the API's HEALTH_METRICS set.
        var key: String {
            if let w = workoutInfo {
                return "workout_\(w.slug)_\(w.measure == .minutes ? "minutes" : "sessions")"
            }
            switch self {
            case .steps:           return "steps"
            case .flights:         return "flights"
            case .exerciseMinutes: return "exercise_minutes"
            case .activeEnergy:    return "active_energy"
            case .walkRunDistance: return "walk_run_distance"
            case .cyclingDistance: return "cycling_distance"
            case .swimmingDistance: return "swimming_distance"
            case .wheelchairDistance: return "wheelchair_distance"
            case .moveRing:        return "move_ring"
            case .exerciseRing:    return "exercise_ring"
            case .standRing:       return "stand_ring"
            case .ringsAll:        return "rings_all"
            case .mindfulMinutes:  return "mindful_minutes"
            case .mood:            return "mood"
            // Workout metrics returned above; a *new* metric missing its arm yields ""
            // and fails everyMetricKeyMatchesTheServerSet rather than compiling silently.
            default:               return ""
            }
        }

        init?(key: String?) {
            guard let m = Metric.allCases.first(where: { $0.key == key }) else { return nil }
            self = m
        }

        /// Light a suggestion up on an *existing* goal by matching its free-text `unit`,
        /// so "10,000 steps" works today with no stored link. Only the quantity metrics
        /// carry a meaningful free-text unit (rings/mood are picked explicitly).
        static func matching(unit: String?) -> Metric? {
            switch unit?.lowercased() {
            case "step", "steps":                                return .steps
            case "flight", "flights", "floor", "floors":         return .flights
            case "min", "mins", "minute", "minutes":             return .exerciseMinutes
            case "cal", "cals", "calorie", "calories", "kcal":   return .activeEnergy
            case "mi", "mile", "miles", "km", "kilometer",
                 "kilometers", "kilometre", "kilometres":        return .walkRunDistance
            default:                                             return nil
            }
        }

        /// A day is met/not-met (rings closed, mood logged) rather than a running number.
        /// These are habit-only and sync 1 (met) / 0 (not) against an implicit daily
        /// threshold of 1 — so the editor hides the threshold field for them.
        var isBoolean: Bool {
            switch self {
            case .moveRing, .exerciseRing, .standRing, .ringsAll, .mood: return true
            default: return false
            }
        }

        /// Which goal types can link this metric. Quantity metrics fit habit (daily
        /// threshold), total (sum), and count. A boolean (ring/mood) is met-or-not per day,
        /// so it drives a habit (streak) or a *count* of met-days ("close the ring 15×") —
        /// but there's nothing to sum, so never a total. Never checklists.
        func applies(toGoalType goalType: String) -> Bool {
            // A workout measure fits the goal shape it *is*: minutes SUM (total, or a
            // daily-minutes habit), sessions COUNT (count, or a "worked out today" habit).
            if let measure = workoutMeasure {
                switch goalType {
                case "habit": return true
                case "total": return measure == .minutes
                case "count": return measure == .sessions
                default:      return false
                }
            }
            switch goalType {
            case "habit", "count": return true
            case "total":          return !isBoolean
            default:               return false   // checklist / unknown
            }
        }

        /// HealthKit object types to request *read* access for. Quantity + category types
        /// map 1:1; rings read the daily activity summary; mood reads State of Mind (iOS 17+).
        var readTypes: Set<HKObjectType> {
            if isWorkout { return [HKObjectType.workoutType()] }
            switch self {
            case .steps, .flights, .exerciseMinutes, .activeEnergy, .walkRunDistance,
                 .cyclingDistance, .swimmingDistance, .wheelchairDistance:
                return quantityType.map { [$0] } ?? []
            case .mindfulMinutes:
                return [HKCategoryType(.mindfulSession)]
            case .moveRing, .exerciseRing, .standRing, .ringsAll:
                return [HKObjectType.activitySummaryType()]
            case .mood:
                if #available(iOS 17.0, *) { return [HKObjectType.stateOfMindType()] }
                return []
            default:   // workout metrics returned above
                return []
            }
        }

        /// HKQuantityType for the cumulative-sum metrics; nil for rings/mood/mindful
        /// (which use their own query shapes).
        var quantityType: HKQuantityType? {
            switch self {
            case .steps:           return HKQuantityType(.stepCount)
            case .flights:         return HKQuantityType(.flightsClimbed)
            case .exerciseMinutes: return HKQuantityType(.appleExerciseTime)
            case .activeEnergy:    return HKQuantityType(.activeEnergyBurned)
            case .walkRunDistance: return HKQuantityType(.distanceWalkingRunning)
            case .cyclingDistance: return HKQuantityType(.distanceCycling)
            case .swimmingDistance: return HKQuantityType(.distanceSwimming)
            case .wheelchairDistance: return HKQuantityType(.distanceWheelchair)
            default:               return nil
            }
        }

        /// The unit its cumulative sum is read in (quantity metrics only). Distance is read
        /// in the device's system (km for metric locales, miles otherwise) so the number we
        /// store matches the `label` shown next to it.
        var quantityUnit: HKUnit? {
            switch self {
            case .steps, .flights: return .count()
            case .exerciseMinutes: return .minute()
            case .activeEnergy:    return .kilocalorie()
            case .walkRunDistance, .cyclingDistance, .swimmingDistance, .wheelchairDistance:
                return Self.usesMetricDistance ? .meterUnit(with: .kilo) : .mile()
            default:               return nil
            }
        }

        /// Whether distance should be read & labelled in kilometers (metric locales) vs miles.
        /// A device setting, read once per query — HealthKit stores meters, so we just pick
        /// the display unit. `distanceLabel` is factored out pure so both branches are testable.
        static var usesMetricDistance: Bool {
            if #available(iOS 16.0, *) { return Locale.current.measurementSystem == .metric }
            return Locale.current.usesMetricSystem
        }
        static func distanceLabel(usesMetric: Bool) -> String { usesMetric ? "km" : "mi" }
        /// A gentle starting target for a daily walk/run goal (~5 km ≈ 3 mi).
        static func distanceTarget(usesMetric: Bool) -> Int { usesMetric ? 5 : 3 }

        /// The goal `unit` stored when a numeric metric is picked, and the word shown next
        /// to a value ("7,340 steps"). Booleans are habits (unit is null server-side).
        var label: String {
            if let w = workoutInfo {
                guard w.measure == .sessions else { return "min" }
                switch w.slug {
                case "running":  return "runs"
                case "cycling":  return "rides"
                case "swimming": return "swims"
                case "any":      return "workouts"
                default:         return "sessions"   // yoga / strength
                }
            }
            switch self {
            case .steps:           return "steps"
            case .flights:         return "flights"
            case .exerciseMinutes: return "min"
            case .activeEnergy:    return "cal"
            case .walkRunDistance, .cyclingDistance, .swimmingDistance, .wheelchairDistance:
                return Self.distanceLabel(usesMetric: Self.usesMetricDistance)
            case .mindfulMinutes:  return "min"
            case .moveRing:        return "move ring"
            case .exerciseRing:    return "exercise ring"
            case .standRing:       return "stand ring"
            case .ringsAll:        return "rings"
            case .mood:            return "mood"
            default:               return ""   // workout metrics returned above
            }
        }

        /// Tile emoji for the grouped picker + the editor's counting row (mock design).
        var emoji: String {
            if let w = workoutInfo {
                switch w.slug {
                case "running":  return "🏅"
                case "cycling":  return "🚵"
                case "swimming": return "🥽"
                case "yoga":     return "🧘"
                case "strength": return "🏋️"
                default:         return "🔥"
                }
            }
            switch self {
            case .steps:              return "👟"
            case .flights:            return "🪜"
            case .exerciseMinutes:    return "🔥"
            case .activeEnergy:       return "⚡"
            case .walkRunDistance:    return "🏃"
            case .cyclingDistance:    return "🚴"
            case .swimmingDistance:   return "🏊"
            case .wheelchairDistance: return "🦽"
            case .mindfulMinutes:     return "🌿"
            case .mood:               return "💗"
            case .moveRing:           return "🔴"
            case .exerciseRing:       return "🟢"
            case .standRing:          return "🔵"
            case .ringsAll:           return "🎯"
            default:                  return "❤️"   // workout metrics returned above
            }
        }

        /// Short label for the editor's picker chip.
        var chipLabel: String {
            if let w = workoutInfo {
                switch w.slug {
                case "running":  return "Running workouts"
                case "cycling":  return "Cycling workouts"
                case "swimming": return "Swimming workouts"
                case "yoga":     return "Yoga"
                case "strength": return "Strength training"
                default:         return "Any workout"
                }
            }
            switch self {
            case .steps:           return "Steps"
            case .flights:         return "Flights"
            case .exerciseMinutes: return "Exercise"
            case .activeEnergy:    return "Energy"
            case .walkRunDistance: return "Walk + run"
            case .cyclingDistance: return "Cycling"
            case .swimmingDistance: return "Swimming"
            case .wheelchairDistance: return "Wheelchair"
            case .mindfulMinutes:  return "Mindful"
            case .moveRing:        return "Move ring"
            case .exerciseRing:    return "Exercise ring"
            case .standRing:       return "Stand ring"
            case .ringsAll:        return "All rings"
            case .mood:            return "Mood"
            default:               return ""   // workout metrics returned above
            }
        }

        /// A sensible starting target to pre-fill when the metric is picked, so the user
        /// isn't staring at an empty number field. Booleans use 1 (met/not) — kept hidden.
        var suggestedTarget: Int {
            // Workout goal targets: ~300 min or ~12 sessions to fill the number field.
            if let w = workoutInfo { return w.measure == .minutes ? 300 : 12 }
            switch self {
            case .steps:           return 10000
            case .flights:         return 10
            case .exerciseMinutes: return 30
            case .activeEnergy:    return 500
            case .walkRunDistance, .cyclingDistance, .wheelchairDistance:
                return Self.distanceTarget(usesMetric: Self.usesMetricDistance)
            // A swim mile is a different beast — suggest ~1 km / 1 mi, not a walking 5k.
            case .swimmingDistance: return 1
            case .mindfulMinutes:  return 10
            case .moveRing, .exerciseRing, .standRing, .ringsAll, .mood: return 1
            default: return 1   // workout metrics returned above
            }
        }

        /// A habit day's threshold prefill. Distinct from `suggestedTarget` (the goal's
        /// overall number): a sessions habit defaults to 1 — any workout that day counts —
        /// and a minutes habit to a modest daily 30, while quantity metrics keep their
        /// suggested amount as the daily bar (e.g. steps a day).
        var suggestedDailyTarget: Int {
            if let w = workoutInfo { return w.measure == .sessions ? 1 : 30 }
            return suggestedTarget
        }

        /// Plain-language "what is this?" shown under the picker so the user knows what
        /// Apple Health actually tracks for each choice.
        var explanation: String {
            if let w = workoutInfo {
                let what: String
                switch w.slug {
                case "running":  what = "Running workouts recorded on your Apple Watch or iPhone."
                case "cycling":  what = "Cycling workouts — outdoor and indoor rides."
                case "swimming": what = "Swim workouts from your Apple Watch."
                case "yoga":     what = "Yoga workouts you record."
                case "strength": what = "Strength training — traditional and functional."
                default:         what = "Any workout you record, whatever the type."
                }
                return what + (w.measure == .minutes ? " Adds up the minutes." : " Counts each workout.")
            }
            switch self {
            case .steps:           return "Steps counted by your iPhone and Apple Watch."
            case .flights:         return "Flights of stairs climbed, tracked by your iPhone."
            case .exerciseMinutes: return "Apple Watch exercise minutes — the green ring."
            case .activeEnergy:    return "Active calories burned — the Apple Watch move ring."
            case .walkRunDistance: return "Walking & running distance from your iPhone and Apple Watch — includes hikes."
            case .cyclingDistance: return "Cycling distance from your Apple Watch or cycling workouts."
            case .swimmingDistance: return "Swimming distance from your Apple Watch swim workouts."
            case .wheelchairDistance: return "Wheelchair pushes distance from your iPhone and Apple Watch."
            case .mindfulMinutes:  return "Mindful minutes logged in Health or the Mindfulness app."
            case .moveRing:        return "Counts a day when you close your Apple Watch Move ring."
            case .exerciseRing:    return "Counts a day when you close your Apple Watch Exercise ring."
            case .standRing:       return "Counts a day when you close your Apple Watch Stand ring."
            case .ringsAll:        return "Counts a day when you close all three Apple Watch rings."
            case .mood:            return "Counts a day when you log how you're feeling (iOS 17+)."
            default:               return ""   // workout metrics returned above
            }
        }

        /// All workout metrics carrying `measure`, in declaration (display) order.
        static func workoutMetrics(measure: WorkoutMeasure) -> [Metric] {
            allCases.filter { $0.workoutMeasure == measure }
        }

        /// The grouped, goal-type-aware picker list (mocks: an "adds up automatically"
        /// grouping for total/count vs a "counts qualifying days" grouping for habits).
        /// Workouts surface the measure that fits the goal type — minutes on a total,
        /// sessions on a count/habit (a habit can still flip to a minutes threshold).
        /// Sections only ever contain metrics that apply; empty sections drop out.
        static func sections(forGoalType goalType: String) -> [(title: String, metrics: [Metric])] {
            let everyday: [Metric] = [.steps, .flights, .exerciseMinutes, .activeEnergy]
            let distance: [Metric] = [.walkRunDistance, .cyclingDistance, .swimmingDistance, .wheelchairDistance]
            let rings: [Metric] = [.moveRing, .exerciseRing, .standRing, .ringsAll]
            let raw: [(String, [Metric])]
            if goalType == "habit" {
                raw = [
                    ("Apple Watch rings", rings),
                    ("Logged each day", [.mood, .mindfulMinutes]),
                    ("Workout days", workoutMetrics(measure: .sessions)),
                    ("Daily targets", everyday + distance),
                ]
            } else {
                raw = [
                    ("Everyday", everyday),
                    ("Distance", distance),
                    ("Workouts", workoutMetrics(measure: goalType == "count" ? .sessions : .minutes)),
                    ("Mindfulness", [.mindfulMinutes]),
                    ("Apple Watch rings", rings),      // count only — drop out on totals
                    ("Logged each day", [.mood]),      // count only — drop out on totals
                ]
            }
            return raw
                .map { (title: $0.0, metrics: $0.1.filter { $0.applies(toGoalType: goalType) }) }
                .filter { !$0.metrics.isEmpty }
        }

        /// A short "current value" string for the discovery picker, given the day's reading.
        func formatCurrent(_ value: Double?) -> String {
            guard let v = value else { return "—" }
            if isBoolean { return v >= 1 ? "done today" : "not yet today" }
            // Workouts read whole numbers either way: "42 min today" / "2 swims today".
            if isWorkout { return "\(Int(v)) \(label) today" }
            switch self {
            case .steps, .flights:                   return "\(Int(v)) \(label) today"
            case .exerciseMinutes, .mindfulMinutes:  return "\(Int(v)) min today"
            case .activeEnergy:                      return "\(Int(v)) cal today"
            // Distance is fractional — one decimal ("3.2 mi today"), never an Int cast.
            case .walkRunDistance, .cyclingDistance, .swimmingDistance, .wheelchairDistance:
                return String(format: "%.1f %@ today", v, label)
            default:                                 return "\(Int(v)) today"
            }
        }
    }

    /// Request *read* access for the Tier-0 quantity types. Safe to call repeatedly —
    /// HealthKit only prompts the first time and never re-reveals a prior choice.
    func requestReadAuthorization() async throws {
        guard isAvailable else { return }
        let read = Metric.allCases.reduce(into: Set<HKObjectType>()) { $0.formUnion($1.readTypes) }
        try await store.requestAuthorization(toShare: [], read: read)
    }

    /// Hard cap on how far back a single catch-up reaches — so a goal started a year ago
    /// (or a fresh install with no mark) doesn't read hundreds of days on first open.
    nonisolated static let syncCap = 90
    /// Re-check this many recent days even when we've synced past them, so a late Apple
    /// Watch write for a recent day still lands.
    nonisolated static let syncRecheckTail = 2

    /// The days that still need an Apple Health sync, newest-first, each as its start-of-day
    /// `Date` + "yyyy-MM-dd" `key`. Given the per-goal "synced-through" high-water mark, this
    /// is `[mark - (tail-1) … today]` — so a two-week absence returns all fourteen missed days,
    /// a fresh mark returns just the re-check tail, and no mark (first sync / reinstall) returns
    /// the last `cap` days. `notBefore` (the goal's start) floors the window so a brand-new goal
    /// never pulls steps from before it existed. Bounded to `[max(today-cap+1, notBefore) … today]`.
    /// Pure + `nonisolated` so it's unit-testable with an injected calendar.
    nonisolated static func daysToSync(syncedThrough: Date?, today: Date = Date(),
                                       notBefore: Date? = nil,
                                       cap: Int = syncCap, recheckTail: Int = syncRecheckTail,
                                       calendar: Calendar = .current) -> [(day: Date, key: String)] {
        let fmt = DateFormatter()
        fmt.calendar = calendar
        fmt.timeZone = calendar.timeZone
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        let todayStart = calendar.startOfDay(for: today)
        let capFloor = calendar.date(byAdding: .day, value: -(max(cap, 1) - 1), to: todayStart) ?? todayStart
        // Never look before the goal existed (or before the cap window, whichever is later).
        let earliest = notBefore.map { max(capFloor, calendar.startOfDay(for: $0)) } ?? capFloor
        let rawStart: Date
        if let mark = syncedThrough {
            let m = calendar.startOfDay(for: mark)
            rawStart = calendar.date(byAdding: .day, value: -(max(recheckTail, 1) - 1), to: m) ?? m
        } else {
            rawStart = earliest
        }
        let start = min(max(rawStart, earliest), todayStart)   // clamp into [earliest, today]
        let dayCount = (calendar.dateComponents([.day], from: start, to: todayStart).day ?? 0) + 1
        return (0 ..< max(dayCount, 1)).compactMap { offset in
            calendar.date(byAdding: .day, value: -offset, to: todayStart).map { ($0, fmt.string(from: $0)) }
        }
    }

    /// Parse an ISO-8601 timestamp (a goal's `createdAt`) to a `Date`, or nil. Used to floor
    /// the first sync at the goal's start. Handles the fractional-seconds form Postgres emits.
    nonisolated static func parseTimestamp(_ s: String?) -> Date? {
        guard let s else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: s)
    }

    /// Read `metric`'s total for one local day (`key`, its "yyyy-MM-dd") and push it to
    /// `goalId`. A denied read or no data is a silent no-op. Returns true only if a value
    /// was posted. Auth is requested by the caller once before looping.
    static func pushDay(_ api: WaffledAPI, goalId: String, metric: Metric, day: Date, key: String) async -> Bool {
        guard let value = await shared.total(for: metric, on: day), value > 0 else { return false }
        do { try await api.syncGoalHealth(goalId: goalId, metric: metric.key, day: key, value: value); return true }
        catch { return false }
    }

    /// Today's cumulative total for `metric` — convenience over `total(for:on:)` used by the
    /// Log sheet's read-&-suggest card.
    func todayTotal(for metric: Metric) async -> Double? { await total(for: metric, on: Date()) }

    /// The day's reading for `metric`, or `nil` when unavailable. Quantity metrics return a
    /// cumulative sum; **boolean** metrics (rings/mood) return 1 (met) or 0 (not) so they push
    /// straight into the habit daily-threshold path. `nil` is intentionally ambiguous (denied
    /// vs empty) and simply yields no suggestion.
    func total(for metric: Metric, on day: Date) async -> Double? {
        guard isAvailable else { return nil }
        if metric.isWorkout { return await workoutStat(metric, on: day) }
        switch metric {
        case .steps, .flights, .exerciseMinutes, .activeEnergy, .walkRunDistance,
             .cyclingDistance, .swimmingDistance, .wheelchairDistance:
            return await quantitySum(metric, on: day)
        case .mindfulMinutes:
            return await mindfulMinutes(on: day)
        case .moveRing, .exerciseRing, .standRing, .ringsAll:
            return await ringClosed(metric, on: day)
        case .mood:
            return await moodLogged(on: day)
        default:   // workout metrics dispatched above
            return nil
        }
    }

    /// The cumulative-sum quantity metrics, summed over one local day.
    private func quantitySum(_ metric: Metric, on day: Date) async -> Double? {
        guard let qty = metric.quantityType, let unit = metric.quantityUnit else { return nil }
        let (start, end) = Self.dayBounds(day)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await withCheckedContinuation { continuation in
            let query = HKStatisticsQuery(
                quantityType: qty, quantitySamplePredicate: predicate, options: .cumulativeSum
            ) { _, stats, _ in
                continuation.resume(returning: stats?.sumQuantity()?.doubleValue(for: unit))
            }
            store.execute(query)
        }
    }

    /// Total minutes of mindful sessions logged on `day` (sum of each session's duration).
    private func mindfulMinutes(on day: Date) async -> Double? {
        let (start, end) = Self.dayBounds(day)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await withCheckedContinuation { continuation in
            let q = HKSampleQuery(sampleType: HKCategoryType(.mindfulSession), predicate: predicate,
                                  limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                guard let samples else { continuation.resume(returning: nil); return }
                let seconds = samples.reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) }
                continuation.resume(returning: seconds / 60.0)
            }
            store.execute(q)
        }
    }

    /// 1 when the relevant Apple Watch ring(s) closed on `day`, else 0 — a ring is "closed"
    /// when the day's value meets the user's own Apple goal for it.
    private func ringClosed(_ metric: Metric, on day: Date) async -> Double? {
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: day)
        comps.calendar = Calendar.current
        let predicate = HKQuery.predicate(forActivitySummariesBetweenStart: comps, end: comps)
        return await withCheckedContinuation { continuation in
            let q = HKActivitySummaryQuery(predicate: predicate) { _, summaries, _ in
                guard let s = summaries?.first else { continuation.resume(returning: 0); return }
                func met(_ v: HKQuantity, _ goal: HKQuantity, _ unit: HKUnit) -> Bool {
                    let g = goal.doubleValue(for: unit)
                    return g > 0 && v.doubleValue(for: unit) >= g
                }
                let move = met(s.activeEnergyBurned, s.activeEnergyBurnedGoal, .kilocalorie())
                let exercise = met(s.appleExerciseTime, s.appleExerciseTimeGoal, .minute())
                let stand = met(s.appleStandHours, s.appleStandHoursGoal, .count())
                let done: Bool
                switch metric {
                case .moveRing:     done = move
                case .exerciseRing: done = exercise
                case .standRing:    done = stand
                case .ringsAll:     done = move && exercise && stand
                default:            done = false
                }
                continuation.resume(returning: done ? 1 : 0)
            }
            store.execute(q)
        }
    }

    /// 1 when at least one State of Mind entry was logged on `day`, else 0 (iOS 17+).
    private func moodLogged(on day: Date) async -> Double? {
        guard #available(iOS 17.0, *) else { return nil }
        let (start, end) = Self.dayBounds(day)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await withCheckedContinuation { continuation in
            let q = HKSampleQuery(sampleType: HKObjectType.stateOfMindType(), predicate: predicate,
                                  limit: 1, sortDescriptors: nil) { _, samples, _ in
                continuation.resume(returning: (samples?.isEmpty == false) ? 1 : 0)
            }
            store.execute(q)
        }
    }

    /// The day's workouts collapsed to the metric's number — a genuinely different query
    /// shape from the cumulative quantities: an HKSampleQuery over HKWorkout samples,
    /// filtered to the metric's activity type(s) (none = any workout), then counted or
    /// duration-summed via the pure `workoutValue`. nil = query failed (denied reads just
    /// return no samples, which reads as 0 — indistinguishable by Apple's design).
    private func workoutStat(_ metric: Metric, on day: Date) async -> Double? {
        guard let info = metric.workoutInfo else { return nil }
        let (start, end) = Self.dayBounds(day)
        var predicates = [HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)]
        if !info.activities.isEmpty {
            predicates.append(NSCompoundPredicate(orPredicateWithSubpredicates:
                info.activities.map { HKQuery.predicateForWorkouts(with: $0) }))
        }
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        return await withCheckedContinuation { continuation in
            let q = HKSampleQuery(sampleType: .workoutType(), predicate: predicate,
                                  limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                guard let workouts = samples as? [HKWorkout] else { continuation.resume(returning: nil); return }
                let minutes = workouts.map { $0.duration / 60.0 }
                continuation.resume(returning: Metric.workoutValue(measure: info.measure, durationsMinutes: minutes))
            }
            store.execute(q)
        }
    }

    /// Local [startOfDay, startOfNextDay) bounds for a day.
    private static func dayBounds(_ day: Date) -> (Date, Date) {
        let cal = Calendar.current
        let start = cal.startOfDay(for: day)
        return (start, cal.date(byAdding: .day, value: 1, to: start) ?? day)
    }
}

/// Per-goal "synced-through" high-water mark for Apple Health, stored locally (HealthKit is
/// per-device, so the mark is too). Lets syncHealth re-sync only the days since the last run
/// instead of a fixed window — a two-week absence catches up on the next open. Losing it (app
/// reinstall) just re-catches-up from the cap window once; harmless because /health-sync is
/// idempotent.
enum HealthSyncMark {
    private static func key(_ goalId: String, _ metric: HealthKitBridge.Metric) -> String {
        "hk.syncedThrough.\(goalId).\(metric.key)"
    }
    static func get(_ goalId: String, _ metric: HealthKitBridge.Metric) -> Date? {
        UserDefaults.standard.object(forKey: key(goalId, metric)) as? Date
    }
    static func set(_ goalId: String, _ metric: HealthKitBridge.Metric, _ day: Date) {
        UserDefaults.standard.set(day, forKey: key(goalId, metric))
    }
}
