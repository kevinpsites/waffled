import Foundation

// The Horizon scan's window: the next four weeks from the planned week, not its calendar
// month, because late in a month most of "this month" has already happened. The grid is the
// Calendar tab's `PhoneMonthGrid`, fed `PhoneCalendar.weekRows`.

enum PlanningHorizonWindow {
    static let weeks = 4

    /// Day arithmetic on calendar LABELS, in UTC, so no device zone or DST shift can move a
    /// day. The server's week start is already cut on the household's first day.
    private static let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    private static func parse(_ key: String) -> Date? {
        DateFmt.date(key, "yyyy-MM-dd", utc.timeZone)
    }

    /// The first day of the window `ahead` steps past the planned week.
    static func start(weekStart: String, ahead: Int) -> String? {
        guard let d = parse(weekStart),
              let s = utc.date(byAdding: .day, value: ahead * weeks * 7, to: d) else { return nil }
        return DateFmt.string(s, "yyyy-MM-dd", utc.timeZone)
    }

    /// "Sep 6 – Oct 3" — the window's first and last day.
    static func label(start: String) -> String {
        guard let s = parse(start),
              let e = utc.date(byAdding: .day, value: weeks * 7 - 1, to: s) else { return "" }
        return "\(DateFmt.string(s, "MMM d", utc.timeZone)) – \(DateFmt.string(e, "MMM d", utc.timeZone))"
    }
}
