package app.waffled.feature.recipes

import app.waffled.core.network.WaffledJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * What the recipe editor sends — the testable half of iOS `RecipeEditorView`.
 *
 * The two rules that fail silently:
 *
 *  1. Clearing the photo needs `storageKey: null`, not just `imageUrl: null`. The stored
 *     blob otherwise keeps winning and "remove the image" does nothing visible.
 *  2. Every optional field goes out explicitly. The save endpoint REPLACES the recipe's
 *     content and `WaffledJson` sets `explicitNulls = false`, so a data class would omit
 *     every field the user cleared and the old value would survive unexplained.
 */
class RecipeEditorDraftTest {

    private var n = 0
    private val uid = { "u${n++}" }

    private fun draft() = RecipeEditorDraft.create(uid).copy(title = "Tacos")

    // ---- the body --------------------------------------------------------------

    @Test
    fun sendsTheBasics() {
        val body = draft().copy(emoji = "🌮", servings = "6", prep = "15", cook = "20").body()
        assertEquals("Tacos", body["title"]!!.jsonPrimitive.content)
        assertEquals("🌮", body["emoji"]!!.jsonPrimitive.content)
        assertEquals(6, body["servings"]!!.jsonPrimitive.content.toInt())
        assertEquals(15, body["prepTimeMinutes"]!!.jsonPrimitive.content.toInt())
    }

    /** A blank number is "no prep time", not zero, and not "leave it alone". */
    @Test
    fun aBlankTimeGoesOutAsAnExplicitNull() {
        val body = draft().copy(prep = "", cook = "  ").body()
        assertEquals(JsonNull, body["prepTimeMinutes"])
        assertEquals(JsonNull, body["cookTimeMinutes"])
    }

    /** A nonsense servings entry falls back to four rather than failing the save. */
    @Test
    fun anUnreadableServingsFallsBackToFour() {
        assertEquals(4, draft().copy(servings = "lots").body()["servings"]!!.jsonPrimitive.content.toInt())
    }

