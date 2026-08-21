package app.waffled.feature.lists

import kotlinx.serialization.Serializable

/**
 * The wire shapes of the Lists / grocery-board / pantry-staples slice — the Kotlin port
 * of the `ListSummary` / `ListItemDTO` / `GroceryBoardDTO` types in
 * `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Kept beside [ListsApi] rather than inside it so the pure logic (grouping, share text,
 * reorder) can be tested without touching the HTTP layer at all.
 *
 * Everything optional has a default. `WaffledJson` sets `ignoreUnknownKeys`, but a
 * MISSING key still fails a non-nullable property without one — and the server sends
 * genuinely different shapes from different routes (see [ListSummary.itemCount] and
 * [ListItemDTO.pantry]).
 */

/**
 * A list in the household's index (Grocery, packing lists, templates…).
 *
 * Two server shapes decode into this: the index endpoints (`GET /api/lists`,
 * `GET /api/lists/templates`) attach a live [itemCount], but every *mutate* reply
 * (create, apply-template, save-as-/unmark-template, PATCH rename) is bare
 * `presentList(...)` JSON **without** it. A required [itemCount] therefore threw on every
 * mutate, which silently turned "create a list then open it" into a no-op. The 0 default
 * is honest for a just-created list and cosmetic elsewhere — callers either reload the
 * counted index or open the detail, which loads real items.
 */
@Serializable
data class ListSummary(
    val id: String,
    val name: String,
    val emoji: String? = null,
    val listType: String,
    val itemCount: Int = 0,
) {
    val isGrocery: Boolean get() = listType.lowercase() == "grocery"
    val isTemplate: Boolean get() = listType.lowercase() == "template"
}

/**
 * One row in a list detail — section (aisle for grocery), quantity, store, assignee.
 *
 * The grocery *board* endpoint also fills [aisle], [sourceRecipeIds] and [pantry]; the
 * plain list endpoint leaves them absent.
 */
@Serializable
data class ListItemDTO(
    val id: String,
    val name: String = "",
    val quantity: String? = null,
    /**
     * [quantity] with fraction glyphs spelled out ("1 1/2 lb" for a displayed "1½ lb").
     * Seed edit fields from this — ½ can be read but not typed.
     */
    val quantityInput: String? = null,
    val checked: Boolean = false,
    val section: String? = null,
    /** Free-text store/vendor (Costco, Walmart, …); null = unassigned. */
    val store: String? = null,
    /** 1–5 urgency (1 = not urgent, 3 = normal/default, 5 = urgent). */
    val priority: Int? = null,
    val assignee: Assignee? = null,
    val aisle: String? = null,
    val sourceRecipeIds: List<String>? = null,
    /** The week this row belongs to; null = a global, hand-typed row. */
    val weekStart: String? = null,
    /**
     * How the row got here. The SERVER owns the wipe/promote rules and the client never
     * applies them itself — but it must not lose the field, because it is the difference
     * between derived and authored data:
     *
     *  - `auto`   — derived from the week's planned meals. A grocery **rebuild wipes and
     *               recomputes these**, so nothing a person typed may ever be one.
     *  - `recipe` — an explicit off-plan add ("add this recipe's ingredients"). A rebuild
     *               **never touches these**, and an `auto` row that gains an off-plan
     *               stake is *promoted* to `recipe` on merge so the rebuild stops
     *               owning it.
     *  - `manual` — hand-typed. Global (no [weekStart]) and likewise never rebuilt.
     *
     * Getting the first two backwards destroys user data, which is why they are written
     * down here rather than left implicit. See `apps/api/src/modules/lists/lists.service.ts`.
     */
    val source: String? = null,
    /**
     * The pantry item covering this row, matched at read time by the grocery **board**
     * endpoint only. Optional because the plain items route never sends the key, and a
     * strict decode that throws on a key one endpoint omits surfaces as a bogus
     * "couldn't reach server" — an optional badge taking the whole list offline.
     *
     * **null means "we don't know"**, not "you have none": it is also what a household
     * with the pantry module off gets. The match is presence-only and never compares
     * quantities, so this FLAGS a row, it never filters one.
     */
    val pantry: PantryHit? = null,
) {
    @Serializable
    data class PantryHit(
        /** The pantry item's own name — matching is fuzzy, so it can differ from the row's. */
        val name: String,
        /** Free text off the pantry row ("2", "half", "bag") — display only, never arithmetic. */
        val amount: String? = null,
        val unit: String? = null,
    )

    @Serializable
    data class Assignee(
        /**
         * The assigned person's id. iOS drops this and has to re-resolve the assignee by
         * NAME, which two same-named members would get wrong; the server sends it, so the
         * detail editor here preselects by id.
         */
        val personId: String? = null,
        val name: String? = null,
        val avatarEmoji: String? = null,
        val colorHex: String? = null,
    )

    /**
     * What an edit field is seeded with.
     *
     * Anything asking "did the user change this?" must compare against THIS, not
     * [quantity]: the box holds "1 1/2 lb" while the row holds "1½ lb", so comparing the
     * two makes merely focusing a row and tapping away look like an edit — and save.
     */
    val editableQuantity: String get() = quantityInput ?: quantity ?: ""
}

