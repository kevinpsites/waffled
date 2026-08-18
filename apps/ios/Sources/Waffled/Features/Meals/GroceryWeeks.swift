import Foundation

/// The household's first-day-of-week preference (`households.week_start`), as opposed to
/// the *device's* region setting. The two are independent and routinely disagree — a
/// monday household on a US phone — and the grocery list is keyed by this one.
enum HouseholdWeekStart: String, Sendable, Equatable {
    case sunday, monday

    /// Lenient: the value arrives as free text off the synced `households` row, and is
    /// missing entirely until the first sync lands. Sunday is the server's default and
    /// the only sane guess before then.
    init(raw: String?) {
        self = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "monday" ? .monday : .sunday
    }
}

/// Which grocery weeks a meal-plan apply has to rebuild.
///
/// A grocery rebuild covers exactly ONE week (`weekStart` … +6 days). "Plan my month"
/// used to make a single call with the month's 1st, so every week after the first was
/// planned and then never shopped for. The fix is to derive the weeks from the dates
/// actually written — plus the ones CLEARED, since that shopping has to come back off
/// the list — and rebuild each.
///
/// Deliberately NOT `Cal.weekStart(_:_:)`, and deliberately taking the first-day as a
/// parameter: `Cal.weekStart` snaps using the **device's** `firstWeekday`, which is
/// correct for the planner grid the user is looking at but wrong here. The grocery list
/// is keyed by the **household's** `week_start`, so grouping a monday household on
/// Sundays would merge two of its weeks into one call and leave another genuinely
/// uncovered. (The server snaps a mid-week `?weekStart=` to the household boundary, so a
/// wrongly-grouped key doesn't error — it silently rebuilds the wrong week.)
enum GroceryWeeks {
    /// The distinct week-start keys (YYYY-MM-DD) covering `dates`, sorted.
    ///
    /// All arithmetic is done in UTC, matching `DateFmt.utc`'s contract for date-only
    /// day keys: parsing in one zone and formatting in another is exactly how these come
    /// out an off-by-one week.
    static func weekStarts(_ dates: [String], firstDay: HouseholdWeekStart) -> [String] {
        let cal = Cal.gregorian(DateFmt.utc)
        var keys = Set<String>()
        for date in dates {
            guard let d = DateFmt.date(date, "yyyy-MM-dd", DateFmt.utc) else { continue }
            let dow = cal.component(.weekday, from: d)   // 1 = Sunday … 7 = Saturday
            // A monday household's Sunday CLOSES the week that began six days earlier;
            // it does not open a new one.
            let back = firstDay == .monday ? (dow == 1 ? 6 : dow - 2) : dow - 1
            guard let start = cal.date(byAdding: .day, value: -back, to: d) else { continue }
            keys.insert(DateFmt.string(start, "yyyy-MM-dd", DateFmt.utc))
        }
        return keys.sorted()
    }
}
