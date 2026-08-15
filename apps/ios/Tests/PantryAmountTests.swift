import Foundation
import Testing
@testable import Waffled

// Pantry amounts are free text ("2", "half a bag", "0.5") and go to the server as a
// string, where the scan count-up parses them with JS `Number`. So anything numeric
// has to leave the device dot-decimal: a German keyboard types "0,5", which the
// server reads as NaN and silently treats as 1. Non-numeric text passes through
// untouched — "a pinch" is a legitimate amount.
@Suite struct PantryAmountTests {
    @Test func fractionsSurviveAsDotDecimals() {
        #expect(PantryAmount.canonical("0.5", locale: Locale(identifier: "en_US")) == "0.5")
        #expect(PantryAmount.canonical(".5", locale: Locale(identifier: "en_US")) == "0.5")
        #expect(PantryAmount.canonical(".25", locale: Locale(identifier: "en_US")) == "0.25")
        #expect(PantryAmount.canonical("0.75", locale: Locale(identifier: "en_US")) == "0.75")
    }

    @Test func commaLocalesSendDotDecimals() {
        #expect(PantryAmount.canonical("0,5", locale: Locale(identifier: "de_DE")) == "0.5")
        #expect(PantryAmount.canonical("1,25", locale: Locale(identifier: "fr_FR")) == "1.25")
    }

    @Test func wholeNumbersStayWhole() {
        #expect(PantryAmount.canonical("2", locale: Locale(identifier: "en_US")) == "2")
        #expect(PantryAmount.canonical(" 3 ", locale: Locale(identifier: "en_US")) == "3")
        #expect(PantryAmount.canonical("2.0", locale: Locale(identifier: "en_US")) == "2")
    }

    @Test func freeTextIsLeftAlone() {
        #expect(PantryAmount.canonical("a pinch", locale: Locale(identifier: "en_US")) == "a pinch")
        #expect(PantryAmount.canonical("", locale: Locale(identifier: "en_US")) == "")
    }

    // The scan sheet's ± buttons must not walk a fraction off its own grid or go negative.
    @Test func steppingKeepsTheFraction() {
        #expect(PantryAmount.stepped("0.5", by: 1, locale: Locale(identifier: "en_US")) == "1.5")
        #expect(PantryAmount.stepped("0.25", by: -1, locale: Locale(identifier: "en_US")) == "0")
        #expect(PantryAmount.stepped("a pinch", by: 1, locale: Locale(identifier: "en_US")) == "1")
    }
}

// The scan confirm sheet has to say what's in the box AND whether it matters to this
// household — a bare "Contains: milk" is useless if you don't remember who reacts to
// dairy.
@Suite struct PantryAllergenFlagTests {
    let people = ["milk": ["Elaine"], "peanut": ["George", "Elaine"]]

    @Test func flagsOnlyWhatTheHouseholdAvoids() {
        let avoid = Set(["milk"]).union(people.keys)
        #expect(PantryAllergen.flagged(["milk", "soy"], avoid: avoid) == ["milk"])
        #expect(PantryAllergen.flagged(["soy"], avoid: avoid).isEmpty)
    }

    @Test func namesEveryoneAffectedOnce() {
        #expect(PantryAllergen.affected(["milk", "peanut"], people: people) == ["Elaine", "George"])
        #expect(PantryAllergen.affected(["soy"], people: people).isEmpty)
    }
}
