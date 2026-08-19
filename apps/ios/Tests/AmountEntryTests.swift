import Foundation
import Testing
@testable import Waffled

// The goal-log free-entry amount fields parse through AmountEntry so the rule is
// unit-testable: the decimal pad types the *locale's* separator (a German keyboard
// types "2,5"), which bare Double.init rejects — and since an unparsable amount is 0
// and 0 disables Log/Save, a naive parse would hard-lock comma-decimal locales out
// of decimal amounts. Empty/garbage stays 0 (disabling the button), never the stale
// previous amount.
@Suite struct AmountEntryTests {
    @Test func dotDecimalsParse() {
        #expect(AmountEntry.value(of: "2.5", locale: Locale(identifier: "en_US")) == 2.5)
        #expect(AmountEntry.value(of: "2", locale: Locale(identifier: "en_US")) == 2)
        #expect(AmountEntry.value(of: ".5", locale: Locale(identifier: "en_US")) == 0.5)
    }

    @Test func commaDecimalsParseUnderCommaLocales() {
        #expect(AmountEntry.value(of: "2,5", locale: Locale(identifier: "de_DE")) == 2.5)
        #expect(AmountEntry.value(of: "0,25", locale: Locale(identifier: "fr_FR")) == 0.25)
        // Mid-edit trailing separator is a value, not garbage.
        #expect(AmountEntry.value(of: "2,", locale: Locale(identifier: "de_DE")) == 2)
    }

    @Test func dotStillParsesUnderCommaLocales() {
        // Hardware keyboards / pasted text can carry a dot even on a comma locale.
        #expect(AmountEntry.value(of: "2.5", locale: Locale(identifier: "de_DE")) == 2.5)
    }

    @Test func emptyOrGarbageIsZeroNotTheOldValue() {
        #expect(AmountEntry.value(of: "", locale: Locale(identifier: "en_US")) == 0)
        #expect(AmountEntry.value(of: "  ", locale: Locale(identifier: "de_DE")) == 0)
        #expect(AmountEntry.value(of: "abc", locale: Locale(identifier: "en_US")) == 0)
    }

    // `value` flattens "not a number" and "actually zero" into the same 0, which suits
    // the goal fields (either way the button is disabled) but not the pantry, where
    // "a pinch" is an amount worth keeping and "0" isn't. `parse` is the one rule both
    // build on, and it keeps the two apart.
    @Test func parseTellsNotANumberApartFromZero() {
        #expect(AmountEntry.parse("a pinch", locale: Locale(identifier: "en_US")) == nil)
        #expect(AmountEntry.parse("", locale: Locale(identifier: "en_US")) == nil)
        #expect(AmountEntry.parse("  ", locale: Locale(identifier: "de_DE")) == nil)
        #expect(AmountEntry.parse("0", locale: Locale(identifier: "en_US")) == 0)
        #expect(AmountEntry.parse(".5", locale: Locale(identifier: "en_US")) == 0.5)
        #expect(AmountEntry.parse("0,5", locale: Locale(identifier: "de_DE")) == 0.5)
        // A dot still parses on a comma locale (hardware keyboard, pasted text).
        #expect(AmountEntry.parse("2.5", locale: Locale(identifier: "de_DE")) == 2.5)
    }
}
