package app.waffled.feature.meals

/**
 * The merge/filter/sort behind a unified recipe + saved-plate library.
 *
 * A saved plate is a first-class citizen of the recipe library: it sits in the same grid
 * as the recipes and the search box matches it. This file holds the rules so the library
 * stays a view and the rules can be pinned by tests.
 *
 * NOTE FOR THE INTEGRATOR: the library *screen* belongs to the recipes feature; this is
 * the shared rule set the planner's own pickers and that screen both need. If the recipes
 * module ends up with its own copy, delete one of them — do not let two drift.
 */

/** One row in the unified library — a recipe or a saved plate. */
sealed interface LibraryEntry {
    val id: String
    val title: String
    val isMeal: Boolean

    /** Hands-on + cooking. For a plate this is the sum across its dishes. */
    val totalMinutes: Int?

    /**
     * Cook history is recipe-only; a plate has none, which is why the history sorts put
     * plates last rather than floating them to the top on a tie.
     */
    val cookedCount: Int
    val lastCookedAt: String?

    data class Recipe(val recipe: RecipeSummary) : LibraryEntry {
        override val id get() = recipe.id
        override val title get() = recipe.title
        override val isMeal get() = false
        override val totalMinutes get() = recipe.totalTimeMinutes
        override val cookedCount get() = recipe.cookedCount
        override val lastCookedAt get() = recipe.lastCookedAt
    }

    data class Meal(val meal: MealDTO) : LibraryEntry {
        override val id get() = meal.id
        override val title get() = meal.name
        override val isMeal get() = true
        override val totalMinutes get() = meal.totalMinutes
        override val cookedCount get() = 0
        override val lastCookedAt: String? get() = null
    }
}

/**
 * Recipes / plates / both. The **type** filter is the only thing that can select plates:
 * they carry no cuisine, protein or dietary metadata, so a facet-shaped "Meals" filter
 * would filter itself out.
 */
enum class LibraryType(val label: String, val chip: String) {
    All("All", "All"),
    Recipes("Recipes", "📖 Recipes"),
    Meals("Meals", "🍽️ Meals"),
}

/** How the merged library is ordered. */
enum class RecipeSort(val label: String) {
    Az("A–Z"),
    Quickest("Quickest"),
    MostCooked("Most cooked"),
    Recent("Recently cooked"),
}

/** Everything the library filters and sorts by, in one value. */
data class LibraryFilters(
    val query: String = "",
    val type: LibraryType = LibraryType.All,
    val onlyFavorites: Boolean = false,
    val onlyNew: Boolean = false,
    val cuisine: Set<String> = emptySet(),
    val protein: Set<String> = emptySet(),
    val dietary: Set<String> = emptySet(),
    val sort: RecipeSort = RecipeSort.Az,
) {
    /** The recipe-metadata filters. Any of these on ⇒ no plate can match. */
    val anyStructured: Boolean
        get() = onlyFavorites || onlyNew || cuisine.isNotEmpty() || protein.isNotEmpty() || dietary.isNotEmpty()

    val any: Boolean get() = anyStructured || type != LibraryType.All
}

object LibraryFilter {

    /** All the recipe text the search box matches against. */
    fun haystack(r: RecipeSummary): String =
        (
            listOfNotNull(
                r.title, r.cuisine, r.protein, r.base, r.mealType,
                r.effort, r.cookMethod, r.collection,
            ) + r.tags.orEmpty() + r.vegetables.orEmpty() + r.dietary.orEmpty()
            ).joinToString(" ").lowercase()

    /**
     * A plate matches on its own name **and on every dish title** — searching "chicken"
     * has to find "BBQ Sunday", whose name contains no such word.
     */
    fun haystack(m: MealDTO): String =
        (listOf(m.name) + m.recipes.mapNotNull { it.title }).joinToString(" ").lowercase()

    /**
     * Precomputed once per data load. Rebuilding these per keystroke is the search-field
     * jank trap the app has hit before.
     */
    fun haystacks(recipes: List<RecipeSummary>, meals: List<MealDTO>): Map<String, String> {
        val out = HashMap<String, String>(recipes.size + meals.size)
        for (r in recipes) out[r.id] = haystack(r)
        for (m in meals) out[m.id] = haystack(m)
        return out
    }

    fun entries(
        recipes: List<RecipeSummary>,
        meals: List<MealDTO>,
        filters: LibraryFilters,
        haystacks: Map<String, String>,
    ): List<LibraryEntry> {
        val q = filters.query.trim().lowercase()
        val out = ArrayList<LibraryEntry>(recipes.size + meals.size)

        if (filters.type != LibraryType.Meals) {
            for (r in recipes) {
                if (filters.onlyFavorites && !r.isFavorite) continue
                if (filters.onlyNew && r.cookedCount != 0) continue
                if (q.isNotEmpty() && haystacks[r.id].orEmpty().contains(q).not()) continue
                if (filters.cuisine.isNotEmpty() && r.cuisine !in filters.cuisine) continue
                if (filters.protein.isNotEmpty() && r.protein !in filters.protein) continue
                if (filters.dietary.isNotEmpty() && r.dietary.orEmpty().none { it in filters.dietary }) continue
                out.add(LibraryEntry.Recipe(r))
            }
        }

        // Plates carry no cuisine / protein / dietary / cook-history metadata, so any
        // structured facet legitimately drops all of them. That is exactly why the control
        // that *selects* plates is a type filter and not another facet.
        if (filters.type != LibraryType.Recipes && !filters.anyStructured) {
            for (m in meals) {
                if (q.isNotEmpty() && haystacks[m.id].orEmpty().contains(q).not()) continue
                out.add(LibraryEntry.Meal(m))
            }
        }

        return out.sortedWith(comparator(filters.sort))
    }

    private fun comparator(sort: RecipeSort): Comparator<LibraryEntry> = when (sort) {
        RecipeSort.Az -> compareBy(String.CASE_INSENSITIVE_ORDER) { it.title }
        RecipeSort.Quickest -> compareBy { it.totalMinutes ?: Int.MAX_VALUE }
        RecipeSort.MostCooked -> compareByDescending { it.cookedCount }
        RecipeSort.Recent -> compareByDescending { it.lastCookedAt.orEmpty() }
    }
}
