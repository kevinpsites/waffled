import Foundation

/// The quick-amount chips under a goal's log field.
///
/// Pulled out of the sheet so the one non-obvious value in it can be tested: the 20m
/// chip is 1/3 rounded to six decimals *specifically* to match what the hours+minutes
/// fields compute for the same duration. Get that rounding wrong on either side and
/// the chip quietly stops reading as selected, or logs 19 minutes instead of 20.
/// Mirrors the web's LogModal chips. Tested in Tests/GoalLogChipsTests.swift.
enum GoalLogChips {
    struct Chip: Equatable {
        let label: String
        let value: Double
    }

    /// `isHours` marks a time goal (hours/minutes entry); otherwise the chips are plain
    /// counts in the goal's own unit.
    static func chips(isHours: Bool, unit: String?) -> [Chip] {
        if isHours {
            // Short sessions are the ones people log by tapping; a 2-hour block is rare
            // enough to type, and 20 minutes is the one that kept needing the keypad.
            return [
                Chip(label: "20m", value: hoursForMinutes(20)),
                Chip(label: "30m", value: 0.5),
                Chip(label: "1 hr", value: 1),
                Chip(label: "1.5 hr", value: 1.5),
            ]
        }
        let u = unit.map { " \($0)" } ?? ""
        return [1, 2, 3, 5].map { Chip(label: "\(Int($0))\(u)", value: Double($0)) }
    }

    /// Minutes as a fraction of an hour, at the same six decimals the hours+minutes
    /// fields round to — so a chip's value and a typed duration compare equal.
    static func hoursForMinutes(_ minutes: Int) -> Double {
        ((Double(minutes) / 60) * 1e6).rounded() / 1e6
    }

    /// The hours + minutes a chip fills in when tapped. Rounds rather than truncates:
    /// 20m arrives as 0.333333, and `Int(0.333333 * 60)` is 19.
    static func fields(for value: Double) -> (hours: Int, minutes: Int) {
        let h = Int(value)
        return (h, Int((value - Double(h)) * 60 + 0.5))
    }

    /// Whether what's typed reads as this chip. The tolerance has to be looser than the
    /// gap the chip's own six-decimal rounding leaves behind (20/60 vs 0.333333).
    static func isSelected(hours: Int, minutes: Int, chip: Double) -> Bool {
        abs((Double(hours) + Double(minutes) / 60) - chip) < 1e-6
    }
}
