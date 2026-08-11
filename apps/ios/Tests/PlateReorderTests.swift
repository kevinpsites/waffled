import Foundation
import Testing
@testable import Waffled

// Dragging a dish between roles in the meal builder.
//
// The builder renders its roles as one flat run — header, dishes, ＋ — because a
// SwiftUI `List` only reorders within a Section and silently refuses
// `.dropDestination` outright. Dropping a dish under a different header re-files it.
//
// The trap this file exists to lock down: the ＋ rows are NOT draggable but they still
// occupy an index. Leave them out of the array the move is resolved against and every
// index below one is off by one, so a drag lands the wrong dish in the wrong role —
// silently, because there is nothing to see except a dish that went somewhere odd.
private func dish(_ id: String, role: String, sort: Int = 0) -> WaffledAPI.MealDishDTO {
    WaffledAPI.MealDishDTO(recipeId: id, title: id, emoji: nil, category: nil, role: role,
                           sortOrder: sort, prepTimeMinutes: nil, cookTimeMinutes: nil,
                           servings: nil, imageUrl: nil, cook: nil, onHand: nil,
                           toBuy: 0, toBuyNames: [])
}

/// main: [m1] · side: [s1, s2] · dessert: [] — laid out flat, that's:
///  0 header(main) · 1 m1 · 2 add(main)
///  3 header(side) · 4 s1 · 5 s2 · 6 add(side)
///  7 header(dessert) · 8 empty(dessert) · 9 add(dessert)
private let groups = PlateRoles.groups(of: [
    dish("m1", role: "main"),
    dish("s1", role: "side", sort: 1),
    dish("s2", role: "side", sort: 2),
])

@Suite struct PlateReorderTests {
    @Test("the flat run keeps every role, and an empty one gets a drop slot")
    func flatRunShape() {
        let rows = PlateReorder.rows(groups)
        #expect(rows.count == 10)
        #expect(rows[0] == .header("main"))
        #expect(rows[1] == .item(id: "m1", section: "main"))
        #expect(rows[2] == .item(id: "add:main", section: "main"))
        #expect(rows[3] == .header("side"))
        #expect(rows[7] == .header("dessert"))
        // The empty role's placeholder. Without it the role is a run of non-movable
        // rows (header + ＋), which SwiftUI offers nowhere to drop into — an empty
        // Dessert silently refused every drag.
        #expect(rows[8] == .item(id: "empty:dessert", section: "dessert"))
        #expect(rows[9] == .item(id: "add:dessert", section: "dessert"))
        // A role that HAS dishes gets no placeholder — its own rows are the slots.
        #expect(!rows.contains(.item(id: "empty:side", section: "side")))
    }

    /// Dragging the placeholder itself must write nothing.
    @Test("an empty role's drop slot never re-files anything")
    func emptySlotNeverWrites() {
        #expect(PlateReorder.target(groups, from: IndexSet(integer: 8), to: 1) == nil)
    }

    @Test("dragging the main down under Sides re-files it as a side")
    func mainBecomesASide() throws {
        let r = try #require(PlateReorder.target(groups, from: IndexSet(integer: 1), to: 5))
        #expect(r.id == "m1")
        #expect(r.role.key == "side")
    }

    @Test("dragging a side up under Main re-files it as the main")
    func sideBecomesTheMain() throws {
        let r = try #require(PlateReorder.target(groups, from: IndexSet(integer: 4), to: 2))
        #expect(r.id == "s1")
        #expect(r.role.key == "main")
    }

    /// The empty role is the interesting one — its header is the only thing marking it.
    @Test("a dish can be dragged into a role that has no dishes yet")
    func dishMovesIntoAnEmptyRole() throws {
        // onto the empty role's placeholder slot
        let r = try #require(PlateReorder.target(groups, from: IndexSet(integer: 5), to: 9))
        #expect(r.id == "s2")
        #expect(r.role.key == "dessert")
    }

    /// Reordering inside a role isn't a re-file — writing the same role back would be a
    /// pointless round-trip on every within-group nudge.
    @Test("reordering within a role writes nothing")
    func withinRoleIsANoOp() {
        #expect(PlateReorder.target(groups, from: IndexSet(integer: 5), to: 4) == nil)
    }

    /// The ＋ rows are `moveDisabled`, but the rule must not depend on the view for that.
    @Test("a ＋ row never re-files anything")
    func addRowNeverWrites() {
        #expect(PlateReorder.target(groups, from: IndexSet(integer: 2), to: 6) == nil)
    }

    /// A drop above the very first header has no role to adopt.
    @Test("dropping above the first header is ignored")
    func aboveEverythingIsIgnored() {
        #expect(PlateReorder.target(groups, from: IndexSet(integer: 4), to: 0) == nil)
    }
}