/**
 * The grocery board: items tagged with aisle + the meals that need them, this week's
 * meals (each with the colour used for the per-item dots), and the pantry staples.
 */
@Serializable
data class GroceryBoardDTO(
    val weekStart: String = "",
    val meals: List<Meal> = emptyList(),
    /** Recipes on the list but not planned this week (added straight from a recipe page). */
    val unscheduled: List<UnscheduledRecipe> = emptyList(),
    /** Plates put on the list WITHOUT being scheduled ("Add plate to list"). */
    val unscheduledMeals: List<UnscheduledMeal> = emptyList(),
    val items: List<ListItemDTO> = emptyList(),
    val staples: List<Staple> = emptyList(),
) {
    @Serializable
    data class Meal(
        val recipeId: String? = null,
        /**
         * Set when this slot holds a Meal Builder plate. A plate-backed slot has NO
         * [recipeId] — grouping the board by meal must key off the plate, or the whole
         * plate silently vanishes from the by-meal view.
         */
        val mealId: String? = null,
        val title: String? = null,
        val emoji: String? = null,
        val color: String = "",
        val date: String = "",
        val mealType: String? = null,
        /** The plate's dishes; empty for an ordinary single-recipe slot. */
        val recipes: List<Dish> = emptyList(),
    ) {
        val id: String get() = (mealId ?: recipeId ?: "") + "|" + date + "|" + (mealType ?: "")

        /**
         * Every recipe whose ingredients this row accounts for: the plate's dishes, or
         * the single recipe. This — not [recipeId] — is what a row's
         * [ListItemDTO.sourceRecipeIds] must be matched against, because a plate's items
         * are tagged with its DISHES' ids, never with the plate's own.
         */
        val contributingRecipeIds: List<String>
            get() = if (recipes.isNotEmpty()) recipes.map { it.recipeId } else listOfNotNull(recipeId)

        @Serializable
        data class Dish(
            val recipeId: String,
            val title: String? = null,
            val emoji: String? = null,
            val role: String = "",
        )
    }

    /** A plate whose shopping is on the list but which isn't planned this week. */
    @Serializable
    data class UnscheduledMeal(
        val mealId: String,
        val name: String = "",
        val color: String = "",
        val recipes: List<Meal.Dish> = emptyList(),
    ) {
        val contributingRecipeIds: List<String> get() = recipes.map { it.recipeId }
    }

    @Serializable
    data class UnscheduledRecipe(
        val recipeId: String,
        val title: String = "",
        val emoji: String? = null,
        val color: String = "",
    )

    @Serializable
    data class Staple(val id: String, val name: String)
}
