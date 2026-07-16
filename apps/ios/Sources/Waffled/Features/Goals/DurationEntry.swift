import Foundation

/// Parse/normalize rule for GoalLogSheet's whole-number duration free-entry fields
/// (hours / minutes). The fields hold raw text while editing so a cleared field can
/// stay empty instead of snapping back to the last value — this maps that transient
/// text to the value actually logged (empty or unparsable = 0, clamped to `0...cap`)
/// and produces the canonical numeral the field is rewritten to once editing ends.
/// Tested in Tests/DurationEntryTests.swift.
enum DurationEntry {
    /// The whole-number value the field's current text represents: empty/garbage → 0,
    /// negatives floored to 0, capped at `cap` (minutes use 59).
    static func value(of text: String, cap: Int? = nil) -> Int {
        let raw = Int(text.trimmingCharacters(in: .whitespaces)) ?? 0
        let floored = max(0, raw)
        guard let cap else { return floored }
        return min(cap, floored)
    }

    /// The canonical text after editing ends ("" → "0", "07" → "7", over-cap → cap).
    static func normalized(_ text: String, cap: Int? = nil) -> String {
        String(value(of: text, cap: cap))
    }
}
