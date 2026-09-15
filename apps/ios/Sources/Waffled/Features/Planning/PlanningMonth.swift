import Foundation

// The month stepping the Horizon scan does. The grid itself is the Calendar tab's
// `PhoneMonthGrid` (Features/Calendar/PhoneCalendarViews.swift).

/// The month arithmetic — all of it string- and integer-based where it can be.
enum PlanningMonth {
    static let names = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]

    /// "September 2026". `month` is 1-based, as `DateComponents` counts them.
    static func label(year: Int, month: Int) -> String {
        guard (1...12).contains(month) else { return "\(year)" }
        return "\(names[month - 1]) \(year)"
    }

    /// The month a `YYYY-MM-DD` week start falls in, read off the STRING. Never through a
    /// `Date`: a week start is a calendar label, and parsing it in the device's zone is
    /// how a household in a negative offset gets the previous month back on the 1st.
    static func month(of weekStart: String) -> (year: Int, month: Int)? {
        let parts = weekStart.split(separator: "-")
        guard parts.count >= 2, let y = Int(parts[0]), let m = Int(parts[1]), (1...12).contains(m) else {
            return nil
        }
        return (y, m)
    }

    /// Step whole months, with integer arithmetic rather than calendar addition.
    static func advance(year: Int, month: Int, by months: Int) -> (year: Int, month: Int) {
        let zero = year * 12 + (month - 1) + months
        return (zero / 12, zero % 12 + 1)
    }
}
