package app.waffled.feature.recipes

import androidx.compose.runtime.Immutable

/**
 * The Meal Builder's role scaffolding and drop resolution — the Kotlin port of the
 * `PlateRole` / `PlateRoles` / `PlateReorder` / `OnHandClaim` half of
 * `apps/ios/.../Features/Meals/MealBuilderModel.swift`.
 *
 * A "plate" is a named, multi-recipe meal ("BBQ Sunday" = BBQ Chicken (main) + Potato
 * Salad + Coleslaw (sides) + Peach Cobbler (dessert)).
 */

/**
 * One role group on the plate. [key] is free text server-side — these are the three the
 * builder scaffolds, in plate order.
 */
@Immutable
data class PlateRole(
    val key: String,
    val label: String,
    /** The label on the group's trailing "＋". */
    val addLabel: String,
)

/** A role plus the dishes filed under it, in plate order. */
@Immutable
data class PlateGroup(val role: PlateRole, val dishes: List<MealDishDTO>)

object PlateRoles {
    val main = PlateRole("main", "Main", "Add a main")
    val side = PlateRole("side", "Sides", "Add a side")
    val dessert = PlateRole("dessert", "Dessert", "Add a dessert")
    val ordered: List<PlateRole> = listOf(main, side, dessert)

    /**
     * The dishes filed under one role, in plate order.
     *
     * Sides is the **catch-all**: roles are free text, so a plate could carry a 'bread' or
     * 'appetizer' dish the builder doesn't scaffold. Matching Sides strictly would leave
     * that dish on the plate but rendered nowhere (the web groups it the same way).
     */
    fun dishes(all: List<MealDishDTO>, role: PlateRole): List<MealDishDTO> =
        all.filter { d ->
            if (role.key == side.key) d.role != main.key && d.role != dessert.key
            else d.role == role.key
        }.sortedBy { it.sortOrder }

    /**
     * Every scaffold group, **including the empty ones** — an empty group's "＋ Add a
     * main" slot is the only way to add a main, so hiding it removes the affordance.
     */
    fun groups(all: List<MealDishDTO>): List<PlateGroup> =
        ordered.map { PlateGroup(it, dishes(all, it)) }

    fun label(role: String): String = ordered.firstOrNull { it.key == role }?.label ?: side.label
}

/**
 * Re-filing a dish from one role to another.
 *
 * **Compose has no `.onMove`.** There is no androidx reorder-by-drag API for
 * `LazyColumn`, and hand-rolling one is the subproject that burned iOS twice — so, as
 * `feature:lists` did with `ListReorder`, the *gesture* is not ported but the *rule* is,
 * and it is what the row's "Move to…" menu writes (see [MealBuilderModel.apply]). The day
 * a reorder API lands, the behaviour it needs already exists and is locked, case for
 * case, by the iOS suite.
 *
 * The trap the flat run exists to close: the ＋ rows are NOT draggable but they still
 * occupy an index. Resolve a move against an array that leaves them out and every index
 * below one is off by one, landing the wrong dish in the wrong role — silently.
 */
object PlateReorder {

    /**
     * One row of the flat run, in render order.
     *
     * **This is the single definition of that order** — the view renders from it and a
     * drop is resolved against it, so the two cannot drift. On iOS they were once built
     * independently, which is exactly how an off-by-one landed a dish in the wrong role
     * with nothing on screen to say so.
     */
    sealed interface Row {
        data class Header(val role: String) : Row

        /** A dish, or one of the synthetic `add:` / `empty:` slots. */
        data class Item(val id: String, val section: String) : Row
    }

    /** What a drop should write: the dish that moved, its new role, and the plate order. */
    data class Move(
        val id: String,
        val role: PlateRole,
        /** Every dish on the plate, in its new order — what `reorderDishes` writes. */
        val order: List<String>,
    )

