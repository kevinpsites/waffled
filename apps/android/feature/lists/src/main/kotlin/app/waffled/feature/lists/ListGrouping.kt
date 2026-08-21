package app.waffled.feature.lists

import androidx.compose.runtime.Immutable

/**
 * A run of list items under one section header — an aisle for grocery, a category like
 * "Clothes" / "Gear" for any other list. [title] is null for the ungrouped run.
 */
@Immutable
data class ListSectionGroup(
    val title: String?,
    val items: List<ListItemDTO>,
    /**
     * The category value to PERSIST for items in this group (null = no category).
     *
     * This differs from [title] only for the ungrouped fallback: its header reads "Items"
     * for display, but its real category is null — so moving an item into it must write
     * null, not a literal "Items" section (which would split off a duplicate "ITEMS"
     * group with a colliding id, the bug the drag-and-drop first shipped).
     */
    val sectionValue: String? = title,
) {
    /**
     * Identity keys off the real category, NOT the display title, so a user-named "Items"
     * section and the ungrouped "Items" fallback don't collide.
     */
    val id: String get() = sectionValue ?: UNGROUPED_ID

    companion object {
        const val UNGROUPED_ID = "__ungrouped__"
    }
}

/**
 * Section grouping in a *stable* order, independent of item order — so editing one item's
 * section never reshuffles the headers.
 *
 * Port of `apps/ios/.../Lists/ListGrouping.swift`.
 */
object ListGrouping {

    /**
     * Sections in preferred-then-alphabetical order.
     *
     * Sections named in [preferredOrder] come first, in that order (grocery aisles in
     * shopping order); the rest follow alphabetically, case-insensitively. Ungrouped
     * items fall into a trailing "Items" group — unless nothing has a section at all, in
     * which case there is a single header-less group. Item order within a section is
     * preserved.
     */
    fun sections(items: List<ListItemDTO>, preferredOrder: List<String> = emptyList()): List<ListSectionGroup> {
        // A control-character prefix, so a user-named "Items" section cannot collide with
        // the ungrouped bucket's key. (Its DISPLAY title is still a plain "Items".)
        val ungroupedKey = "\u0001Items"
        val buckets = LinkedHashMap<String, MutableList<ListItemDTO>>()
        for (item in items) {
            val key = item.section?.takeIf { it.isNotEmpty() } ?: ungroupedKey
            buckets.getOrPut(key) { mutableListOf() }.add(item)
        }

        val realKeys = buckets.keys.filter { it != ungroupedKey }
        if (realKeys.isEmpty()) {
            return if (items.isEmpty()) emptyList()
            else listOf(ListSectionGroup(title = null, items = items))
        }

        val lowerOrder = preferredOrder.map { it.lowercase() }
        fun rank(key: String): Int = lowerOrder.indexOf(key.lowercase())
        val preferred = realKeys.filter { rank(it) >= 0 }.sortedBy { rank(it) }
        val others = realKeys.filter { rank(it) < 0 }
            .sortedWith { a, b -> a.compareTo(b, ignoreCase = true) }

        val ordered = buildList {
            addAll(preferred)
            addAll(others)
            if (buckets.containsKey(ungroupedKey)) add(ungroupedKey)
        }

        return ordered.map { key ->
            val ungrouped = key == ungroupedKey
            // Ungrouped items show under an "Items" header but carry NO real category, so
            // sectionValue is null — moving one in clears the category instead of minting
            // a literal "Items" section.
            ListSectionGroup(
                title = if (ungrouped) "Items" else key,
                items = buckets[key].orEmpty(),
                sectionValue = if (ungrouped) null else key,
            )
        }
    }
}

/** "By store" grouping for the grocery board. */
object StoreGrouping {

    /** The header for rows with no store assigned. */
    const val NO_STORE = "No store"

    /**
     * Each active item under its assigned store (alphabetical), with unassigned items in
     * a trailing "No store" group.
     *
     * Folds on case, because the store box is free text and only NEW writes are snapped:
     * a row saved earlier can hold "costco" next to a newer "Costco", and the header is
     * uppercased for display, so both would render as a section headed "COSTCO". The
     * first spelling seen wins the label. Mirrors `storeSections` in the web GroceryBoard.
     */
    fun sections(items: List<ListItemDTO>): List<ListSectionGroup> {
        val buckets = LinkedHashMap<String, Pair<String, MutableList<ListItemDTO>>>()
        val none = mutableListOf<ListItemDTO>()
        for (item in items) {
            val store = item.store?.trim().orEmpty()
            if (store.isEmpty()) {
                none.add(item)
                continue
            }
            val entry = buckets.getOrPut(store.lowercase()) { store to mutableListOf() }
            entry.second.add(item)
        }
        val groups = buckets.values
            .sortedWith { a, b -> a.first.compareTo(b.first, ignoreCase = true) }
            .map { (label, rows) -> ListSectionGroup(title = label, items = rows, sectionValue = label) }
            .toMutableList()
        if (none.isNotEmpty()) {
            groups.add(ListSectionGroup(title = NO_STORE, items = none, sectionValue = null))
        }
        return groups
    }
}

