import Foundation

/// Date → string formatting in a given timezone, centralized so views don't each
/// hand-roll a `DateFormatter` (and risk the wrong tz or locale). Uses a fixed
/// POSIX locale so format strings render stably. Pairs with `EventTime` (parsing)
/// and `Agenda` (day bucketing).
enum DateFmt {
    /// A fixed UTC zone — for date-only ("yyyy-MM-dd") day strings that shouldn't
    /// shift with the viewer's timezone (goal deadlines, meal-plan day keys, …).
    static let utc = TimeZone(identifier: "UTC")!

    // DateFormatter is one of the most expensive Foundation objects to build, and these
    // are called from view bodies that re-render constantly (calendar/meal grids). Cache
    // one per (pattern, tz); a configured formatter is safe to reuse for formatting as
    // long as we never mutate it again. The lock guards only the cache dictionary.
    private static var cache: [String: DateFormatter] = [:]
    private static let lock = NSLock()

    private static func formatter(_ pattern: String, _ tz: TimeZone) -> DateFormatter {
        let key = pattern + "\u{1}" + tz.identifier
        lock.lock()
        if let cached = cache[key] { lock.unlock(); return cached }
        lock.unlock()
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = tz
        f.dateFormat = pattern
        lock.lock()
        cache[key] = f
        lock.unlock()
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
