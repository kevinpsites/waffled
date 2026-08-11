import Foundation
import Testing
@testable import Waffled

// "Share list" — the plain-text handoff. A direct port of the web formatter
// (`apps/web/src/kiosk/components/share-list.ts`); these cases mirror its suite
// 1:1 so the two platforms can't drift into producing different text for the same
// list. Change one, change both.
struct ShareListTests {
    private func item(_ name: String, _ quantity: String?, _ group: String,
                      _ checked: Bool = false,
                      store: String? = nil, assignee: String? = nil) -> ShareList.Item {
        ShareList.Item(name: name, quantity: quantity, checked: checked,
                       group: group, store: store, assignee: assignee)
    }

    @Test func groupsUncheckedItemsByAisleInBoardOrder() {
        let text = ShareList.format([
            item("Milk", "1 gal", "Dairy & Chilled"),
            item("Asparagus", "2 bunch", "Produce"),
            item("Tomatoes", "2", "Produce"),
        ])
        #expect(text == ["PRODUCE", "- Asparagus (2 bunch)", "- Tomatoes (2)", "",
                         "DAIRY & CHILLED", "- Milk (1 gal)"].joined(separator: "\n"))
    }

    @Test func omitsTheParensWhenAnItemHasNoQuantity() {
        #expect(ShareList.format([item("Bread", nil, "Bakery")]) == "BAKERY\n- Bread")
    }

    @Test func excludesCheckedItemsEntirely() {
        let text = ShareList.format([
            item("Asparagus", "2 bunch", "Produce"),
            item("Butter", nil, "Dairy & Chilled", true),
        ])
        #expect(text == "PRODUCE\n- Asparagus (2 bunch)")
    }

    @Test func filesGroupLessItemsUnderOther() {
        let text = ShareList.format([
            item("Cookies", nil, ""),
            item("Asparagus", "2 bunch", "Produce"),
        ])
        #expect(text == ["PRODUCE", "- Asparagus (2 bunch)", "", "OTHER", "- Cookies"].joined(separator: "\n"))
    }

    @Test func appendsUnknownAislesAfterTheKnownBoardOrder() {
        let text = ShareList.format([
            item("Charcoal", nil, "Seasonal"),
            item("Asparagus", nil, "Produce"),
        ])
        #expect(text == ["PRODUCE", "- Asparagus", "", "SEASONAL", "- Charcoal"].joined(separator: "\n"))
    }

    @Test func returnsAnEmptyStringWhenEverythingIsChecked() {
        #expect(ShareList.format([item("Butter", nil, "Dairy & Chilled", true)]).isEmpty)
    }

    // Custom lists (hardware run, packing list) often have no sections at all.
    // Filing the whole thing under a lone OTHER header is noise, not structure.
    @Test func omitsHeadersEntirelyWhenNothingIsGrouped() {
        let text = ShareList.format([
            item("Wood screws", "1 box", ""),
            item("Sandpaper", nil, ""),
            item("Wood glue", nil, ""),
        ])
        #expect(text == ["- Wood screws (1 box)", "- Sandpaper", "- Wood glue"].joined(separator: "\n"))
    }

    @Test func keepsTheHeaderWhenTheSingleGroupIsARealSection() {
        #expect(ShareList.format([item("Wood screws", nil, "Hardware")]) == "HARDWARE\n- Wood screws")
    }

    @Test func stillUsesOtherWhenSomeItemsAreGroupedAndSomeAreNot() {
        let text = ShareList.format([item("Wood screws", nil, "Hardware"), item("Snacks", nil, "")])
        #expect(text == ["HARDWARE", "- Wood screws", "", "OTHER", "- Snacks"].joined(separator: "\n"))
    }

    // The two things the shopper actually needs that the plain name doesn't carry:
    // which shop it's from, and whose item it is.
    @Test func notesTheStoreWhenAnItemHasOne() {
        let text = ShareList.format([item("Whole milk", "1 gal", "Dairy & Chilled", store: "Costco")])
        #expect(text == "DAIRY & CHILLED\n- Whole milk (1 gal) [Costco]")
    }

    @Test func notesWhoAnItemIsForWhenItIsAssigned() {
        let text = ShareList.format([item("Swimsuits", "×4", "Clothes", assignee: "Kelly")])
        #expect(text == "CLOTHES\n- Swimsuits (×4) [Kelly]")
    }

    @Test func listsStoreThenPersonWhenAnItemHasBoth() {
        let text = ShareList.format([item("Whole milk", "1 gal", "Dairy & Chilled",
                                          store: "Costco", assignee: "Kelly")])
        #expect(text == "DAIRY & CHILLED\n- Whole milk (1 gal) [Costco · Kelly]")
    }

    // Brackets, not a dash: item names already carry em-dashed allergen warnings,
    // so a dash separator would read as more of the name.
    @Test func staysUnambiguousNextToAnAllergenNoteAlreadyInTheName() {
        let text = ShareList.format([item("Shredded mozzarella — contains milk", nil,
                                          "Dairy & Chilled", store: "Costco")])
        #expect(text == "DAIRY & CHILLED\n- Shredded mozzarella — contains milk [Costco]")
    }

    @Test func addsNothingWhenNeitherIsSet() {
        let text = ShareList.format([item("Bananas", "1 bunch", "Produce")])
        #expect(text == "PRODUCE\n- Bananas (1 bunch)")
    }

    @Test func ignoresBlankStringsRatherThanEmittingEmptyBrackets() {
        let text = ShareList.format([item("Bananas", nil, "Produce", store: "  ", assignee: "")])
        #expect(text == "PRODUCE\n- Bananas")
    }

    // MARK: mapping a real list row

    // Grocery rows carry `aisle`; custom-list rows carry `section`. One adapter so
    // both kinds of list share the formatter (and the ⋯ → Share action).
    @Test func mapsAGroceryRowByItsAisle() {
        let dto = WaffledAPI.ListItemDTO(
            id: "1", name: "Milk", quantity: "1 gal", quantityInput: nil, checked: false,
            section: nil, store: "Costco", priority: nil,
            assignee: .init(name: "Kelly", avatarEmoji: nil, colorHex: nil),
            aisle: "Dairy & Chilled", sourceRecipeIds: nil, weekStart: nil)
        let mapped = ShareList.item(from: dto)
        #expect(mapped.group == "Dairy & Chilled")
        #expect(mapped.store == "Costco")
        #expect(mapped.assignee == "Kelly")
    }

    @Test func fallsBackToSectionForACustomListRow() {
        let dto = WaffledAPI.ListItemDTO(
            id: "2", name: "Sunscreen", quantity: nil, quantityInput: nil, checked: false,
            section: "Toiletries", store: nil, priority: nil, assignee: nil,
            aisle: nil, sourceRecipeIds: nil, weekStart: nil)
        let mapped = ShareList.item(from: dto)
        #expect(mapped.group == "Toiletries")
        #expect(mapped.assignee == nil)
    }
}
