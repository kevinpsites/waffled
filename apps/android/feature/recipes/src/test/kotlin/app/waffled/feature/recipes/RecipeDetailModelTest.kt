package app.waffled.feature.recipes

import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What the recipe detail derives and writes — the testable half of iOS
 * `RecipeDetailView`.
 *
 * The cases worth pinning: the chip ordering (the first three are what a reader sees
 * before "+N more"), the servings ratio (which must scale the grocery sheet too, or the
 * page and the sheet disagree about the same ingredient), and the optimistic favourite
 * that has to roll back.
 */
class RecipeDetailModelTest {

    private val harness = ApiTestHarness()
    private lateinit var api: RecipesApi

    @Before
    fun setUp() {
        harness.start()
        api = RecipesApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens)
    }

    @After
    fun tearDown() = harness.stop()

    private fun model(recipe: RecipeSummary) =
        RecipeDetailModel(api, recipe, baseUrl = harness.baseUrl())

    private val tacos = RecipeSummary(
        id = "r1",
        title = "Tacos",
        servings = 4,
        cuisine = "mexican",
        protein = "beef",
        effort = "easy",
        collection = "Weeknights",
        mealType = "main-dinner",
        vegetables = listOf("onion"),
        dietary = listOf("gluten-free"),
        tags = listOf("quick", "kid-friendly"),
    )

    // ---- derived ---------------------------------------------------------------

    /**
     * Most meaningful first, so the three chips shown before "+N more" are the useful
     * ones. Favourite is absent on purpose — it is the heart in the toolbar.
     */
    @Test
    fun ordersTheChipsMostMeaningfulFirst() {
        val chips = model(tacos).chips.map { it.text }
        assertEquals("🆕 New", chips.first())
        assertEquals(listOf("🆕 New", "⏱️ easy", "🥬 onion"), chips.take(3))
        assertTrue(chips.contains("🌍 mexican"))
        // The meal type reads as words, not as a slug.
        assertTrue(chips.contains("main dinner"))
    }

    /** A cooked recipe loses the "New" chip; nothing else moves. */
    @Test
    fun aCookedRecipeIsNotNew() {
        val chips = model(tacos.copy(cookedCount = 3)).chips.map { it.text }
        assertFalse(chips.contains("🆕 New"))
        assertEquals("⏱️ easy", chips.first())
    }

    /** Dietary flags are their own colour; free tags are the quiet line underneath. */
    @Test
    fun separatesDietaryChipsFromFreeHashtags() {
        val m = model(tacos)
        assertTrue(m.chips.any { it.text == "gluten-free" && it.style == TagStyle.Dietary })
        assertEquals(listOf("quick", "kid-friendly"), m.hashtags)
        assertFalse(m.chips.any { it.text == "quick" })
    }

    /**
     * The scaler covers the whole page AND the grocery sheet. Formatting the raw amount
     * in one of them showed two different numbers for the same ingredient — "2 cups
     * flour" on the page, "1 cup flour" in the sheet.
     */
    @Test
    fun scalesEveryAmountByTheServingsRatio() {
        val m = model(tacos)
        val flour = RecipeIngredientDTO(id = "i1", name = "flour", amount = 1.0, unit = "cup")
        assertEquals("1 cup", m.amountText(flour))
        m.setServings(8)
        assertEquals(2.0, m.ratio)
        assertEquals("2 cup", m.amountText(flour))
        m.setServings(6)
        assertEquals("1½ cup", m.amountText(flour))
    }

    /** A recipe with no servings of its own is assumed to serve four. */
    @Test
    fun assumesFourServingsWhenTheRecipeDoesNotSay() {
        val m = model(tacos.copy(servings = null))
        assertEquals(4, m.baseServings)
        assertEquals(1.0, m.ratio)
    }

    /** Servings never go below one — a zero ratio would blank every amount. */
    @Test
    fun refusesToScaleBelowOneServing() {
        val m = model(tacos)
        m.setServings(0)
        assertEquals(1, m.currentServings)
    }

    @Test
    fun readsTheNameWithItsPrepNote() {
        val m = model(tacos)
        assertEquals(
            "onion, finely diced",
            m.nameText(RecipeIngredientDTO(id = "i1", name = "onion", prepNote = "finely diced")),
        )
        assertEquals("onion", m.nameText(RecipeIngredientDTO(id = "i1", name = "onion")))
    }

    /** A user's step-note override outranks the source's own. */
    @Test
    fun theUsersStepNoteOutranksTheSources() = runTest {
        val m = model(tacos.copy(overrides = RecipeOverrides(stepNotes = mapOf("1" to "mine"))))
        harness.enqueueJson(
            """{"recipe":{"id":"r1","title":"Tacos","overrides":{"stepNotes":{"1":"mine"}}},
                "ingredients":[],
                "steps":[{"stepNumber":1,"instruction":"Brown","note":"theirs"},
                         {"stepNumber":2,"instruction":"Fold","note":"theirs too"}]}""",
        )
        m.load()
        assertEquals("mine", m.noteFor(1))
        assertEquals("theirs too", m.noteFor(2))
        assertNull(m.noteFor(9))
    }

    /** A substitution is keyed on the lowercased name, and a cleared one shows nothing. */
    @Test
    fun readsTheSubstitutionInForce() {
        val m = model(tacos.copy(overrides = RecipeOverrides(subs = mapOf("milk" to "oat milk"))))
        assertEquals("oat milk", m.subFor(RecipeIngredientDTO(id = "i1", name = " Milk ")))
        assertNull(m.subFor(RecipeIngredientDTO(id = "i2", name = "flour")))

        val cleared = model(tacos.copy(overrides = RecipeOverrides(subs = mapOf("milk" to ""))))
        assertNull(cleared.subFor(RecipeIngredientDTO(id = "i1", name = "milk")))
    }

    // ---- loading ---------------------------------------------------------------

    @Test
    fun loadsTheDetailAndItsPantryCounts() = runTest {
        val m = model(tacos)
        harness.enqueueJson(
            """{"recipe":{"id":"r1","title":"Tacos","servings":4},
                "ingredients":[{"id":"i1","name":"beef","isStaple":false}],
                "steps":[{"stepNumber":1,"instruction":"Brown"}],
                "onHand":{"have":1,"total":3},"toBuy":2,"toBuyNames":["beef","lime"]}""",
        )
        m.load()
        val s = m.state.value
        assertFalse(s.loading)
        assertFalse(s.error)
        assertEquals(1, s.ingredients.size)
        assertEquals(1, s.onHand?.have)
        assertEquals("1 of 3", m.banner().lead)
        assertEquals(" on hand — need beef, lime", m.banner().tail)
    }

    /**
     * A failed load must not blank the header the caller already handed us — the summary
     * that opened this screen is still true.
     */
    @Test
    fun aFailedLoadKeepsTheSummaryItOpenedWith() = runTest {
        val m = model(tacos)
        harness.enqueueError(503, "Unavailable")
        m.load()
        assertTrue(m.state.value.error)
        assertEquals("Tacos", m.recipe.title)
    }

    /** Recording a view can never surface as an error on the recipe being read. */
    @Test
    fun recordingAViewSwallowsFailure() = runTest {
        harness.enqueueError(500, "boom")
        model(tacos).recordView()
    }

    // ---- writes ----------------------------------------------------------------

    @Test
    fun favouritingPaintsImmediatelyAndKeepsTheServersAnswer() = runTest {
        val m = model(tacos)
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos","isFavorite":true,"cookedCount":2}}""")
        m.toggleFavorite()
        assertTrue(m.recipe.isFavorite)
        assertEquals(2, m.recipe.cookedCount)
    }

    /** A refused PATCH rolls the optimistic paint back rather than lying on screen. */
    @Test
    fun aRefusedFavouriteRollsBack() = runTest {
        val m = model(tacos)
        harness.enqueueError(500, "boom")
        harness.enqueueError(500, "boom")
        m.toggleFavorite()
        assertFalse(m.recipe.isFavorite)
    }

    @Test
    fun markingCookedOffersThePantryReconcileWhenSomethingMatched() = runTest {
        val m = model(tacos)
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos","cookedCount":1}}""")
        harness.enqueueJson("""{"matches":[{"id":"p1","name":"Beef","suggested":"used_up"}]}""")
        m.markCooked()
        assertEquals(1, m.recipe.cookedCount)
        assertEquals("Marked as cooked — nice work.", m.state.value.message)
        assertEquals(1, m.pantryReconcile.value.size)
        m.clearPantryReconcile()
        assertTrue(m.pantryReconcile.value.isEmpty())
    }

    /** No matches (or the pantry module off) means no sheet at all. */
    @Test
    fun markingCookedWithNoPantryMatchesOffersNothing() = runTest {
        val m = model(tacos)
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos","cookedCount":1}}""")
        harness.enqueueJson("""{"matches":[]}""")
        m.markCooked()
        assertTrue(m.pantryReconcile.value.isEmpty())
    }

    @Test
    fun addingToTheGroceryListReportsWhatLanded() = runTest {
        val m = model(tacos)
        harness.enqueueJson("""{"added":3}""")
        m.addToGrocery(listOf("i1", "i2", "i3"))
        assertEquals("Added 3 to your grocery list.", m.state.value.message)
        assertFalse(m.state.value.busy)
    }

    /** Nothing new to add is a real outcome, not a failure — say which it was. */
    @Test
    fun addingNothingNewSaysSoRatherThanClaimingSuccess() = runTest {
        val m = model(tacos)
        harness.enqueueJson("""{"added":0}""")
        m.addToGrocery(listOf("i1"))
        assertEquals("Everything’s already on the list or on hand.", m.state.value.message)
    }

    @Test
    fun anUnreachableGroceryListSaysSo() = runTest {
        val m = model(tacos)
        harness.enqueueError(503, "Unavailable")
        m.addToGrocery(listOf("i1"))
        assertEquals("Couldn’t reach the grocery list — try again.", m.state.value.message)
    }

    /** An empty pick is a no-op — never a request that adds the whole recipe. */
    @Test
    fun addingAnEmptyPickWritesNothing() = runTest {
        val m = model(tacos)
        m.addToGrocery(emptyList())
        assertEquals(0, harness.requestCount)
    }

    @Test
    fun deletingReportsWhetherTheScreenShouldPop() = runTest {
        val m = model(tacos)
        harness.enqueueNoContent()
        assertTrue(m.delete())

        harness.enqueueError(409, "Conflict")
        assertFalse(m.delete())
        assertEquals("Couldn’t delete the recipe. Try again.", m.state.value.message)
    }

    @Test
    fun checkingOffAnIngredientIsLocalAndReversible() {
        val m = model(tacos)
        m.toggleChecked("i1")
        assertEquals(setOf("i1"), m.state.value.checked)
        m.toggleChecked("i1")
        assertTrue(m.state.value.checked.isEmpty())
        assertEquals(0, harness.requestCount)
    }

    /** The step-note editor writes the whole overrides blob, explicit nulls included. */
    @Test
    fun savingAStepNoteReplacesTheWholeOverrideBlob() = runTest {
        val m = model(tacos)
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos"}}""")
        m.saveStepNote(2, "low heat")
        val body = harness.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"stepNotes\":{\"2\":\"low heat\"}"), body)
        assertTrue(body.contains("\"subs\":null"), body)
    }
}
