import Foundation

/// Locale-aware parse rule for the goal-log free-entry *amount* fields (sibling of
/// DurationEntry, which handles the whole-number hours/minutes fields). The decimal
/// pad types the locale's decimal separator — "2,5" on a German keyboard — which bare
/// `Double.init` rejects; since an unparsable amount is 0 and 0 disables Log/Save,
/// a naive parse would lock comma-decimal locales out of decimal amounts entirely.
/// Empty/garbage → 0 (disabling the button), never the stale previous amount.
/// Tested in Tests/AmountEntryTests.swift.
enum AmountEntry {
    /// The single rule for reading a typed amount. `nil` means "not a number at all",
    /// which the goal fields don't care about but the pantry does — there an amount is
    /// free text and "a pinch" has to survive untouched while "0,5" gets normalised.
    static func parse(_ text: String, locale: Locale = .current) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        if let v = Double(t) { return v }                     // "2.5", "2", ".5"
        // Fall back to the locale's decimal separator ("2,5" → "2.5", "2," → "2.").
        if let sep = locale.decimalSeparator, sep != "." {
            return Double(t.replacingOccurrences(of: sep, with: "."))
        }
        return nil
    }

    /// Empty/garbage → 0, which disables Log/Save. See the type comment.
    static func value(of text: String, locale: Locale = .current) -> Double {
        parse(text, locale: locale) ?? 0
    }
}
