package app.waffled.feature.recipes

/**
 * The opening state and copy for the recipe → "Add to grocery list" picker — the Kotlin
 * port of `apps/ios/.../Features/Meals/RecipeGroceryPick.swift`.
 *
 * Pulled out of the sheet so the rule is testable, because getting it wrong is quiet: the
 * sheet used to open with EVERYTHING checked, which meant re-buying whatever the pantry
 * already held.
 *
 * The distinction this file exists to protect:
 *
 *  - [RecipeIngredientDTO.inPantry] — the server matched the ingredient against the
 *    household's actual pantry inventory. An **observation**. Pre-uncheck it.
 *  - [RecipeIngredientDTO.isStaple] — the household is assumed to keep this around. An
 *    **assumption**, not an observation. It stays CHECKED and keeps only its muted
 *    "likely on hand" hint, because an item missing at the shop costs more than an extra
 *    one to uncheck. Reversing that default while implementing the pantry one would
 *    silently drop things nobody said they had.
 *
 * Mirrors the web's `RecipeGroceryModal`.
 */
object RecipeGroceryPick {

    /**
     * Whether the "Add to grocery list" action can do anything yet.
     *
     * The sheet derives its entire state from the ingredients, and the recipe detail's
     * menu is live from the first frame — before the detail fetch has returned. Tapping it
     * in that gap opened a sheet with no rows and a dead button. The action is disabled
     * instead: a greyed row says "not yet", where an empty sheet says "this recipe has no
     * ingredients", which is a lie.
     *
     * Deliberately keyed on the ingredients rather than a loading flag — a recipe that
     * really has none has nothing to add either, and there the same disabled row is the
     * honest answer. A pantry covering the whole recipe is NOT this case: those rows
     * exist, each says why it opens unchecked, and "Select all" is there to overrule us.
     */
    fun canAdd(ingredients: List<RecipeIngredientDTO>): Boolean = ingredients.isNotEmpty()

    /**
     * Which ingredients open checked: everything the pantry did NOT match. `null` (a
     * server that never sent the field) means "we don't know", which is not a reason to
     * leave something off the list — so it stays checked.
     */
    fun initialSelection(ingredients: List<RecipeIngredientDTO>): Set<String> =
        ingredients.filter { it.inPantry != true }.map { it.id }.toSet()

    /**
     * How many the pantry covered — the number the sheet has to own up to, so nothing
     * unchecks itself silently.
     */
    fun pantryCount(ingredients: List<RecipeIngredientDTO>): Int =
        ingredients.count { it.inPantry == true }

    /** The line under the title. */
    fun intro(pantryCount: Int): String {
        if (pantryCount <= 0) return "Uncheck anything you already have on hand."
        val item = if (pantryCount == 1) "item" else "items"
        return "We’ve already unchecked $pantryCount $item your pantry says you have."
    }

    /**
     * The commit button. Pre-unchecking can empty the selection outright when the pantry
     * covers the whole recipe; "Add 0 items" on a dead button explains nothing, so name
     * the state instead and leave "Select all" as the way out.
     */
    fun addLabel(count: Int): String =
        if (count == 0) "Nothing to add" else "Add $count ${if (count == 1) "item" else "items"}"

    /**
     * The one-line hint under an ingredient's name. There is room for exactly one, and the
     * real match outranks the assumed one: "in your pantry" is something we observed,
     * "likely on hand" only something we assumed.
     */
    enum class Hint(val label: String) {
        InPantry("in your pantry"),
        Staple("likely on hand"),
    }

    fun hint(ingredient: RecipeIngredientDTO): Hint? = when {
        ingredient.inPantry == true -> Hint.InPantry
        ingredient.isStaple -> Hint.Staple
        else -> null
    }
}
