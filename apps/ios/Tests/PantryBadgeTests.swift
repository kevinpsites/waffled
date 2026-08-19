import Foundation
import Testing
@testable import Waffled

// The grocery board's "you already have this" badge.
//
// Two separate things are locked down here.
//
// 1. DECODING. `pantry` is sent by the BOARD endpoint only — the plain
//    `GET /api/lists/:id/items` rows have no such key, and neither does any server
//    predating the field. This app has already been bitten once by a strict
//    `Decodable` failing on a key one endpoint didn't send: the throw surfaces as a
//    bogus "couldn't reach server", so the whole list looks offline because of an
//    optional badge. `pantry` must therefore be optional, and a payload without it
//    must decode cleanly.
//
// 2. THE DISPLAY RULE. Matching is fuzzy ("chicken" ↔ "boneless chicken breast"), so
//    what the badge says is not interchangeable: when the pantry item's name differs
//    from the row's, that NAME is the half that can change your mind and it leads.
//    When the names are the same, the name adds nothing and only the amount is worth
//    the width.
@Suite struct PantryBadgeTests {

    // MARK: decoding

    /// A grocery-board row, verbatim: it carries `pantry`.
    private static let boardRow = Data("""
    {"id":"1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8","name":"Eggs","quantity":"12","checked":false,
     "section":"Dairy & Chilled","aisle":"Dairy & Chilled","store":null,"priority":3,
     "sourceRecipeIds":[],"weekStart":"2026-08-16",
     "pantry":{"name":"Free-range eggs","amount":"6","unit":""}}
    """.utf8)

    /// The same row as the PLAIN list endpoint sends it — no `pantry` key at all.
    private static let plainRow = Data("""
    {"id":"1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8","name":"Eggs","quantity":"12","checked":false,
     "section":"Dairy & Chilled","store":null}
    """.utf8)

    @Test func decodesTheBoardsPantryHit() throws {
        let row = try JSONDecoder().decode(WaffledAPI.ListItemDTO.self, from: Self.boardRow)
        #expect(row.pantry?.name == "Free-range eggs")
        #expect(row.pantry?.amount == "6")
        #expect(row.pantry?.unit == "")
    }

    /// The regression that matters: a row without the key decodes, and simply makes no
    /// pantry claim. `nil` here means "we don't know" — the pantry module may be off —
    /// never "you have none".
    @Test func decodesARowWithNoPantryKeyAtAll() throws {
        let row = try JSONDecoder().decode(WaffledAPI.ListItemDTO.self, from: Self.plainRow)
        #expect(row.name == "Eggs")
        #expect(row.pantry == nil)
    }

    /// An explicit `null` (pantry module off) is the same "we don't know".
    @Test func decodesAnExplicitNullPantry() throws {
        let json = Data(#"{"id":"a","name":"Eggs","checked":false,"pantry":null}"#.utf8)
        let row = try JSONDecoder().decode(WaffledAPI.ListItemDTO.self, from: json)
        #expect(row.pantry == nil)
    }

    // MARK: the display rule

    private func label(row: String, name: String, amount: String, unit: String) -> String {
        PantryBadge.label(rowName: row, hit: .init(name: name, amount: amount, unit: unit))
    }

    /// Exact match (modulo case/whitespace): the row already says the name, so only the
    /// amount earns the width.
    @Test func showsOnlyTheAmountOnAnExactNameMatch() {
        #expect(label(row: "Eggs", name: "eggs", amount: "6", unit: "") == "6")
        #expect(label(row: " Rice ", name: "Rice", amount: "2", unit: "bags") == "2 bags")
    }

    /// Fuzzy match: the matched name leads, because "Chicken" matched by "Boneless
    /// chicken breast" is a difference that can change your mind and "3 pack" wouldn't
    /// tell you.
    @Test func leadsWithTheMatchedNameWhenItDiffers() {
        #expect(label(row: "Peas", name: "Frozen peas", amount: "2", unit: "bags") == "Frozen peas · 2 bags")
    }

    /// A fuzzy match with nothing to say about quantity still names what it found —
    /// falling back to the generic "in pantry" here would throw away the only
    /// informative half.
    @Test func namesTheMatchEvenWithNoAmount() {
        #expect(label(row: "Peas", name: "Frozen peas", amount: "", unit: "") == "Frozen peas")
    }

    /// Exact name, no amount, no unit: there is genuinely nothing to add, so the badge
    /// falls back to the bare claim.
    @Test func fallsBackToABareLabelWhenThereIsNothingToSay() {
        #expect(label(row: "Eggs", name: "Eggs", amount: "", unit: "") == "in pantry")
        #expect(label(row: "Eggs", name: "Eggs", amount: "  ", unit: " ") == "in pantry")
    }

    /// A unit with no number is still a unit worth showing ("a bag" beats "in pantry").
    @Test func showsAUnitWithNoNumber() {
        #expect(label(row: "Rice", name: "Rice", amount: "", unit: "bag") == "bag")
    }
}
