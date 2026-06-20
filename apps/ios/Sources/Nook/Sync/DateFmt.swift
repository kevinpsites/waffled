import Foundation

/// Date → string formatting in a given timezone, centralized so views don't each
/// hand-roll a `DateFormatter` (and risk the wrong tz or locale). Uses a fixed
/// POSIX locale so format strings render stably. Pairs with `EventTime` (parsing)
/// and `Agenda` (day bucketing).
enum DateFmt {
    /// A fixed UTC zone — for date-only ("yyyy-MM-dd") day strings that shouldn't
    /// shift with the viewer's timezone (goal deadlines, meal-plan day keys, …).
    static let utc = TimeZone(identifier: "UTC")!

    private static func formatter(_ pattern: String, _ tz: TimeZone) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = tz
        f.dateFormat = pattern
        return f
    }

    /// Format a Date as a string with `pattern` in `tz`.
    static func string(_ date: Date, _ pattern: String, _ tz: TimeZone) -> String {
        formatter(pattern, tz).string(from: date)
    }

    /// Parse a string with `pattern` in `tz` back to a Date (nil if it doesn't match).
    static func date(_ string: String, _ pattern: String, _ tz: TimeZone) -> Date? {
        formatter(pattern, tz).date(from: string)
    }
}