    /** Every Details scalar is always present, so clearing one really clears it. */
    @Test
    fun everyDetailsScalarIsAlwaysOnTheWire() {
        val body = draft().copy(meta = mapOf("cuisine" to "mexican")).body()
        assertEquals("mexican", body["cuisine"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, body["protein"])
        assertEquals(JsonNull, body["collection"])
        for (f in RecipeEditorDraft.SCALAR_FIELDS) assertTrue(f.key in body.keys, f.key)
    }

    @Test
    fun dropsBlankIngredientRowsAndNumbersTheRest() {
        val d = draft().copy(
            ingredients = listOf(
                EditIngredient("a", amount = "2", unit = "lb", name = "beef"),
                EditIngredient("b", name = "   "),
                EditIngredient("c", name = "lime", prepNote = "halved", section = "Produce"),
            ),
        )
        val rows = d.body()["ingredients"]!!.jsonArray
        assertEquals(2, rows.size)
        assertEquals("beef", rows[0].jsonObject["name"]!!.jsonPrimitive.content)
        assertEquals(0, rows[0].jsonObject["sortOrder"]!!.jsonPrimitive.content.toInt())
        assertEquals("lime", rows[1].jsonObject["name"]!!.jsonPrimitive.content)
        // Renumbered around the dropped row, not left with a gap.
        assertEquals(1, rows[1].jsonObject["sortOrder"]!!.jsonPrimitive.content.toInt())
        assertEquals(JsonNull, rows[1].jsonObject["amount"])
        assertEquals("Produce", rows[1].jsonObject["section"]!!.jsonPrimitive.content)
    }

    /** A step's picked ingredients go out as "amount name" lines, extras kept verbatim. */
    @Test
    fun composesStepIngredientLinesFromThePicks() {
        val d = draft().copy(
            ingredients = listOf(
                EditIngredient("a", name = "soy sauce"),
                EditIngredient("b", name = "beef"),
            ),
            steps = listOf(
                EditStep(
                    "s1",
                    instruction = "Marinate",
                    picks = listOf(StepPick("a", "2 tbsp"), StepPick("b", "")),
                    extra = listOf("a pinch of salt"),
                    timerSeconds = 600,
                ),
                EditStep("s2", instruction = "  "),
            ),
        )
        val steps = d.body()["steps"]!!.jsonArray
        assertEquals(1, steps.size)
        val lines = steps[0].jsonObject["ingredients"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("2 tbsp soy sauce", "beef", "a pinch of salt"), lines)
        assertEquals(600, steps[0].jsonObject["timerSeconds"]!!.jsonPrimitive.content.toInt())
    }

    /** A pick pointing at a row that has since been deleted is dropped, not crashed on. */
    @Test
    fun aPickWhoseIngredientIsGoneIsSkipped() {
        val d = draft().copy(
            ingredients = listOf(EditIngredient("a", name = "beef")),
            steps = listOf(EditStep("s1", "Brown", picks = listOf(StepPick("gone", "1"), StepPick("a", "")))),
        )
        val lines = d.body()["steps"]!!.jsonArray[0].jsonObject["ingredients"]!!.jsonArray
        assertEquals(1, lines.size)
        assertEquals("beef", lines[0].jsonPrimitive.content)
    }

    @Test
    fun aStepWithNoTimerSendsAnExplicitNull() {
        val d = draft().copy(steps = listOf(EditStep("s1", "Brown")))
        assertEquals(JsonNull, d.body()["steps"]!!.jsonArray[0].jsonObject["timerSeconds"])
    }

    // ---- the photo, the one that fails quietly ---------------------------------

    /** An uploaded blob wins, and carries its content type. */
    @Test
    fun anUploadedPhotoSendsItsStorageKey() {
        val body = draft().copy(storageKey = "k1", contentType = "image/jpeg").body()
        assertEquals("k1", body["storageKey"]!!.jsonPrimitive.content)
        assertEquals("image/jpeg", body["contentType"]!!.jsonPrimitive.content)
        assertFalse("imageUrl" in body.keys)
    }

    /**
     * The regression this exists for: clearing the photo must null the STORAGE KEY too.
     * Sending only `imageUrl: null` leaves the stored blob winning, so "remove the image"
     * does nothing at all.
     */
    @Test
    fun clearingThePhotoNullsTheStorageKeyAsWell() {
        val body = draft().copy(imageUrl = "", storageKey = null).body()
        assertEquals(JsonNull, body["imageUrl"])
        assertEquals(JsonNull, body["storageKey"])
        assertEquals(JsonNull, body["contentType"])
        val wire = WaffledJson.encodeToString(body)
        assertTrue(wire.contains("\"storageKey\":null"), wire)
    }

    /** An external link is kept as a link — no blob involved. */
    @Test
    fun anExternalLinkIsSentAsIs() {
        val body = draft().copy(imageUrl = "  https://example.com/a.jpg ").body()
        assertEquals("https://example.com/a.jpg", body["imageUrl"]!!.jsonPrimitive.content)
        assertFalse("storageKey" in body.keys)
    }

    // ---- seeding ---------------------------------------------------------------

    @Test
    fun aFreshDraftOpensWithOneRowOfEach() {
        val d = RecipeEditorDraft.create(uid)
        assertEquals(1, d.ingredients.size)
        assertEquals(1, d.steps.size)
        assertFalse(d.canSave)
    }

    @Test
    fun seedsFromAnExistingRecipe() {
        val detail = RecipeDetailDTO(
            recipe = RecipeSummary(
                id = "r1", title = "Tacos", emoji = "🌮", servings = 6, prepTimeMinutes = 15,
                cuisine = "mexican", dietary = listOf("gluten-free"), tags = listOf("quick"),
            ),
            ingredients = listOf(RecipeIngredientDTO(id = "i1", name = "beef", amount = 2.0, unit = "lb")),
            steps = listOf(RecipeStepDTO(stepNumber = 1, instruction = "Brown", ingredients = listOf("2 lb beef"))),
        )
        val d = RecipeEditorDraft.edit(detail, uid)
        assertEquals("r1", d.editingId)
        assertEquals("6", d.servings)
        assertEquals("15", d.prep)
        assertEquals("mexican", d.meta["cuisine"])
        // "2", not "2.0" — the field is what a cook would type.
        assertEquals("2", d.ingredients.single().amount)
        assertTrue(d.canSave)
    }

    /**
     * Longest ingredient name first, so "brown sugar" wins over "sugar". Getting this
     * backwards files a step line under the wrong row and takes the wrong amount with it.
     */
    @Test
    fun matchesAStepLineToItsLongestIngredientName() {
        val ings = listOf(EditIngredient("a", name = "sugar"), EditIngredient("b", name = "brown sugar"))
        val s = EditStep.seed("s1", "Mix", listOf("2 tbsp brown sugar"), ings)
        assertEquals(listOf(StepPick("b", "2 tbsp")), s.picks)
        assertTrue(s.extra.isEmpty())
    }

    /** A line matching nothing is kept verbatim rather than silently dropped. */
    @Test
    fun anUnmatchedStepLineBecomesAFreeExtra() {
        val ings = listOf(EditIngredient("a", name = "beef"))
        val s = EditStep.seed("s1", "Brown", listOf("2 lb beef", "a splash of water"), ings)
        assertEquals(listOf(StepPick("a", "2 lb")), s.picks)
        assertEquals(listOf("a splash of water"), s.extra)
    }

    /** Matching ignores case, and an ingredient with no amount picks up a blank one. */
    @Test
    fun matchesCaseInsensitivelyAndToleratesNoAmount() {
        val ings = listOf(EditIngredient("a", name = "Beef"))
        val s = EditStep.seed("s1", "Brown", listOf("beef"), ings)
        assertEquals(listOf(StepPick("a", "")), s.picks)
    }

    /** A blank ingredient row never claims a step line. */
    @Test
    fun aBlankIngredientRowMatchesNothing() {
        val s = EditStep.seed("s1", "Brown", listOf("2 lb beef"), listOf(EditIngredient("a", name = "  ")))
        assertTrue(s.picks.isEmpty())
        assertEquals(listOf("2 lb beef"), s.extra)
    }

    // ---- AI import hydration ---------------------------------------------------

    @Test
    fun hydratesFromAParsedDraft() {
        val parsed = ParsedRecipe(
            recipe = ParsedRecipe.Meta(title = "Carnitas", cuisine = "mexican", servings = 8),
            ingredients = listOf(ParsedRecipe.Ing(name = "pork shoulder", amount = 3.0, unit = "lb")),
            steps = listOf(ParsedRecipe.Step("Sear it", listOf("3 lb pork shoulder"))),
        )
        val d = RecipeEditorDraft.hydrated(RecipeEditorDraft.create(uid), parsed, uid)
        assertEquals("Carnitas", d.title)
        assertEquals("8", d.servings)
        assertEquals("mexican", d.meta["cuisine"])
        assertEquals("3", d.ingredients.single().amount)
        // The step's line matched back to the ingredient, so its amount stays editable.
        assertEquals(1, d.steps.single().picks.size)
    }

    /** An import into a form the user already typed into keeps what the parse omits. */
    @Test
    fun hydrationKeepsWhatTheParseDidNotAnswer() {
        val base = RecipeEditorDraft.create(uid).copy(title = "Mine", notes = "keep me")
        val parsed = ParsedRecipe(
            recipe = ParsedRecipe.Meta(title = ""),
            ingredients = emptyList(),
            steps = emptyList(),
        )
        val d = RecipeEditorDraft.hydrated(base, parsed, uid)
        assertEquals("Mine", d.title)
        assertEquals("keep me", d.notes)
        // …and it never leaves the form with zero rows to type into.
        assertEquals(1, d.ingredients.size)
        assertEquals(1, d.steps.size)
    }
}