/**
 * A run of items under one meal in "By meal" mode.
 *
 * [unscheduled] set = a recipe on the list but not on this week's plan; [unscheduledMeal]
 * set = a plate in the same position; all three null = the trailing "Staples & extras"
 * group.
 */
@Immutable
data class MealGroup(
    val meal: GroceryBoardDTO.Meal? = null,
    val items: List<ListItemDTO> = emptyList(),
    val unscheduled: GroceryBoardDTO.UnscheduledRecipe? = null,
    val unscheduledMeal: GroceryBoardDTO.UnscheduledMeal? = null,
) {
    val id: String
        get() = meal?.id
            ?: unscheduled?.let { "unscheduled|${it.recipeId}" }
            ?: unscheduledMeal?.let { "unscheduledMeal|${it.mealId}" }
            ?: "__extras__"

    /**
     * A plate that earned a heading but has no rows of its own — everything it wants was
     * already claimed by an earlier meal. It says so rather than duplicating the rows:
     * one item, one checkbox.
     */
    val isFullyCovered: Boolean
        get() = items.isEmpty() && (meal?.mealId != null || unscheduledMeal != null)
}

/** "By meal" grouping. Port of the iOS `MealGrouping`. */
object MealGrouping {

    /**
     * Group items under the first meal (by date) whose recipe needs them, then give each
     * unscheduled plate and each unscheduled recipe its own group; anything left falls
     * into a trailing "Staples & extras" group. Each item appears **once** — planned
     * meals claim shared items first.
     */
    fun sections(
        items: List<ListItemDTO>,
        meals: List<GroceryBoardDTO.Meal>,
        unscheduled: List<GroceryBoardDTO.UnscheduledRecipe> = emptyList(),
        unscheduledMeals: List<GroceryBoardDTO.UnscheduledMeal> = emptyList(),
    ): List<MealGroup> {
        val groups = mutableListOf<MealGroup>()
        val used = mutableSetOf<String>()

        for (m in meals.sortedBy { it.date }) {
            // A slot backed by a Meal Builder plate has NO recipeId — its items are tagged
            // with its DISHES' ids. Matching on recipeId alone dropped the whole plate
            // from this view, so an added plate looked un-added.
            val ids = m.contributingRecipeIds.toSet()
            if (ids.isEmpty()) continue
            val its = items.filter { it.id !in used && it.sourceRecipeIds.orEmpty().any { r -> r in ids } }
            // A plate keeps its heading even when every item it wants was already claimed
            // above; a plain recipe with nothing left still drops out.
            if (its.isEmpty() && m.mealId == null) continue
            its.forEach { used.add(it.id) }
            groups.add(MealGroup(meal = m, items = its))
        }

        for (um in unscheduledMeals) {
            val ids = um.contributingRecipeIds.toSet()
            val its = items.filter { it.id !in used && it.sourceRecipeIds.orEmpty().any { r -> r in ids } }
            its.forEach { used.add(it.id) }
            groups.add(MealGroup(items = its, unscheduledMeal = um))
        }

        for (u in unscheduled) {
            val its = items.filter { it.id !in used && u.recipeId in it.sourceRecipeIds.orEmpty() }
            if (its.isEmpty()) continue
            its.forEach { used.add(it.id) }
            groups.add(MealGroup(items = its, unscheduled = u))
        }

        val extras = items.filter { it.id !in used }
        if (extras.isNotEmpty()) groups.add(MealGroup(items = extras))
        return groups
    }
}

/** The per-item provenance dots on a grocery row. */
object MealDots {

    /**
     * One colour per **source** that wants this item — a plate, a planned recipe, or an
     * off-plan recipe.
     *
     * Deduping by recipe id would be wrong now that plates exist: two dishes of the same
     * plate both wanting mayonnaise is ONE plate asking for it, and would otherwise draw
     * the same colour twice. (A recipe planned into two slots is likewise one dot.)
     */
    fun colors(
        item: ListItemDTO,
        meals: List<GroceryBoardDTO.Meal>,
        unscheduledMeals: List<GroceryBoardDTO.UnscheduledMeal>,
        unscheduled: List<GroceryBoardDTO.UnscheduledRecipe>,
    ): List<String> {
        val ids = item.sourceRecipeIds.orEmpty().toSet()
        if (ids.isEmpty()) return emptyList()
        val seen = mutableSetOf<String>()
        val colors = mutableListOf<String>()
        for (m in meals) {
            if (m.contributingRecipeIds.none { it in ids }) continue
            val key = m.mealId ?: m.recipeId ?: m.id
            if (seen.add(key)) colors.add(m.color)
        }
        for (p in unscheduledMeals) {
            if (p.contributingRecipeIds.none { it in ids }) continue
            if (seen.add(p.mealId)) colors.add(p.color)
        }
        for (u in unscheduled) {
            if (u.recipeId !in ids) continue
            if (seen.add(u.recipeId)) colors.add(u.color)
        }
        return colors
    }
}
