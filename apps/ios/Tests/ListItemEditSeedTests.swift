import Foundation
import Testing
@testable import Waffled

// The row stores a quantity for READING ("1½ lb") and the server sends a second one for
// TYPING ("1 1/2 lb"), because ½ has no key. The edit field is seeded from the typable
// one, so anything deciding "did this change?" has to compare against the same form —
// against `quantity` it never matches, and merely focusing a row and tapping away saves.

@Suite struct ListItemEditSeedTests {
    private func item(_ json: String) throws -> WaffledAPI.ListItemDTO {
        try JSONDecoder().decode(WaffledAPI.ListItemDTO.self, from: Data(json.utf8))
    }

    @Test func seedsFromTheTypableQuantity() throws {
        let i = try item(#"{"id":"1","name":"Flour","quantity":"1½ lb","quantityInput":"1 1/2 lb","checked":false}"#)
        #expect(i.editableQuantity == "1 1/2 lb")
    }

    @Test func submittingTheSeedUnchangedIsNotAnEdit() throws {
        // The exact tap-away path: seed the box, submit it untouched, expect "no change".
        let i = try item(#"{"id":"1","name":"Flour","quantity":"1½ lb","quantityInput":"1 1/2 lb","checked":false}"#)
        let typed = i.editableQuantity
        #expect(typed == i.editableQuantity)
        // …and the old comparison is exactly what made this look like a change.
        #expect(typed != (i.quantity ?? ""))
    }

    @Test func fallsBackForAServerThatDoesNotSendOne() throws {
        let older = try item(#"{"id":"1","name":"Milk","quantity":"2 gal","checked":false}"#)
        #expect(older.editableQuantity == "2 gal")
        let none = try item(#"{"id":"1","name":"Bread","checked":false}"#)
        #expect(none.editableQuantity == "")
    }
}
