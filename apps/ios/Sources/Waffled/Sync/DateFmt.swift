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

    // Device-locale variant of the cache above. `string(_:_:_:)` pins POSIX so machine
    // formats ("yyyy-MM-dd", "HH:mm") stay stable; but user-visible text whose *words*
    // must follow the device language — weekday/month names ("EEEE, MMMM d") or AM/PM
    // ("h a") — needs the real locale. Same config-once-never-mutate contract, so it's
    // safe to reuse across renders (and threads). Locale is snapshotted at first build
    // for that (pattern, tz); a mid-session app-language switch needs a relaunch.
    private static var localizedCache: [String: DateFormatter] = [:]

    private static func localizedFormatter(_ pattern: String, _ tz: TimeZone) -> DateFormatter {
        let key = pattern + "\u{1}" + tz.identifier
        lock.lock()
        if let cached = localizedCache[key] { lock.unlock(); return cached }
        lock.unlock()
        let f = DateFormatter()
        f.locale = Locale.current                     // device language → localized names / AM-PM
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = tz
        f.dateFormat = pattern
        lock.lock()
        localizedCache[key] = f
        lock.unlock()
        return f
    }

    /// Like `string(_:_:_:)` but rendered in the **device locale**, so weekday/month
    /// names and AM/PM are translated. Use for on-screen text (the kiosk clock/date,
    /// a settings hour label); use `string` for stable machine formats.
    static func localizedString(_ date: Date, _ pattern: String, _ tz: TimeZone) -> String {
        localizedFormatter(pattern, tz).string(from: date)
    }

    /// Parse a string with `pattern` in `tz` back to a Date (nil if it doesn't match).
    static func date(_ string: String, _ pattern: String, _ tz: TimeZone) -> Date? {
        formatter(pattern, tz).date(from: string)
    }

    /// "Good morning/afternoon/evening" for the current hour in `tz`. Shared by the
    /// phone Today header and the iPad dashboard.
    static func greeting(_ tz: TimeZone) -> String {
        switch Cal.gregorian(tz).component(.hour, from: Date()) {
        case 5..<12:  return "Good morning"
        case 12..<17: return "Good afternoon"
        default:      return "Good evening"
        }
    }
}

/// Cached `Calendar`s, one per timezone. `Calendar(identifier:)` (and `Calendar.current`)
/// loads locale/timezone data on every access — far too expensive to allocate inside a
/// filter/map/sort closure or a per-cell grid builder, which the calendar and meal grids
/// do dozens of times per render. A `Calendar` is a value type, so a cached one is safe to
/// hand out by copy; callers only ever read from it. Companion to `DateFmt`.
enum Cal {
    private static var cache: [String: Calendar] = [:]
    private static let lock = NSLock()

    /// A gregorian calendar in `tz`, built once per timezone identifier and reused.
    static func gregorian(_ tz: TimeZone) -> Calendar {
        lock.lock(); defer { lock.unlock() }
        if let c = cache[tz.identifier] { return c }
        var c = Calendar(identifier: .gregorian)
        c.timeZone = tz
        cache[tz.identifier] = c
        return c
    }

    /// The device's current-timezone gregorian calendar (a cached stand-in for repeated
    /// `Calendar.current` reads in hot paths). Keyed on the current tz, so it tracks tz
    /// changes on the next access. Locale is snapshotted at first build for that zone —
    /// fine for the day-math this is used for (startOfDay / isDateInToday / components).
    static var current: Calendar { gregorian(TimeZone.current) }

    /// Start of the week containing `date` in `tz`, honoring the device's **current**
    /// first-day-of-week. `gregorian(tz)` snapshots `firstWeekday` when it first caches a
    /// zone, which is wrong for `dateInterval(of: .weekOfYear)` if the user changes their
    /// region's week start mid-session — so re-read it live here. Cheap: the meal-week
    /// planners call this on week navigation, not per row.
    static func weekStart(_ date: Date, _ tz: TimeZone) -> Date {
        var c = gregorian(tz)
        c.firstWeekday = Calendar.current.firstWeekday
        return c.dateInterval(of: .weekOfYear, for: date)?.start ?? c.startOfDay(for: date)
    }

    /// Start of the week containing `date` in `tz`, cut on the **household's** first day
    /// rather than the device region's. The two routinely disagree (a monday household on
    /// a US phone), and the planner grids have to follow the household: the server keys
    /// the grocery list by that boundary, so a grid cut on the other day plans a week
    /// that straddles two of the household's own. The overload above still follows the
    /// device, for screens that genuinely want the phone's idea of a week.
    static func weekStart(_ date: Date, _ tz: TimeZone, _ firstDay: HouseholdWeekStart) -> Date {
        var c = gregorian(tz)
        c.firstWeekday = firstDay == .monday ? 2 : 1   // Calendar: 1 = Sunday
        return c.dateInterval(of: .weekOfYear, for: date)?.start ?? c.startOfDay(for: date)
    }

    /// The two-letter weekday headings for a grid, read from the household's first day.
    static func weekdaySymbols(from firstDay: HouseholdWeekStart) -> [String] {
        rotated(["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"], from: firstDay)
    }

    /// Any 7-item weekday row, rotated to start on the household's first day. The grids
    /// use different label widths (one letter on a phone month, three on the kiosk), so
    /// only the ORDER is shared — pass whichever labels that grid draws.
    static func rotated<T>(_ labels: [T], from firstDay: HouseholdWeekStart) -> [T] {
        guard labels.count == 7 else { return labels }
        let offset = firstDay == .monday ? 1 : 0
        return (0..<7).map { labels[($0 + offset) % 7] }
    }

    /// Leading blank cells before the 1st in a month grid cut on `firstDay`.
    static func monthLeadCells(_ monthStart: Date, _ tz: TimeZone, _ firstDay: HouseholdWeekStart) -> Int {
        let cal = gregorian(tz)
        let weekday = cal.component(.weekday, from: monthStart) - 1   // 0 = Sunday
        let offset = firstDay == .monday ? 1 : 0
        return (weekday - offset + 7) % 7
    }
}