    /**
     * Whether empty roles should show their "drag a dish here" slot at all.
     *
     * Only once the plate holds a dish somewhere. On a brand-new plate every role is
     * empty, so the slots would invite a drag with nothing anywhere to drag — three rows
     * telling you to do something impossible.
     */
    fun showsEmptySlots(groups: List<PlateGroup>): Boolean = groups.any { it.dishes.isNotEmpty() }

    /** The flat run: header, that role's dishes, an empty-role drop slot, then the ＋. */
    fun rows(groups: List<PlateGroup>): List<Row> {
        val draggable = showsEmptySlots(groups)
        val out = mutableListOf<Row>()
        for (g in groups) {
            out += Row.Header(g.role.key)
            for (d in g.dishes) out += Row.Item(d.recipeId, g.role.key)
            if (g.dishes.isEmpty() && draggable) out += Row.Item("empty:${g.role.key}", g.role.key)
            out += Row.Item("add:${g.role.key}", g.role.key)
        }
        return out
    }

    /**
     * Resolve a drop of [from] onto index [to] over the flat run.
     *
     * The order matters as much as the role: `sort_order` is plate-wide and each role
     * renders by sorting on it, so a dish that changes role while keeping its old number
     * lands wherever that number happens to fall — drop it at the TOP of Sides and it
     * appears at the bottom. Writing the full order is also what makes a reorder *within*
     * a role mean anything.
     *
     * null ⇒ write nothing: a ＋ / placeholder row moved, the drop landed above the first
     * header, or the dish ended up in the same role at the same position.
     */
    fun move(groups: List<PlateGroup>, from: Set<Int>, to: Int): Move? {
        val rows = rows(groups)
        val src = from.minOrNull() ?: return null
        if (src !in rows.indices) return null
        val moved = rows[src] as? Row.Item ?: return null
        if (isSynthetic(moved.id)) return null

        // Replay the move on a copy — same semantics a list widget's reorder would use,
        // kept here so the rule is pure and testable without a running app.
        val ordered = from.filter { it in rows.indices }.sorted()
        val moving = ordered.map { rows[it] }
        val arr = rows.toMutableList()
        for (i in ordered.reversed()) arr.removeAt(i)
        val removedBefore = ordered.count { it < to }
        arr.addAll((to - removedBefore).coerceIn(0, arr.size), moving)

        // Walk the result: each dish belongs to the nearest header above it.
        var section: String? = null
        var landedIn: String? = null
        val order = mutableListOf<String>()
        for (row in arr) {
            when (row) {
                is Row.Header -> section = row.role
                is Row.Item -> {
                    if (isSynthetic(row.id)) continue
                    order += row.id
                    if (row.id == moved.id) landedIn = section
                }
            }
        }

        val key = landedIn ?: return null
        val role = PlateRoles.ordered.firstOrNull { it.key == key } ?: return null
        // Same role, same place — nothing to say.
        if (key == moved.section && order == groups.flatMap { g -> g.dishes.map { it.recipeId } }) {
            return null
        }
        return Move(moved.id, role, order)
    }

    /** The header / ＋ / placeholder rows carry ids that aren't dishes. */
    private fun isSynthetic(id: String) = id.startsWith("add:") || id.startsWith("empty:")
}

/**
 * What a dish (or a whole plate) may honestly say about the pantry.
 *
 * [OnHandCount] is null whenever the pantry module is off, and that means "we can't say" —
 * not "you have none of these". Three outcomes, and the middle one is the trap: with the
 * pantry off and nothing left to buy there is simply nothing to render. A "0 of N" badge
 * or a "✓ all on hand" tick would both be claims the server never made.
 */
sealed interface OnHandClaim {
    data object NothingToSay : OnHandClaim
    data object AllOnHand : OnHandClaim
    data class ToBuy(val count: Int) : OnHandClaim

    companion object {
        fun of(onHand: OnHandCount?, toBuy: Int): OnHandClaim = when {
            toBuy > 0 -> ToBuy(toBuy)
            onHand == null -> NothingToSay
            else -> AllOnHand
        }
    }
}
