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

    /// One server write: upsert `entry` into the slot, or clear it when `entry` is nil
    /// (mirrors `setMealPlan` / `clearMealPlan`).
    struct Op: Equatable {
        let date: String
        let mealType: String
        let entry: WaffledAPI.WeekEntryDTO?
    }

    /// The ordered, loss-safe server writes for a drop, plus the compensating write for
    /// a failure between them.
    ///
    /// Order matters: `ordered[0]` upserts the **dragged** meal into the target slot —
    /// its own row is untouched, so if this write fails the server never changed and a
    /// local snapshot rollback is a true rollback. Only `ordered[1]` rewrites the source
    /// slot (displaced meal back, or a clear on a move-to-empty). If *that* write fails,
    /// the dragged meal exists in **both** slots — a recoverable duplicate, never a loss
    /// (writing the source slot first could leave it in zero slots). `compensation` then
    /// restores the target slot to its pre-drag content, returning the server to its
    /// exact pre-drag state; if even that fails, the duplicate remains visible and fixable.
    ///
    /// Returns `nil` for the same no-op drops as `apply`.
    static func writes(_ entries: [WaffledAPI.WeekEntryDTO],
                       srcDate: String, srcSlot: String,
                       dstDate: String, dstSlot: String) -> (ordered: [Op], compensation: Op)? {
        guard !(srcDate == dstDate && srcSlot == dstSlot),
              let src = entries.first(where: { $0.date == srcDate && $0.mealType == srcSlot })
        else { return nil }
        let dst = entries.first { $0.date == dstDate && $0.mealType == dstSlot }
        return (ordered: [Op(date: dstDate, mealType: dstSlot, entry: src),
                          Op(date: srcDate, mealType: srcSlot, entry: dst)],
                compensation: Op(date: dstDate, mealType: dstSlot, entry: dst))
    }

    /// Serializes the planner's optimistic drops against its reload triggers, so every
    /// path that could refetch (`mealsRev` bumps, week paging, pull-to-refresh) obeys
    /// ONE discipline: while any drop's writes/rollback are unfinished, reloads are
    /// deferred — a half-committed week can never be fetched over the optimistic or
    /// rolled-back entries — and the last drop to settle replays exactly one reload.
    ///
    /// A finishing drop may write the entries itself (its snapshot rollback) only via
    /// `mayApplyResult`: it must be the *sole* in-flight drop with nothing deferred
    /// behind it. Overlapping drops, or any drop whose first write already landed
    /// (bumping `mealsRev`), leave the entries to the settle reload — server truth wins
    /// over guessing.
    struct Gate {
        private(set) var inFlight = 0
        private var pendingReload = false

        /// A drop's optimistic state was applied; its writes are starting.
        mutating func begin() { inFlight += 1 }

        /// A reload trigger fired. `true` → load now; `false` → deferred, replayed by
        /// the drop that settles last.
        mutating func shouldReloadNow() -> Bool {
            guard inFlight > 0 else { return true }
            pendingReload = true
            return false
        }

        /// Whether the finishing drop may write the entries itself (see type docs).
        var mayApplyResult: Bool { inFlight == 1 && !pendingReload }

        /// A drop couldn't apply its own result — queue the settle reload that will.
        mutating func requestSettleReload() { pendingReload = true }

        /// The drop fully settled (writes + reconcile/rollback done). `true` → run the
        /// deferred reload now; only the last drop out replays it.
        mutating func finish() -> Bool {
            inFlight = max(0, inFlight - 1)
            guard inFlight == 0, pendingReload else { return false }
            pendingReload = false
            return true
        }
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
