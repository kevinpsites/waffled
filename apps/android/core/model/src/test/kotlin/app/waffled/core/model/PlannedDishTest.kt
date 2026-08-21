package app.waffled.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The Meals ↔ Recipes seam.
 *
 * `RecipeRef` shipped without a `MealRef` counterpart, so the recipe picker could only
 * hand back half of what a planned slot can hold and the plate half travelled as loose
 * primitives.
 *
 * ⚠️ A slot holds **either** a recipe or a plate, never "a recipe that might be a plate".
 * The server keeps `isMealBacked` as its own field precisely because inferring it from
 * `recipeId != null` broke four web surfaces at once — this sealed type is what stops
 * that reasoning reappearing on Android.
 */
class PlannedDishTest {

    @Test
    fun aRecipeSlotNamesItself() {
        val dish = PlannedDish.FromRecipe(RecipeRef(id = "r1", title = "Lasagne", emoji = "🍝"))
        assertEquals("Lasagne", dish.displayName)
    }

    @Test
    fun aPlateSlotNamesItself() {
        val plate = MealRef(id = "m1", name = "Sunday roast", emojis = listOf("🍖", "🥔"), dishCount = 2)
        assertEquals("Sunday roast", PlannedDish.FromPlate(plate).displayName)
    }

    @Test
    fun freeTextIsAFirstClassSlotNotAnEmptyRecipe() {
        // "Leftovers" is a legitimate plan, not a recipe with a missing id.
        assertEquals("Leftovers", PlannedDish.FreeText("Leftovers").displayName)
    }

    @Test
    fun aPlateIsNeverMistakenForARecipe() {
        val plate: PlannedDish = PlannedDish.FromPlate(MealRef(id = "m1", name = "Roast"))
        val recipe: PlannedDish = PlannedDish.FromRecipe(RecipeRef(id = "m1", title = "Roast"))

        // Same id, same name, different kind — and the type says so, rather than a caller
        // inferring it from which field happens to be null.
        assertTrue(plate is PlannedDish.FromPlate)
        assertTrue(recipe is PlannedDish.FromRecipe)
        assertTrue(plate != recipe)
    }

    @Test
    fun aPlateCarriesItsDishesForTheCard() {
        val plate = MealRef(id = "m1", name = "Roast", emojis = listOf("🍖", "🥔", "🥕"), dishCount = 3)
        assertEquals(3, plate.dishCount)
        assertEquals(listOf("🍖", "🥔", "🥕"), plate.emojis)
    }
}
