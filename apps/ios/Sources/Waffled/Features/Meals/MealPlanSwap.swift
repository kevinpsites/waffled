import SwiftUI
import UniformTypeIdentifiers

/// A custom (non-text) drag payload for moving a planned meal between week-planner
/// slots. A plain `String` payload would let any TextField intercept the drop and
/// paste "2026-07-13|dinner" as text (the same bug the ingredient-row drag hit) — a
/// custom UTType, declared in project.yml and conforming to `public.data` (NOT
/// `public.text`), means only the planner's drop targets accept it.
extension UTType {
    static let waffledMealSlot = UTType(exportedAs: "app.waffled.meal-slot")
}

struct MealSlotDrag: Transferable, Codable {
    let date: String       // "yyyy-MM-dd"
    let mealType: String   // "breakfast" | "lunch" | "dinner" | "snack"
    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .waffledMealSlot)
    }
}

/// Pure swap math for the week planner's drag-and-drop, so the view can update its
/// entries *optimistically* (before the server round-trip) and the rule is unit-tested.
enum MealPlanSwap {
    /// The post-drop entries when the meal at (`srcDate`, `srcSlot`) lands on
    /// (`dstDate`, `dstSlot`): the source entry moves to the target slot, and whatever
    /// occupied the target moves back to the source slot (a swap). Every other entry
    /// is untouched. Returns `nil` for a no-op drop — nothing at the source, or a drop
    /// on the slot it came from — so the caller can ignore it.
    static func apply(_ entries: [WaffledAPI.WeekEntryDTO],
                      srcDate: String, srcSlot: String,
                      dstDate: String, dstSlot: String) -> [WaffledAPI.WeekEntryDTO]? {
        guard !(srcDate == dstDate && srcSlot == dstSlot),
              let src = entries.first(where: { $0.date == srcDate && $0.mealType == srcSlot })
        else { return nil }
        let dst = entries.first { $0.date == dstDate && $0.mealType == dstSlot }
        var out = entries.filter {
            !($0.date == srcDate && $0.mealType == srcSlot)
                && !($0.date == dstDate && $0.mealType == dstSlot)
        }
        out.append(src.moved(to: dstDate, slot: dstSlot))
        if let dst { out.append(dst.moved(to: srcDate, slot: srcSlot)) }
        return out
    }
}

private extension WaffledAPI.WeekEntryDTO {
    /// A copy of this entry relocated to another slot — recipe, free-text title, and
    /// cook travel with it (mirrors what the server keeps on an upsert).
    func moved(to date: String, slot: String) -> WaffledAPI.WeekEntryDTO {
        .init(id: id, date: date, mealType: slot, title: title,
              recipeId: recipeId, recipe: recipe, cook: cook)
    }
}
