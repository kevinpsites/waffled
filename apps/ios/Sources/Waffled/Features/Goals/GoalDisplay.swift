import Foundation

/// A goal that can be rendered — the fields every goal surface needs to pick its number.
/// Both the list `Goal` and the full `GoalDetail` conform, so one helper serves both.
protocol GoalDisplayable {
    var goalType: String { get }
    var target: Double? { get }
    var totalProgress: Double { get }
    var habitPeriod: String? { get }
    var habitTargetPerPeriod: Int? { get }
    /// Distinct days logged in the CURRENT habit period (household timezone), computed
    /// server-side. `nil` on an older or cached payload that predates the field.
    var periodDone: Double? { get }
    var stepTotal: Int? { get }
    var stepDone: Int? { get }
    /// Consecutive days logged — a habit's milestone axis, not just a badge.
    var streakDays: Int { get }
}

/// Which number a goal shows, and what it is measured against.
///
/// A goal is displayed on its TYPE's axis: a **habit** shows completions in the CURRENT
/// period against its cadence ("2 of 5 this week") and never a lifetime total; a
/// **checklist** shows steps done over steps total; everything else shows the cumulative
/// amount against its target. This is the Swift mirror of `apps/web/src/lib/api/goals.ts`
/// (`goalDisplayProgress` / `goalDisplayTarget` / `goalFraction`).
///
/// Keeping the rule in ONE place is the point: iOS previously inlined `totalProgress` in
/// six views, so a "5× a week" habit counted every log it had ever had — logging once
/// last week and once this week read "2 of 5" instead of resetting with the week.
enum GoalDisplay {

    /// The progress figure to show. Never falls back to the lifetime total for a habit:
    /// on an older payload with no `periodDone` that would be exactly the wrong number,
    /// and a 0 makes the staleness visible instead.
    static func progress(_ g: GoalDisplayable) -> Double {
        switch g.goalType {
        case "habit": return g.periodDone ?? 0
        case "checklist": return Double(g.stepDone ?? 0)
        default: return g.totalProgress
        }
    }

    /// What the progress is measured against — the cadence for a habit, the step count
    /// for a checklist, the goal's target otherwise. `nil` when there is nothing to
    /// measure against (a target-less goal, an empty checklist).
    static func target(_ g: GoalDisplayable) -> Double? {
        switch g.goalType {
        case "habit": return g.habitTargetPerPeriod.map(Double.init) ?? g.target
        case "checklist":
            let total = g.stepTotal ?? 0
            return total > 0 ? Double(total) : nil
        default: return g.target
        }
    }

    /// 0…1 completion, clamped. 0 when there is no positive target, so a ring or bar
    /// renders empty rather than NaN.
    static func fraction(_ g: GoalDisplayable) -> Double {
        guard let t = target(g), t > 0 else { return 0 }
        return min(progress(g) / t, 1)
    }

    /// The window a habit's count covers — "today" / "this week" / "this month" — for
    /// appending to a ring's caption. `nil` for every other goal type.
    static func periodLabel(_ g: GoalDisplayable) -> String? {
        guard g.goalType == "habit" else { return nil }
        switch g.habitPeriod {
        case "day": return "today"
        case "month": return "this month"
        default: return "this week"
        }
    }

    /// The value a milestone's threshold is measured against — the SAME axis the server
    /// used to decide `reached` (`goalDetail`'s `milestoneAxis`): **streak days** for a
    /// habit, **percent complete** for a checklist, the cumulative total otherwise. A
    /// milestone measures whatever the goal itself measures, so a habit's "🔥 7 days"
    /// counts days in a row — never how many times it has ever been logged.
    static func milestoneAxis(_ g: GoalDisplayable) -> Double {
        switch g.goalType {
        case "habit": return Double(g.streakDays)
        case "checklist":
            let total = g.stepTotal ?? 0
            return total > 0 ? Double(g.stepDone ?? 0) / Double(total) * 100 : 0
        default: return g.totalProgress
        }
    }

    /// How far the next milestone is, in the goal's own units: "4-day streak to go",
    /// "15% to go", "188 to go". Never negative.
    static func milestoneToGo(_ g: GoalDisplayable, threshold: Double, fmt: (Double?) -> String) -> String {
        let toGo = max(0, threshold - milestoneAxis(g))
        switch g.goalType {
        case "habit": return "\(fmt(toGo))-day streak to go"
        case "checklist": return "\(Int(toGo.rounded(.up)))% to go"
        default: return "\(fmt(toGo)) to go"
        }
    }

    /// The ring caption under the progress number: "of 5 this week" for a habit, "of 5
    /// steps" for a checklist, "of 1,000 miles" otherwise.
    static func targetCaption(_ g: GoalDisplayable, unit: String?, fmt: (Double?) -> String) -> String {
        let base = "of \(fmt(target(g)))"
        if let period = periodLabel(g) { return "\(base) \(period)" }
        if g.goalType == "checklist" { return "\(base) steps" }
        return base + (unit.map { " \($0)" } ?? "")
    }
}

extension WaffledAPI.Goal: GoalDisplayable {}
extension WaffledAPI.GoalDetail: GoalDisplayable {}
