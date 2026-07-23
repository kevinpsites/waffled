import Foundation

/// Shared bundle every data view reads from — mirrors the web `DataViewProps`
/// contract so both platforms consume the identical derived-stats shape.
struct GoalDataContext {
    let goal: WaffledAPI.GoalDetail
    let stats: GoalStatsResult
    let personMap: [String: WaffledAPI.Goal.Participant]
    let onDayTap: (String) -> Void
    let onMonthTap: (_ year: Int, _ month: Int) -> Void
}

/// Local, non-networking date/number formatting shared by the data views —
/// avoids each view re-declaring its own DateFormatter (see DateFmt's perf note).
enum GoalViewFmt {
    static func monthDay(_ dateKey: String) -> String {
        DateFmt.string(GoalDateKey.parse(dateKey), "MMM d", .current)
    }
    static func monthName(_ month: Int) -> String {
        DateFmt.string(GoalDateKey.calendar.date(from: DateComponents(year: 2000, month: month + 1, day: 1))!, "MMMM", .current)
    }
    static func weekday(_ dateKey: String) -> String {
        DateFmt.string(GoalDateKey.parse(dateKey), "EEE", .current).prefix(2).capitalized
    }
    /// Weekday + day-of-month, e.g. "Sun 14" — the week strip's cell label, so each
    /// day shows its date (mirrors the web WeekHeatmap).
    static func weekdayDay(_ dateKey: String) -> String {
        DateFmt.string(GoalDateKey.parse(dateKey), "EEE d", .current)
    }
    /// Whole numbers without a decimal, otherwise at most 2 decimals — mirrors `goalFmt`.
    static func num(_ n: Double) -> String {
        let r = (n * 100).rounded() / 100
        return r == r.rounded() ? String(Int(r)) : String(format: "%g", r)
    }
}
