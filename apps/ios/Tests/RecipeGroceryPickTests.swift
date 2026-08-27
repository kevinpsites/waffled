import Foundation
import Testing
@testable import Waffled

// The recipe → "Add to grocery list" picker's opening state.
//
// `inPantry` and `isStaple` answer two different questions and the picker must keep
// them apart:
//
//   inPantry — the server matched this against the household's actual pantry. An
//              observation. Pre-UNCHECK it: adding something you were just told you
//              have is the noise this removes.
//   isStaple — the household is assumed to keep this around. An assumption, not an
//              observation. Stays CHECKED, with only a muted hint, because an item
//              missing at the shop costs more than an extra one to uncheck.
//
// Reversing the staple default while implementing the pantry one would silently drop
// items the shopper never told us they had — hence the explicit tests below.
@Suite struct RecipeGroceryPickTests {

    private func ing(_ id: String, _ name: String, staple: Bool = false, inPantry: Bool? = nil)
        -> WaffledAPI.RecipeIngredientDTO {
        .init(id: id, name: name, amount: nil, unit: nil, prepNote: nil, display: nil,
              section: nil, aisle: nil, isStaple: staple, sortOrder: nil, sub: nil, inPantry: inPantry)
    }

    // MARK: decoding

    /// `GET /api/recipes/:id` sends `inPantry` on every ingredient.
    @Test func decodesInPantry() throws {
        let json = Data("""
        {"id":"a1","name":"Eggs","amount":2,"unit":null,"prepNote":null,"display":"2 eggs",
         "section":null,"aisle":"Dairy & Chilled","isStaple":false,"sortOrder":1,"sub":null,"inPantry":true}
        """.utf8)
        let i = try JSONDecoder().decode(WaffledAPI.RecipeIngredientDTO.self, from: json)
        #expect(i.inPantry == true)
    }

    /// A server predating the field, and every other ingredient payload in the app
    /// (plates, cook mode, the meal-builder) that never carried it. Must decode — a
    /// throw here reads to the user as "couldn't reach server".
    @Test func decodesAnIngredientWithoutInPantry() throws {
        let json = Data("""
        {"id":"a1","name":"Eggs","amount":2,"unit":null,"prepNote":null,"display":"2 eggs",
         "section":null,"aisle":null,"isStaple":false,"sortOrder":1,"sub":null}
        """.utf8)
        let i = try JSONDecoder().decode(WaffledAPI.RecipeIngredientDTO.self, from: json)
        #expect(i.inPantry == nil)
        #expect(RecipeGroceryPick.initialSelection([i]) == ["a1"])   // unknown ⇒ still added
    }

    // MARK: the opening selection

    @Test func unchecksWhatThePantrySaysYouHave() {
        let items = [ing("a", "Eggs", inPantry: true), ing("b", "Flour"), ing("c", "Butter", inPantry: false)]
        #expect(RecipeGroceryPick.initialSelection(items) == ["b", "c"])
        #expect(RecipeGroceryPick.pantryCount(items) == 1)
    }

    /// The one that must not regress: a staple is an assumption, so it opens CHECKED.
    @Test func keepsStaplesChecked() {
        let items = [ing("a", "Salt", staple: true), ing("b", "Olive oil", staple: true), ing("c", "Cod")]
        #expect(RecipeGroceryPick.initialSelection(items) == ["a", "b", "c"])
        #expect(RecipeGroceryPick.pantryCount(items) == 0)
    }

    /// A staple the pantry actually matched follows the pantry, not the assumption —
    /// the observation is the stronger claim.
    @Test func aStapleThePantryMatchedStillUnchecks() {
        let items = [ing("a", "Salt", staple: true, inPantry: true), ing("b", "Cod")]
        #expect(RecipeGroceryPick.initialSelection(items) == ["b"])
    }

    // MARK: copy — nothing should happen silently

    @Test func saysHowManyItUnchecked() {
        #expect(RecipeGroceryPick.intro(pantryCount: 3)
                == "We’ve already unchecked 3 items your pantry says you have.")
        #expect(RecipeGroceryPick.intro(pantryCount: 1)
                == "We’ve already unchecked 1 item your pantry says you have.")
        #expect(RecipeGroceryPick.intro(pantryCount: 0) == "Uncheck anything you already have on hand.")
    }

    /// Pre-unchecking can empty the selection outright when the pantry covers the whole
    /// recipe. "Add 0 items" on a dead button explains nothing — name the state.
    @Test func namesTheEmptyStateOnTheAddButton() {
        #expect(RecipeGroceryPick.addLabel(count: 0) == "Nothing to add")
        #expect(RecipeGroceryPick.addLabel(count: 1) == "Add 1 item")
        #expect(RecipeGroceryPick.addLabel(count: 4) == "Add 4 items")
    }

    /// The hint slot holds one line: a real match outranks an assumed one.
    @Test func theRealMatchWinsTheHintSlot() {
        #expect(RecipeGroceryPick.hint(for: ing("a", "Salt", staple: true, inPantry: true)) == .inPantry)
        #expect(RecipeGroceryPick.hint(for: ing("a", "Salt", staple: true)) == .staple)
        #expect(RecipeGroceryPick.hint(for: ing("a", "Cod")) == nil)
    }

    // MARK: when the action can run at all

    /// The recipe detail's toolbar menu is live from the first frame, but the sheet
    /// builds its whole state from `ingredients`, which arrive with `loadDetail()`. Tap
    /// it early enough and the sheet opens on an empty list with nothing to add.
    @Test func cannotAddBeforeTheIngredientsLoad() {
        #expect(RecipeGroceryPick.canAdd([]) == false)
    }

    @Test func canAddOnceTheIngredientsAreThere() {
        #expect(RecipeGroceryPick.canAdd([ing("a", "Cod")]) == true)
    }

    /// A pantry that covers the entire recipe opens the sheet with NOTHING checked —
    /// but the action is still worth offering. The rows are all there, each one says
    /// why it's unchecked, and "Select all" is the way to override us. That is a very
    /// different screen from the empty one, and only the empty one is a bug.
    @Test func aFullyStockedPantryStillOpensTheSheet() {
        let all = [ing("a", "Eggs", inPantry: true), ing("b", "Milk", inPantry: true)]
        #expect(RecipeGroceryPick.initialSelection(all).isEmpty)
        #expect(RecipeGroceryPick.canAdd(all) == true)
    }
}
