import Foundation
import Testing
@testable import Waffled

// "By store" grouping. The store box is free text and `canonicalStore` only snaps NEW
// writes, so rows saved before it existed can still hold a variant casing. The section
// header is uppercased in CSS/SwiftUI, so "costco" and "Costco" both read as "COSTCO" —
// two identically-labelled sections unless the grouping folds case. The web already
// folds (GroceryBoard.tsx); these lock the same rule on iOS.

private func item(_ id: String, _ name: String, store: String? = nil) -> WaffledAPI.ListItemDTO {
    let s = store.map { "\"\($0)\"" } ?? "null"
    let json = "{\"id\":\"\(id)\",\"name\":\"\(name)\",\"checked\":false,\"store\":\(s)}"
    return try! JSONDecoder().decode(WaffledAPI.ListItemDTO.self, from: Data(json.utf8))
}

@Suite struct StoreGroupingTests {
    @Test func foldsStoresTypedWithDifferentCasing() {
        let groups = StoreGrouping.sections(items: [
            item("i1", "Rotisserie chicken", store: "Costco"),
            item("i2", "Batteries", store: "costco"),
            item("i3", "Muffins", store: "COSTCO"),
        ])
        #expect(groups.count == 1)
        #expect(groups[0].items.count == 3)
        // First-seen casing wins the label, matching the web.
        #expect(groups[0].title == "Costco")
    }

    @Test func ignoresSurroundingWhitespace() {
        let groups = StoreGrouping.sections(items: [
            item("i1", "Wine", store: "Trader Joe's"),
            item("i2", "Bread", store: "  trader joe's  "),
        ])
        #expect(groups.count == 1)
        #expect(groups[0].items.count == 2)
    }

    @Test func unassignedItemsTrailInTheirOwnGroup() {
        let groups = StoreGrouping.sections(items: [
            item("i1", "Milk"),
            item("i2", "Eggs", store: "Walmart"),
            item("i3", "Whitespace only", store: "   "),
        ])
        #expect(groups.count == 2)
        #expect(groups[0].title == "Walmart")
        #expect(groups[1].title == "No store")
        #expect(groups[1].items.map(\.name).sorted() == ["Milk", "Whitespace only"])
        #expect(groups[1].sectionValue == nil)
    }

    @Test func storesAreListedAlphabetically() {
        let groups = StoreGrouping.sections(items: [
            item("i1", "a", store: "Walmart"),
            item("i2", "b", store: "Costco"),
            item("i3", "c", store: "aldi"),
        ])
        #expect(groups.map(\.title) == ["aldi", "Costco", "Walmart"])
    }
}
