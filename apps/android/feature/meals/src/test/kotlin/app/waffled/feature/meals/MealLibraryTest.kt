package app.waffled.feature.meals

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The merged recipe + saved-plate library — the port of
 * `apps/ios/Tests/MealLibraryTests.swift`.
 *
 * A saved plate is a first-class citizen of the recipe library: it sits in the same grid
 * as the recipes, carries a type badge, and the search box matches it.
 *
 * The subtlety that has to be encoded rather than assumed: plates carry NO cuisine,
 * protein or dietary metadata, so every structured facet legitimately excludes them. The
 * filter that *selects* plates therefore has to be a **type** filter — a facet would
 * filter itself out.
 */
class MealLibraryTest {

    private fun libRecipe(
        id: String,
        title: String,
        cuisine: String? = null,
        protein: String? = null,
        dietary: List<String>? = null,
        favorite: Boolean = false,
        cookedCount: Int = 0,
        minutes: Int? = null,
    ) = RecipeSummary(
        id = id, title = title, cookTimeMinutes = minutes, isFavorite = favorite,
        cookedCount = cookedCount, protein = protein, cuisine = cuisine, dietary = dietary,
    )

    private fun plateDish(recipeId: String, title: String, role: String) =
        MealDishDTO(recipeId = recipeId, title = title, role = role)

    private fun plateFixture(id: String, name: String, totalMinutes: Int, dishes: List<MealDishDTO>) =
        MealDTO(
            id = id, name = name, totalMinutes = totalMinutes,
            recipeCount = dishes.size, recipes = dishes,
        )

    private val recipes = listOf(
        libRecipe("r1", "Tacos", cuisine = "mexican", protein = "beef", minutes = 30),
        libRecipe("r2", "Miso Soup", cuisine = "japanese", dietary = listOf("vegetarian"), minutes = 15),
    )

    private val meals = listOf(
        plateFixture(
            "m1", "BBQ Sunday", 75,
            listOf(plateDish("r9", "BBQ Chicken", "main"), plateDish("r8", "Coleslaw", "side")),
        ),
        plateFixture("m2", "Taco Night", 25, listOf(plateDish("r1", "Tacos", "main"))),
    )

    private fun entries(f: LibraryFilters) =
        LibraryFilter.entries(recipes, meals, f, LibraryFilter.haystacks(recipes, meals))

    /** Unfiltered, plates and recipes share one list. */
    @Test
    fun `merges plates into the recipe library`() {
        assertEquals(setOf("r1", "r2", "m1", "m2"), entries(LibraryFilters()).map { it.id }.toSet())
    }

    /** The type badge is what tells a plate from a recipe on the card. */
    @Test
    fun `a plate is marked as a meal`() {
        val list = entries(LibraryFilters())
        assertTrue(list.first { it.id == "m1" }.isMeal)
        assertFalse(list.first { it.id == "r1" }.isMeal)
    }

    /**
     * Searching a DISH's title finds the plate that contains it — "chicken" must find
     * "BBQ Sunday", whose own name contains no such word.
     */
    @Test
    fun `search matches a plate by one of its dishes`() {
        assertEquals(listOf("m1"), entries(LibraryFilters(query = "chicken")).map { it.id })
    }

    @Test
    fun `search still matches a plate by its own name`() {
        assertEquals(listOf("m1"), entries(LibraryFilters(query = "bbq sunday")).map { it.id })
    }

    /** The type filter is the ONLY way to see just the plates. */
    @Test
    fun `the meals type filter selects only plates`() {
        assertEquals(
            setOf("m1", "m2"),
            entries(LibraryFilters(type = LibraryType.Meals)).map { it.id }.toSet(),
        )
    }

    @Test
    fun `the recipes type filter excludes plates`() {
        assertEquals(
            setOf("r1", "r2"),
            entries(LibraryFilters(type = LibraryType.Recipes)).map { it.id }.toSet(),
        )
    }

    /**
     * A structured facet legitimately drops every plate — plates have no cuisine, protein
     * or dietary metadata to match against. This is why the selector had to be a type
     * filter and not a facet.
     */
    @Test
    fun `a structured facet excludes every plate`() {
        assertEquals(listOf("r1"), entries(LibraryFilters(cuisine = setOf("mexican"))).map { it.id })

        val favorites = LibraryFilters(onlyFavorites = true)
        assertTrue(favorites.anyStructured)
        assertTrue(entries(favorites).isEmpty())
    }

    /** A-Z sorts the merged list by title, not recipes-then-plates. */
    @Test
    fun `sorts the merged list alphabetically`() {
        assertEquals(
            listOf("BBQ Sunday", "Miso Soup", "Taco Night", "Tacos"),
            entries(LibraryFilters(sort = RecipeSort.Az)).map { it.title },
        )
    }

    /** Quickest reads the plate's own total time (the sum across its dishes). */
    @Test
    fun `sorts plates by their total time`() {
        assertEquals(
            listOf("r2", "m2", "r1", "m1"),
            entries(LibraryFilters(sort = RecipeSort.Quickest)).map { it.id },
        )
    }

    /**
     * Cook history is recipe-only, so a "most cooked" sort must not float untracked plates
     * above recipes people actually cook.
     */
    @Test
    fun `cook history sorts plates last`() {
        val cooked = listOf(libRecipe("r1", "Tacos", cookedCount = 9))
        val list = LibraryFilter.entries(
            cooked, meals, LibraryFilters(sort = RecipeSort.MostCooked),
            LibraryFilter.haystacks(cooked, meals),
        )
        assertEquals("r1", list.first().id)
        assertTrue(list.drop(1).all { it.isMeal })
    }
}
