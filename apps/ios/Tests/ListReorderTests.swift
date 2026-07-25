import Foundation
import Testing
@testable import Waffled

// Drag-to-move-between-sections: after SwiftUI's `.onMove` on the flattened
// header+items rows, the moved item adopts the section of the header it landed under.
// These lock the pure position→section rule (the gesture itself is user-verified).

@Suite struct ListReorderTests {
    typealias Row = ListReorder.Row

    // CLOTHES: Rain, Cooler   |   GEAR: Sunscreen
    private let rows: [Row] = [
        .header("Clothes"),
        .item(id: "rain", section: "Clothes"),
        .item(id: "cooler", section: "Clothes"),
        .header("Gear"),
        .item(id: "sun", section: "Gear"),
    ]

    @Test func dragItemUnderAnotherSectionHeaderMovesIt() {
        // Drag "cooler" (idx 2) down to the end (idx 5) → lands after GEAR's items.
        let out = ListReorder.targetSection(rows: rows, from: [2], to: 5)
        #expect(out?.id == "cooler")
        #expect(out?.section == "Gear")
    }

    @Test func dropRightAfterTheTargetHeaderJoinsThatSection() {
        // Drag "cooler" (idx 2) to just after the GEAR header (idx 4).
        let out = ListReorder.targetSection(rows: rows, from: [2], to: 4)
        #expect(out?.section == "Gear")
    }

    @Test func reorderWithinSameSectionIsANoOp() {
        // Drag "rain" (idx 1) below "cooler" but still inside CLOTHES (idx 3).
        #expect(ListReorder.targetSection(rows: rows, from: [1], to: 3) == nil)
    }

    @Test func draggingUpIntoAnEarlierSection() {
        // Drag "sun" (idx 4) up under the CLOTHES header (idx 1) → becomes Clothes.
        let out = ListReorder.targetSection(rows: rows, from: [4], to: 1)
        #expect(out?.id == "sun")
        #expect(out?.section == "Clothes")
    }

    @Test func droppingAboveTheFirstHeaderIsIgnored() {
        // No section owns the space above the first header.
        #expect(ListReorder.targetSection(rows: rows, from: [4], to: 0) == nil)
    }

    @Test func movingIntoTheUntitledGroupYieldsNilSection() {
        let mixed: [Row] = [
            .header("Gear"),
            .item(id: "sun", section: "Gear"),
            .header(nil),
            .item(id: "misc", section: nil),
        ]
        // Drag "sun" (idx 1) to the end (idx 4) → under the untitled header.
        let out = ListReorder.targetSection(rows: mixed, from: [1], to: 4)
        #expect(out?.id == "sun")
        #expect(out?.section == nil)
    }

    @Test func headerRowAsSourceIsRejected() {
        #expect(ListReorder.targetSection(rows: rows, from: [0], to: 4) == nil)
    }
}
