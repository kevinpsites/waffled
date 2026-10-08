package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The Kotlin port of the "ticking ingredients off" and `CookChipLabelTests` suites in
 * `apps/ios/Tests/CookSessionTests.swift`. A step names ingredients as free text while the
 * list holds rows with ids, so the two resolve to one tick — kept per dish on a plate.
 */
class CookIngredientTickTest {

    private fun step(n: Int, text: String) = RecipeStepDTO(stepNumber = n, instruction = text)

    private fun ingredient(name: String) = RecipeIngredientDTO(id = "ing-$name", name = name)

    private fun garlicDish(id: String = "main") = CookDish(
        id = id,
        title = "Ragu",
        steps = listOf(step(1, "Sweat the garlic"), step(2, "Add the wine")),
        ingredients = listOf(ingredient("garlic"), ingredient("onion")),
    )

    private fun dish(id: String, title: String) = CookDish(
        id = id,
        title = title,
        steps = (1..4).map { step(it, "$title step $it") },
        ingredients = listOf(ingredient(title)),
    )

    private fun solo(d: CookDish) = CookSession.of(null, d.title, listOf(d))!!

    private fun plate(dishes: List<CookDish>) = CookSession.of("plate-1", "BBQ Sunday", dishes)!!

    @Test
    fun aTickGoesOnAndComesBackOff() {
        var s = solo(garlicDish())
        assertFalse(s.isTicked("ing-garlic"))
        s = s.toggleTick("ing-garlic")
        assertTrue(s.isTicked("ing-garlic"))
        s = s.toggleTick("ing-garlic")
        assertFalse(s.isTicked("ing-garlic"))
    }

    @Test
    fun aStepsFreeTextIngredientResolvesToTheRecipesOwnRow() {
        val ings = listOf(ingredient("garlic"), ingredient("onion"))
        assertEquals("ing-garlic", CookSession.ingredientKey("4 cloves garlic", ings))
        val both = listOf(ingredient("olive oil"), ingredient("oil"))
        assertEquals("ing-olive oil", CookSession.ingredientKey("3 tbsp olive oil", both))
    }

    @Test
    fun anIngredientTheRecipeNeverListedIsStillTickable() {
        val key = CookSession.ingredientKey("a pinch of salt", listOf(ingredient("garlic")))
        assertNotEquals("ing-garlic", key)

        val s = solo(garlicDish()).toggleTick(key)
        assertTrue(s.isTicked(key))
        assertFalse(s.isTicked("ing-garlic"))
    }

    @Test
    fun eachDishKeepsItsOwnTicksAcrossASwitch() {
        var s = plate(listOf(garlicDish("main"), dish("side", "Potato Salad")))
        s = s.toggleTick("ing-garlic")

        s = s.activate("side")!!
        assertFalse(s.isTicked("ing-garlic"))
        s = s.toggleTick("ing-Potato Salad")
        assertTrue(s.isTicked("ing-Potato Salad"))

        s = s.activate("main")!!
        assertTrue(s.isTicked("ing-garlic"))
        assertFalse(s.isTicked("ing-Potato Salad"))
    }

    @Test
    fun howManyOfThisDishsIngredientsAreGathered() {
        var s = solo(garlicDish())
        assertEquals(0, s.tickedCount)
        s = s.toggleTick("ing-garlic")
        s = s.toggleTick(CookSession.ingredientKey("a pinch of salt", s.ingredients))
        assertEquals(1, s.tickedCount)
        assertEquals(2, s.ingredients.size)
    }

    @Test
    fun anIngredientNameHasToStartWhereAWordStarts() {
        val rows = listOf(
            ingredient("oil"), ingredient("ice"), ingredient("onion"),
            ingredient("olive oil"), ingredient("egg"),
        )
        assertEquals("text:2 cups boiling water", CookSession.ingredientKey("2 cups boiling water", rows))
        assertEquals("text:1 cup rice", CookSession.ingredientKey("1 cup rice", rows))

        assertEquals("ing-onion", CookSession.ingredientKey("2 large onions", rows))
        assertEquals("ing-egg", CookSession.ingredientKey("3 eggs, beaten", rows))

        assertEquals("ing-olive oil", CookSession.ingredientKey("2 tbsp olive oil", rows))
        assertEquals("ing-oil", CookSession.ingredientKey("oil for frying", rows))
    }

    // ---- CookChipLabelTests -----------------------------------------------------

    private fun measured(name: String, amount: Double?, unit: String?, display: String? = null) =
        RecipeIngredientDTO(id = "ing-$name", name = name, amount = amount, unit = unit, display = display)

    private val rows = listOf(
        measured("garlic", 2.0, "cloves"), measured("salt", null, null),
        measured("olive oil", 3.0, "tbsp"), measured("stock", 0.5, "cup"),
    )

    @Test
    fun aChipThatIsJustTheIngredientsNameGetsItsAmountAndUnit() {
        assertEquals("3 tbsp olive oil", CookSession.chipLabel("olive oil", rows))
        assertEquals("½ cup stock", CookSession.chipLabel("stock", rows))
        assertEquals("3 tbsp Olive Oil", CookSession.chipLabel(" Olive Oil ", rows))
    }

    @Test
    fun aChipInTheAuthorsOwnWordsStaysAsWritten() {
        assertEquals("4 cloves garlic", CookSession.chipLabel("4 cloves garlic", rows))
        assertEquals("Half the minced garlic", CookSession.chipLabel("Half the minced garlic", rows))
        assertEquals("salt", CookSession.chipLabel("salt", rows))
    }

    @Test
    fun theListRowFallsBackToItsImportedLineWhenNothingWasParsed() {
        val flour = measured("flour", null, null, display = "2¾–3 cups flour")
        assertEquals("2¾–3 cups flour", CookSession.listName(flour))
        assertEquals("garlic", CookSession.listName(measured("garlic", 2.0, "cloves", display = "2 cloves garlic, minced")))
        assertEquals("2 cloves", CookSession.amountText(measured("garlic", 2.0, "cloves")))
        assertEquals("", CookSession.amountText(flour))
    }
}
