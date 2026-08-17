import Foundation
import Testing
@testable import Waffled

// The recipe screen's "N of M on hand" line.
//
// The bug this locks down: the count used to come from `ingredients.isStaple`, which
// never touches the pantry. A staple is something you're assumed to keep around, not
// something you currently have — so a household with a completely empty pantry was
// told it had 4 of 9 ingredients. The counts must come from the server's real pantry
// matching, and when the pantry module is off the banner must make NO on-hand claim
// rather than falling back to the staple proxy or to a misleading "0 of 9".
@Suite struct OnHandBannerTests {
    private let ninePantryless = ["penne", "basil", "garlic", "cream", "parmesan",
                                  "parmesan rind", "chilli", "olive oil", "salt"]

    @Test func claimsTheServersRealCountWhenThePantryIsOn() {
        let c = OnHandBanner.copy(onHand: .init(have: 4, total: 9), toBuy: 2,
                                  toBuyNames: ["basil", "cream"], nonStapleNames: ninePantryless)
        #expect(c.lead == "4 of 9")
        #expect(c.tail == " on hand — need basil, cream")
        #expect(c.showsAddButton)
    }

    @Test func celebratesWhenNothingIsLeftToBuy() {
        let c = OnHandBanner.copy(onHand: .init(have: 9, total: 9), toBuy: 0,
                                  toBuyNames: [], nonStapleNames: [])
        #expect(c.lead == "9 of 9")
        #expect(c.tail == " on hand — you’ve got everything")
        #expect(c.showsAddButton == false)
    }

    /// The pantry module is off. "N to buy" still works (it isn't pantry-derived), but
    /// there must be no on-hand number anywhere in the line.
    @Test func makesNoOnHandClaimWithThePantryOff() {
        let c = OnHandBanner.copy(onHand: nil, toBuy: 2, toBuyNames: ["basil", "cream"],
                                  nonStapleNames: ninePantryless)
        #expect(c.lead == nil)
        #expect(c.tail == "Need basil, cream")
        #expect(!c.tail.contains("on hand"))
        #expect(!c.tail.contains("0 of"))
        #expect(c.showsAddButton)
    }

    @Test func pantryOffWithNothingToBuySaysWhyWithoutClaimingOnHand() {
        let c = OnHandBanner.copy(onHand: nil, toBuy: 0, toBuyNames: [], nonStapleNames: [])
        #expect(c.lead == nil)
        #expect(c.tail == "Nothing to buy — it’s all pantry staples")
        #expect(!c.tail.contains("on hand"))
        #expect(c.showsAddButton == false)
    }

    @Test func namesOnlyTheFirstThreeAndCountsTheRest() {
        let c = OnHandBanner.copy(onHand: .init(have: 1, total: 6), toBuy: 5,
                                  toBuyNames: ["a", "b", "c", "d", "e"], nonStapleNames: [])
        #expect(c.tail == " on hand — need a, b, c +2 more")
    }

    /// A server too old to send counts. Fall back to the ingredient split for the
    /// shopping list — but still make no on-hand claim, since we genuinely can't say.
    @Test func fallsBackWithoutClaimingOnHandOnAnOlderServer() {
        let c = OnHandBanner.copy(onHand: nil, toBuy: nil, toBuyNames: [],
                                  nonStapleNames: ["basil", "cream"])
        #expect(c.lead == nil)
        #expect(c.tail == "Need basil, cream")
        #expect(c.showsAddButton)
    }

    /// The specific regression: an empty pantry with everything flagged a staple must
    /// NOT report those staples as on hand.
    @Test func anEmptyPantryDoesNotCountStaplesAsOnHand() {
        let c = OnHandBanner.copy(onHand: .init(have: 0, total: 9), toBuy: 9,
                                  toBuyNames: ninePantryless, nonStapleNames: [])
        #expect(c.lead == "0 of 9")
        #expect(c.tail.hasPrefix(" on hand — need penne"))
    }
}
