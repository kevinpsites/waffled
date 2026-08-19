import Foundation
import Testing
@testable import Waffled

// Creating a section that already exists in a different capitalisation is a no-op
// server-side, and the response carries the household's own spelling. Saving the typed
// one instead files the item under a section the list doesn't recognise, so it lands in
// the "Other" catch-all with nothing anywhere to explain why. The web has the same rule
// and its own test; this is the iOS half.
@Suite struct PantrySectionsTests {
    let household = ["Freezer", "Fridge", "Garage shelf"]

    @Test func aCasingOnlyMatchResolvesToTheHouseholdSpelling() {
        #expect(PantrySections.canonical("garage shelf", in: household) == "Garage shelf")
        #expect(PantrySections.canonical("GARAGE SHELF", in: household) == "Garage shelf")
        #expect(PantrySections.canonical("Garage Shelf", in: household) == "Garage shelf")
    }

    @Test func anExactMatchIsLeftAlone() {
        #expect(PantrySections.canonical("Garage shelf", in: household) == "Garage shelf")
        #expect(PantrySections.canonical("Freezer", in: household) == "Freezer")
    }

    @Test func agenuinelyNewSectionKeepsWhatWasTyped() {
        #expect(PantrySections.canonical("Chest freezer", in: household) == "Chest freezer")
        // Nothing to match against at all — still no reason to lose the name.
        #expect(PantrySections.canonical("Chest freezer", in: []) == "Chest freezer")
    }

    // A near-miss is a different section, not a casing variant.
    @Test func aDifferentNameIsNotTreatedAsAMatch() {
        #expect(PantrySections.canonical("Garage shelves", in: household) == "Garage shelves")
        #expect(PantrySections.canonical("Garage", in: household) == "Garage")
    }
}
