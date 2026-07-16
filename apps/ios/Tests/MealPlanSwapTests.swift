import Foundation
import Testing
@testable import Waffled

// Optimistic drag-and-drop for the weekly meal planner (MealPlanSwap.apply):
// dropping the meal at (srcDate, srcSlot) onto (dstDate, dstSlot) must return the
// post-swap entries *immediately* (the view shows them before the server round-trip):
//   - the source entry moves to the target slot
//   - whatever occupied the target slot moves back to the source slot (a swap)
//   - every other entry is untouched
//   - a drop on itself, or from an empty slot, is a no-op (nil → caller ignores)

private func entry(_ date: String, _ slot: String, title: String,
                   recipeId: String? = nil, cookName: String? = nil) -> WaffledAPI.WeekEntryDTO {
    WaffledAPI.WeekEntryDTO(
        id: "id-\(date)-\(slot)",
        date: date,
        mealType: slot,
        title: recipeId == nil ? title : nil,
        recipeId: recipeId,
        recipe: recipeId == nil ? nil : .init(title: title, emoji: "🍜", category: "dinner",
                                              prepTimeMinutes: 10, cookTimeMinutes: 25,
                                              servings: 4, imageUrl: nil),
        cook: cookName.map { .init(personId: "p-\($0)", name: $0, avatarEmoji: nil, colorHex: nil) })
}

private func at(_ entries: [WaffledAPI.WeekEntryDTO], _ date: String, _ slot: String)
    -> WaffledAPI.WeekEntryDTO? {
    entries.first { $0.date == date && $0.mealType == slot }
}

@Suite("MealPlanSwap.apply — optimistic week-planner drop")
struct MealPlanSwapTests {

    @Test("moving onto an empty slot relocates the entry and empties the source")
    func moveToEmptySlot() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1"),
                    entry("2026-07-14", "lunch", title: "Leftovers")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                     dstDate: "2026-07-15", dstSlot: "dinner")
        let moved = try! #require(out.flatMap { at($0, "2026-07-15", "dinner") })
        #expect(moved.displayTitle == "Tacos")
        #expect(out.flatMap { at($0, "2026-07-13", "dinner") } == nil)
        // The unrelated lunch is untouched.
        #expect(out.flatMap { at($0, "2026-07-14", "lunch") }?.displayTitle == "Leftovers")
        #expect(out?.count == 2)
    }

    @Test("dropping onto an occupied slot swaps the two entries")
    func swapOccupiedSlots() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1"),
                    entry("2026-07-16", "dinner", title: "Curry", recipeId: "r2")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                     dstDate: "2026-07-16", dstSlot: "dinner")
        #expect(out.flatMap { at($0, "2026-07-16", "dinner") }?.displayTitle == "Tacos")
        #expect(out.flatMap { at($0, "2026-07-13", "dinner") }?.displayTitle == "Curry")
        #expect(out?.count == 2)
    }

    @Test("the iPad grid can swap across meal types — mealType moves with the slot")
    func crossMealTypeSwap() {
        let week = [entry("2026-07-13", "breakfast", title: "Pancakes", recipeId: "r1"),
                    entry("2026-07-13", "dinner", title: "Curry", recipeId: "r2")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "breakfast",
                                     dstDate: "2026-07-13", dstSlot: "dinner")
        let movedDown = out.flatMap { at($0, "2026-07-13", "dinner") }
        let movedUp = out.flatMap { at($0, "2026-07-13", "breakfast") }
        #expect(movedDown?.displayTitle == "Pancakes")
        #expect(movedDown?.mealType == "dinner")
        #expect(movedUp?.displayTitle == "Curry")
        #expect(movedUp?.mealType == "breakfast")
    }

    @Test("a drop on the slot it came from is a no-op")
    func dropOnSelf() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1")]
        #expect(MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                   dstDate: "2026-07-13", dstSlot: "dinner") == nil)
    }

    @Test("dragging from an empty slot is a no-op")
    func emptySource() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1")]
        #expect(MealPlanSwap.apply(week, srcDate: "2026-07-14", srcSlot: "dinner",
                                   dstDate: "2026-07-15", dstSlot: "dinner") == nil)
    }

    @Test("the moved copy keeps its recipe, free-text title, and cook")
    func preservesFields() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1", cookName: "Jerry"),
                    entry("2026-07-14", "dinner", title: "Grandma's soup")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                     dstDate: "2026-07-14", dstSlot: "dinner")
        let moved = out.flatMap { at($0, "2026-07-14", "dinner") }
        #expect(moved?.recipeId == "r1")
        #expect(moved?.recipe?.emoji == "🍜")
        #expect(moved?.cook?.name == "Jerry")
        // The free-text meal that swapped back keeps its title (no recipe).
        let back = out.flatMap { at($0, "2026-07-13", "dinner") }
        #expect(back?.recipeId == nil)
        #expect(back?.title == "Grandma's soup")
    }
}
