package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The recipe → "Add to grocery list" picker's opening state — the Kotlin port of
 * `apps/ios/Tests/RecipeGroceryPickTests.swift`.
 *
 * `inPantry` and `isStaple` answer two different questions and the picker must keep them
 * apart:
 *
 *  - inPantry — the server matched this against the household's actual pantry. An
 *    observation. Pre-UNCHECK it: adding something you were just told you have is the
 *    noise this removes.
 *  - isStaple — the household is assumed to keep this around. An assumption, not an
 *    observation. Stays CHECKED, with only a muted hint, because an item missing at the
 *    shop costs more than an extra one to uncheck.
 *
 * Reversing the staple default while implementing the pantry one would silently drop
 * items the shopper never told us they had — hence the explicit cases below.
 */
class RecipeGroceryPickTest {

    private fun ing(id: String, name: String, staple: Boolean = false, inPantry: Boolean? = null) =
        RecipeIngredientDTO(id = id, name = name, isStaple = staple, inPantry = inPantry)

    @Test
    fun unchecksWhatThePantrySaysYouHave() {
        val items = listOf(
            ing("a", "Eggs", inPantry = true),
            ing("b", "Flour"),
            ing("c", "Butter", inPantry = false),
        )
        assertEquals(setOf("b", "c"), RecipeGroceryPick.initialSelection(items))
        assertEquals(1, RecipeGroceryPick.pantryCount(items))
    }

    /** The one that must not regress: a staple is an assumption, so it opens CHECKED. */
    @Test
    fun keepsStaplesChecked() {
        val items = listOf(
            ing("a", "Salt", staple = true),
            ing("b", "Olive oil", staple = true),
            ing("c", "Cod"),
        )
        assertEquals(setOf("a", "b", "c"), RecipeGroceryPick.initialSelection(items))
        assertEquals(0, RecipeGroceryPick.pantryCount(items))
    }

    /**
     * A staple the pantry actually matched follows the pantry, not the assumption — the
     * observation is the stronger claim.
     */
    @Test
    fun aStapleThePantryMatchedStillUnchecks() {
        val items = listOf(ing("a", "Salt", staple = true, inPantry = true), ing("b", "Cod"))
        assertEquals(setOf("b"), RecipeGroceryPick.initialSelection(items))
    }

    /** An unknown (older server, or any non-detail payload) stays checked. */
    @Test
    fun anUnknownStaysChecked() {
        assertEquals(setOf("a1"), RecipeGroceryPick.initialSelection(listOf(ing("a1", "Eggs"))))
    }

    // ---- copy: nothing should happen silently ----------------------------------

    @Test
    fun saysHowManyItUnchecked() {
        assertEquals(
            "We’ve already unchecked 3 items your pantry says you have.",
            RecipeGroceryPick.intro(3),
        )
        assertEquals(
            "We’ve already unchecked 1 item your pantry says you have.",
            RecipeGroceryPick.intro(1),
        )
        assertEquals("Uncheck anything you already have on hand.", RecipeGroceryPick.intro(0))
    }

    /**
     * Pre-unchecking can empty the selection outright when the pantry covers the whole
     * recipe. "Add 0 items" on a dead button explains nothing — name the state.
     */
    @Test
    fun namesTheEmptyStateOnTheAddButton() {
        assertEquals("Nothing to add", RecipeGroceryPick.addLabel(0))
        assertEquals("Add 1 item", RecipeGroceryPick.addLabel(1))
        assertEquals("Add 4 items", RecipeGroceryPick.addLabel(4))
    }

    /** The hint slot holds one line: a real match outranks an assumed one. */
    @Test
    fun theRealMatchWinsTheHintSlot() {
        assertEquals(
            RecipeGroceryPick.Hint.InPantry,
            RecipeGroceryPick.hint(ing("a", "Salt", staple = true, inPantry = true)),
        )
        assertEquals(
            RecipeGroceryPick.Hint.Staple,
            RecipeGroceryPick.hint(ing("a", "Salt", staple = true)),
        )
        assertNull(RecipeGroceryPick.hint(ing("a", "Cod")))
    }

    // ---- when the action can run at all ----------------------------------------

    /**
     * The recipe detail's menu is live from the first frame, but the sheet builds its
     * whole state from the ingredients, which arrive with the detail fetch. Tap it early
     * enough and the sheet opens on an empty list with nothing to add.
     */
    @Test
    fun cannotAddBeforeTheIngredientsLoad() {
        assertFalse(RecipeGroceryPick.canAdd(emptyList()))
    }

    @Test
    fun canAddOnceTheIngredientsAreThere() {
        assertTrue(RecipeGroceryPick.canAdd(listOf(ing("a", "Cod"))))
    }

    /**
     * A pantry that covers the entire recipe opens the sheet with NOTHING checked — but
     * the action is still worth offering. The rows are all there, each one says why it's
     * unchecked, and "Select all" is the way to override us. That is a very different
     * screen from the empty one, and only the empty one is a bug.
     */
    @Test
    fun aFullyStockedPantryStillOpensTheSheet() {
        val all = listOf(ing("a", "Eggs", inPantry = true), ing("b", "Milk", inPantry = true))
        assertTrue(RecipeGroceryPick.initialSelection(all).isEmpty())
        assertTrue(RecipeGroceryPick.canAdd(all))
    }
}
