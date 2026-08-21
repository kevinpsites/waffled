package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A saved plate is a first-class citizen of the recipe library: it sits in the same grid
 * as the recipes, carries a type badge, and the search box matches it — the Kotlin port of
 * `apps/ios/Tests/MealLibraryTests.swift`.
 *
 * The subtlety that has to be encoded rather than assumed: plates carry NO cuisine,
 * protein or dietary metadata, so every structured facet legitimately excludes them. The
 * filter that *selects* plates therefore has to be a **type** filter — a facet would
 * filter itself out.
 */
class MealLibraryTest {

    private val recipes = listOf(
        libRecipe("r1", "Tacos", cuisine = "mexican", protein = "beef", minutes = 30),
        libRecipe("r2", "Miso Soup", cuisine = "japanese", dietary = listOf("vegetarian"), minutes = 15),
    )

    private val meals = listOf(
        plateFixture(
            "m1", name = "BBQ Sunday", totalMinutes = 75,
            dishes = listOf(
                plateDish("r9", "BBQ Chicken", role = "main"),
                plateDish("r8", "Coleslaw", role = "side"),
            ),
        ),
        plateFixture(
            "m2", name = "Taco Night", totalMinutes = 25,
            dishes = listOf(plateDish("r1", "Tacos", role = "main")),
        ),
    )

    private fun entries(f: LibraryFilters) = LibraryFilter.entries(
        recipes, meals, f, LibraryFilter.haystacks(recipes, meals),
    )

    /** Unfiltered, plates and recipes share one list. */
    @Test
    fun mergesPlatesIntoTheRecipeLibrary() {
        assertEquals(setOf("r1", "r2", "m1", "m2"), entries(LibraryFilters()).map { it.id }.toSet())
    }

    /** The type badge is what tells a plate from a recipe on the card. */
    @Test
    fun aPlateIsMarkedAsAMeal() {
        val list = entries(LibraryFilters())
        assertTrue(list.first { it.id == "m1" } is LibraryEntry.Meal)
        assertFalse(list.first { it.id == "r1" } is LibraryEntry.Meal)
    }

    /**
     * Searching a DISH's title finds the plate that contains it — "chicken" must find
     * "BBQ Sunday", whose own name contains no such word.
     */
    @Test
    fun searchMatchesAPlateByOneOfItsDishes() {
        assertEquals(listOf("m1"), entries(LibraryFilters(query = "chicken")).map { it.id })
    }

    @Test
    fun searchStillMatchesAPlateByItsOwnName() {
        assertEquals(listOf("m1"), entries(LibraryFilters(query = "bbq sunday")).map { it.id })
    }

    /** The recipe haystack reaches past the title into every facet the card shows. */
    @Test
    fun searchMatchesARecipesMetadataNotJustItsTitle() {
        assertEquals(listOf("r1"), entries(LibraryFilters(query = "mexican")).map { it.id })
        assertEquals(listOf("r2"), entries(LibraryFilters(query = "vegetarian")).map { it.id })
    }

    /** The type filter is the ONLY way to see just the plates. */
    @Test
    fun theMealsTypeFilterSelectsOnlyPlates() {
        assertEquals(
            setOf("m1", "m2"),
            entries(LibraryFilters(type = LibraryType.Meals)).map { it.id }.toSet(),
        )
    }

    @Test
    fun theRecipesTypeFilterExcludesPlates() {
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
    fun aStructuredFacetExcludesEveryPlate() {
        assertEquals(listOf("r1"), entries(LibraryFilters(cuisine = setOf("mexican"))).map { it.id })

        val g = LibraryFilters(onlyFavorites = true)
        assertTrue(g.anyStructured)
        assertTrue(entries(g).isEmpty())
    }

    @Test
    fun theNewFilterKeepsOnlyNeverCookedRecipes() {
        val cooked = listOf(libRecipe("r1", "Tacos", cookedCount = 3), libRecipe("r2", "Miso Soup"))
        val f = LibraryFilters(onlyNew = true)
        val list = LibraryFilter.entries(cooked, emptyList(), f, LibraryFilter.haystacks(cooked, emptyList()))
        assertEquals(listOf("r2"), list.map { it.id })
    }

    /** A–Z sorts the merged list by title, not recipes-then-plates. */
    @Test
    fun sortsTheMergedListAlphabetically() {
        assertEquals(
            listOf("BBQ Sunday", "Miso Soup", "Taco Night", "Tacos"),
            entries(LibraryFilters(sort = RecipeSort.AZ)).map { it.title },
        )
    }

    /** Quickest reads the plate's own `totalMinutes` (the sum across its dishes). */
    @Test
    fun sortsPlatesByTheirTotalTime() {
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
    fun cookHistorySortsPlatesLast() {
        val cooked = listOf(libRecipe("r1", "Tacos", cookedCount = 9))
        val list = LibraryFilter.entries(
            cooked, meals, LibraryFilters(sort = RecipeSort.MostCooked),
            LibraryFilter.haystacks(cooked, meals),
        )
        assertEquals("r1", list.first().id)
        assertTrue(list.drop(1).all { it is LibraryEntry.Meal })
    }

    @Test
    fun recentlyCookedSortsByTheStoredTimestamp() {
        val cooked = listOf(
            libRecipe("old", "Old", lastCookedAt = "2026-01-01T00:00:00Z"),
            libRecipe("new", "New", lastCookedAt = "2026-08-01T00:00:00Z"),
        )
        val list = LibraryFilter.entries(
            cooked, emptyList(), LibraryFilters(sort = RecipeSort.Recent),
            LibraryFilter.haystacks(cooked, emptyList()),
        )
        assertEquals(listOf("new", "old"), list.map { it.id })
    }

    /** A blank query matches everything rather than nothing. */
    @Test
    fun aWhitespaceQueryIsNoQueryAtAll() {
        assertEquals(4, entries(LibraryFilters(query = "   ")).size)
    }
}
