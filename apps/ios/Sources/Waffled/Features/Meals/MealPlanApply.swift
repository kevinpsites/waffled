import Foundation

/// Everything "Plan my week/month & build list" sends to the server, as an ordered value.
///
/// The sheets used to decide this inline — write these nights, clear those, then derive the
/// grocery weeks from what was touched. That left the interesting half untestable: a test
/// could check `GroceryWeeks.weekStarts` on its own, but nothing said an apply actually
/// *issues* those rebuilds. A review proved the gap by reverting either sheet to one
/// `rebuildGroceryFromWeek(weekStart: monthStart)` call — the original month bug — with
/// every iOS test still green.
///
/// So the decision is data and the sheets just execute it, the same shape
/// `MealPlanSwap.writes` already uses for drag-to-swap.
enum MealPlanApply {

    enum Op: Equatable, Sendable {
        /// Upsert one night. `recipeId` and `title` are mutually exclusive: a card backed
        /// by a recipe sends the id, a free-text card sends the words.
        case set(date: String, mealType: String, recipeId: String?, title: String?)
        case clear(date: String, mealType: String)
        case rebuild(weekStart: String)
    }

    /// "Plan my week": every drafted night is written, then the grocery weeks those dates
    /// fall in are rebuilt.
    static func week(suggestions: [WaffledAPI.PlanCardDTO], firstDay: HouseholdWeekStart?) -> [Op] {
        let writes = suggestions.map(setOp)
        return writes + rebuildOps(for: suggestions.map(\.date), firstDay: firstDay, whenEmpty: writes.isEmpty)
    }

    /// "Plan my month": new and edited nights are written, nights that were planned before
    /// and have since been skipped are cleared, and every grocery week touched either way
    /// is rebuilt. A night that already existed and wasn't edited is deliberately left
    /// alone — its shopping is already on the list, and rewriting it is pointless traffic.
    static func month(
        suggestions: [WaffledAPI.PlanCardDTO],
        plannedDates: Set<String>,
        dirty: Set<String>,
        skipped: Set<String>,
        firstDay: HouseholdWeekStart?
    ) -> [Op] {
        var ops: [Op] = []
        var touched: [String] = []
        for card in suggestions where !plannedDates.contains(card.date) || dirty.contains(card.date) {
            ops.append(setOp(card))
            touched.append(card.date)
        }
        for date in skipped.sorted() where plannedDates.contains(date) {
            ops.append(.clear(date: date, mealType: "dinner"))
            // A cleared night's shopping has to come back OFF the list, so its week is
            // every bit as "touched" as one that gained a dinner.
            touched.append(date)
        }
        return ops + rebuildOps(for: touched, firstDay: firstDay, whenEmpty: ops.isEmpty)
    }

    private static func setOp(_ card: WaffledAPI.PlanCardDTO) -> Op {
        .set(date: card.date, mealType: card.mealType,
             recipeId: card.recipeId,
             title: card.recipeId == nil ? card.title : nil)
    }

    /// Rebuilds always come after every write. Not cosmetic: a rebuild reads the plan back
    /// off the server, so one issued before its night is written builds the list from the
    /// plan as it was.
    private static func rebuildOps(for dates: [String], firstDay: HouseholdWeekStart?, whenEmpty: Bool) -> [Op] {
        // An apply that wrote nothing rebuilds nothing — a stray rebuild of the current
        // week would un-tick a shopper's list for no reason at all.
        guard !whenEmpty else { return [] }
        return GroceryWeeks.weekStarts(dates, firstDay: firstDay).map { .rebuild(weekStart: $0) }
    }
}
