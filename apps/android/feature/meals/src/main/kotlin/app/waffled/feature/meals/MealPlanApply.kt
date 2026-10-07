package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart

/**
 * Everything "Plan my week/month & build list" sends to the server, as an ordered value.
 *
 * The sheets used to decide this inline — write these nights, clear those, then derive
 * the grocery weeks from what was touched. That left the interesting half untestable: a
 * test could check [GroceryWeeks.weekStarts] on its own, but nothing said an apply
 * actually *issues* those rebuilds. A review proved the gap by reverting either sheet to
 * one `rebuildGrocery(weekStart = monthStart)` call — the original month bug — with every
 * test still green.
 *
 * So the decision is data and the sheets just execute it, the same shape
 * [MealPlanSwap.writes] already uses for a move.
 */
object MealPlanApply {

    sealed interface Op {
        /**
         * Upsert one night. [recipeId], [mealId] and [title] are mutually exclusive: a
         * card backed by a recipe sends the id, one backed by a saved plate sends the
         * plate id, and a free-text card sends the words.
         */
        data class Set(
            val date: String,
            val mealType: String,
            val recipeId: String? = null,
            val title: String? = null,
            val mealId: String? = null,
        ) : Op

        data class Clear(val date: String, val mealType: String) : Op

        data class Rebuild(val weekStart: String) : Op
    }

    /**
     * "Plan my week": every drafted night is written, then the grocery weeks those dates
     * fall in are rebuilt.
     */
    fun week(suggestions: List<PlanCardDTO>, firstDay: HouseholdWeekStart?): List<Op> {
        val writes = suggestions.map(::setOp)
        return writes + rebuildOps(suggestions.map { it.date }, firstDay, whenEmpty = writes.isEmpty())
    }

    /**
     * "Plan my month": new and edited nights are written, nights that were planned before
     * and have since been skipped are cleared, and every grocery week touched either way
     * is rebuilt.
     *
     * A night that already existed and wasn't edited is deliberately left alone — its
     * shopping is already on the list, and rewriting it is pointless traffic.
     */
    fun month(
        suggestions: List<PlanCardDTO>,
        plannedDates: kotlin.collections.Set<String>,
        dirty: kotlin.collections.Set<String>,
        skipped: kotlin.collections.Set<String>,
        firstDay: HouseholdWeekStart?,
    ): List<Op> {
        val ops = mutableListOf<Op>()
        val touched = mutableListOf<String>()
        for (card in suggestions) {
            if (card.date in plannedDates && card.date !in dirty) continue
            ops.add(setOp(card))
            touched.add(card.date)
        }
        for (date in skipped.sorted()) {
            if (date !in plannedDates) continue
            ops.add(Op.Clear(date = date, mealType = "dinner"))
            // A cleared night's shopping has to come back OFF the list, so its week is
            // every bit as "touched" as one that gained a dinner.
            touched.add(date)
        }
        return ops + rebuildOps(touched, firstDay, whenEmpty = ops.isEmpty())
    }

    /**
     * A card backed by a plate sends `mealId` and nothing else — rebuilding it from
     * `recipeId`/`title` alone drops the dishes and leaves the plate's name behind as
     * dead text.
     */
    private fun setOp(card: PlanCardDTO): Op.Set = when {
        card.mealId != null -> Op.Set(card.date, card.mealType, mealId = card.mealId)
        card.recipeId != null -> Op.Set(card.date, card.mealType, recipeId = card.recipeId)
        else -> Op.Set(card.date, card.mealType, title = card.title)
    }

    /**
     * Rebuilds always come after every write. Not cosmetic: a rebuild reads the plan back
     * off the server, so one issued before its night is written builds the list from the
     * plan as it was.
     */
    private fun rebuildOps(
        dates: List<String>,
        firstDay: HouseholdWeekStart?,
        whenEmpty: Boolean,
    ): List<Op> {
        // An apply that wrote nothing rebuilds nothing — a stray rebuild of the current
        // week would un-tick a shopper's list for no reason at all.
        if (whenEmpty) return emptyList()
        return GroceryWeeks.weekStarts(dates, firstDay).map { Op.Rebuild(it) }
    }
}
