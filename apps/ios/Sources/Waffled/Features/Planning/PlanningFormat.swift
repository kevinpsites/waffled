import Foundation

/// Weekly Planning's pure functions — no view, no network, no clock. Ported line-for-line
/// from `apps/web/src/lib/api/weeklyPlanning.ts`: two platforms each deciding "which step
/// is on screen" is how a session resumed on the iPad lands somewhere else than the phone.
///
/// `weekStart` is a household-local `YYYY-MM-DD` and must NOT be round-tripped through a
/// device `Date` — the server owns the boundary; we do string arithmetic on it.
enum PlanningFormat {

    /// An unavailable step keeps its place in the catalog but is never shown, counted or
    /// landed on.
    static func availableSteps(_ steps: [WaffledAPI.PlanningStep]) -> [WaffledAPI.PlanningStep] {
        steps.filter(\.available)
    }

    /// The acts arrive on each step rather than being hardcoded here. Consecutive runs only:
    /// two separated groups sharing an act name stay separate, keeping the sheet in order.
    static func stepsByAct(_ steps: [WaffledAPI.PlanningStep]) -> [(act: String, steps: [WaffledAPI.PlanningStep])] {
        var out: [(act: String, steps: [WaffledAPI.PlanningStep])] = []
        for s in availableSteps(steps) {
            if let last = out.last, last.act == s.act {
                out[out.count - 1].steps.append(s)
            } else {
                out.append((act: s.act, steps: [s]))
            }
        }
        return out
    }

    /// In order: the step explicitly asked for, then the session's own pointer (which lets
    /// another device resume where this one left off), then the first runnable step. A key
    /// that is not available must never strand the session on a blank screen, which is why
    /// every branch falls through to `first`.
    static func resolveCurrent(
        _ view: WaffledAPI.WeeklyPlanningView?,
        asked: String? = nil
    ) -> WaffledAPI.PlanningStep? {
        guard let view else { return nil }
        let avail = availableSteps(view.steps)
        guard !avail.isEmpty else { return nil }
        return avail.first { $0.key == asked }
            ?? avail.first { $0.key == view.session?.currentStep }
            ?? avail.first
    }

    static func nextStepAfter(_ steps: [WaffledAPI.PlanningStep], key: String) -> WaffledAPI.PlanningStep? {
        let avail = availableSteps(steps)
        guard let i = avail.firstIndex(where: { $0.key == key }), i + 1 < avail.count else { return nil }
        return avail[i + 1]
    }

    /// Step a `YYYY-MM-DD` by whole weeks, in UTC on purpose. A week start is a calendar
    /// label, not an instant: parsing it in the device's zone and adding 7×86400 seconds
    /// crosses a DST boundary twice a year and lands on the Saturday or the Monday.
    static func addWeeks(_ iso: String, _ n: Int) -> String {
        guard let base = Self.isoDay.date(from: iso) else { return iso }
        let moved = base.addingTimeInterval(Double(n) * 7 * 24 * 60 * 60)
        return Self.isoDay.string(from: moved)
    }

    static func planningDayName(_ dow: Int) -> String {
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return names[((dow % 7) + 7) % 7]
    }

    static func weekLabel(_ iso: String) -> String {
        guard let start = Self.isoDay.date(from: iso) else { return iso }
        let end = start.addingTimeInterval(6 * 24 * 60 * 60)
        return "\(Self.dayNum.string(from: start)) \(Self.dow.string(from: start))"
            + " – \(Self.dayNum.string(from: end)) \(Self.dow.string(from: end))"
    }

    /// 1-based position among the RUNNABLE steps. This — not `step.number` — is the "2 of 9"
    /// the counter shows: `number` is a catalog index and would skip an unavailable step
    /// while the total counted only runnable ones.
    static func position(
        _ steps: [WaffledAPI.PlanningStep], currentKey: String?
    ) -> (pos: Int, total: Int) {
        let avail = availableSteps(steps)
        let i = avail.firstIndex { $0.key == currentKey }
        return (pos: (i.map { $0 + 1 }) ?? 0, total: avail.count)
    }

    /// The 2px progress hair, 0…1. POSITIONAL, matching `WeeklyPlanning.tsx`'s
    /// `pos / runnable.length` — deliberately not "how many steps are settled", because the
    /// two disagree the moment somebody jumps ahead and a bar that reads differently on the
    /// phone than on the kiosk is worse than either definition.
    static func hairFraction(_ steps: [WaffledAPI.PlanningStep], currentKey: String?) -> Double {
        let (pos, total) = position(steps, currentKey: currentKey)
        guard total > 0 else { return 0 }
        return Double(pos) / Double(total)
    }

    /// How much of the session has been ANSWERED, settled over runnable — not the hair (see
    /// `hairFraction`), but for a summary that wants work done rather than cursor position.
    static func settledFraction(_ steps: [WaffledAPI.PlanningStep]) -> Double {
        let avail = availableSteps(steps)
        guard !avail.isEmpty else { return 0 }
        return Double(avail.filter(\.isSettled).count) / Double(avail.count)
    }

    // Formatters are `static let` per the project's performance rule. UTC + POSIX on the ISO
    // one: a device in a negative offset parsing "2026-09-06" locally gets the 5th back out.
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let dayNum: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "d"
        return f
    }()
    private static let dow: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE"
        return f
    }()
}
