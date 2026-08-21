package app.waffled.feature.recipes

import androidx.compose.runtime.Immutable

/**
 * The unified library: every recipe in the household **and every saved plate**, merged,
 * filtered and sorted client-side — the Kotlin port of
 * `apps/ios/.../Features/Meals/MealLibrary.swift`.
 *
 * The server returns the whole library with no server-side search, so all of this happens
 * here (mirroring the web kiosk). Keeping it out of the view is what makes the rules
 * below testable, and what keeps the search field responsive: [haystacks] is built **once
 * per data load**, not per keystroke.
 */

/** One row in the unified library — a recipe or a saved plate. */
@Immutable
sealed interface LibraryEntry {
    val id: String
    val title: String

    /** Hands-on + cooking. For a plate this is the sum across its dishes. */
    val totalMinutes: Int?

    /**
     * Cook history is recipe-only; a plate has none, which is why the history sorts put
     * plates last rather than floating them to the top on a tie.
     */
    val cookedCount: Int
    val lastCookedAt: String?

    @Immutable
    data class Recipe(val recipe: RecipeSummary) : LibraryEntry {
        override val id get() = recipe.id
        override val title get() = recipe.title
        override val totalMinutes get() = recipe.totalTimeMinutes
        override val cookedCount get() = recipe.cookedCount
        override val lastCookedAt get() = recipe.lastCookedAt
    }

    @Immutable
    data class Meal(val meal: MealDTO) : LibraryEntry {
        override val id get() = meal.id
        override val title get() = meal.name
        override val totalMinutes get() = meal.totalMinutes
        override val cookedCount get() = 0
        override val lastCookedAt: String? get() = null
    }
}

enum class RecipeSort(val label: String) {
    AZ("A–Z"),
    Quickest("Quickest"),
    MostCooked("Most cooked"),
    Recent("Recently cooked"),
}

/**
 * Recipes / plates / both.
 *
 * The **type** filter is the only thing that can select plates: they carry no cuisine,
 * protein or dietary metadata, so a facet-shaped "Meals" filter would filter itself out.
 */
enum class LibraryType(val label: String, val chip: String) {
    All("All", "All"),
    Recipes("Recipes", "📖 Recipes"),
    Meals("Meals", "🍽️ Meals"),
}

/** Everything the library screen filters and sorts by, in one value. */
@Immutable
data class LibraryFilters(
    val query: String = "",
    val type: LibraryType = LibraryType.All,
    val onlyFavorites: Boolean = false,
    val onlyNew: Boolean = false,
    val cuisine: Set<String> = emptySet(),
    val protein: Set<String> = emptySet(),
    val dietary: Set<String> = emptySet(),
    val sort: RecipeSort = RecipeSort.AZ,
) {
    /** The recipe-metadata filters. Any of these on ⇒ no plate can match. */
    val anyStructured: Boolean
        get() = onlyFavorites || onlyNew || cuisine.isNotEmpty() || protein.isNotEmpty() || dietary.isNotEmpty()

    val any: Boolean get() = anyStructured || type != LibraryType.All
}

object LibraryFilter {

    /** All the recipe text the search box matches against (mirrors the kiosk haystack). */
    fun haystack(r: RecipeSummary): String =
        (
            listOfNotNull(r.title, r.cuisine, r.protein, r.base, r.mealType, r.effort, r.cookMethod, r.collection) +
                r.tags.orEmpty() + r.vegetables.orEmpty() + r.dietary.orEmpty()
            ).joinToString(" ").lowercase()

    /**
     * A plate matches on its own name **and on every dish title** — searching "chicken"
     * has to find "BBQ Sunday", whose name contains no such word.
     */
    fun haystack(m: MealDTO): String =
        (listOf(m.name) + m.recipes.mapNotNull { it.title }).joinToString(" ").lowercase()

    /**
     * Precomputed once per data load. Rebuilding these per keystroke is the search-field
     * jank trap this app has hit before, on both other platforms.
     */
    fun haystacks(recipes: List<RecipeSummary>, meals: List<MealDTO>): Map<String, String> =
        buildMap(recipes.size + meals.size) {
            for (r in recipes) put(r.id, haystack(r))
            for (m in meals) put(m.id, haystack(m))
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
                if (q.isNotEmpty() && haystacks[r.id]?.contains(q) != true) continue
                if (filters.cuisine.isNotEmpty() && r.cuisine !in filters.cuisine) continue
                if (filters.protein.isNotEmpty() && r.protein !in filters.protein) continue
                if (filters.dietary.isNotEmpty() && r.dietary.orEmpty().none { it in filters.dietary }) continue
                out += LibraryEntry.Recipe(r)
            }
        }

        // Plates carry no cuisine / protein / dietary / cook-history metadata, so any
        // structured facet legitimately drops all of them. That is exactly why the control
        // that *selects* plates is a type filter and not another facet.
        if (filters.type != LibraryType.Recipes && !filters.anyStructured) {
            for (m in meals) {
                if (q.isNotEmpty() && haystacks[m.id]?.contains(q) != true) continue
                out += LibraryEntry.Meal(m)
            }
        }

        return out.sortedWith(comparator(filters.sort))
    }

    private fun comparator(sort: RecipeSort): Comparator<LibraryEntry> = when (sort) {
        RecipeSort.AZ -> compareBy(String.CASE_INSENSITIVE_ORDER) { it.title }
        RecipeSort.Quickest -> compareBy { it.totalMinutes ?: Int.MAX_VALUE }
        RecipeSort.MostCooked -> compareByDescending { it.cookedCount }
        RecipeSort.Recent -> compareByDescending { it.lastCookedAt.orEmpty() }
    }
}
