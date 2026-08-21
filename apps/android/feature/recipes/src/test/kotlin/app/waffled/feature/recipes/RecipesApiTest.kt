package app.waffled.feature.recipes

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Recipes + Meals REST slice, driven against a real MockWebServer.
 *
 * The cases that matter beyond "it parses": the three places the server distinguishes an
 * **absent** key from an explicit `null`. `WaffledJson` sets `explicitNulls = false`, so
 * a nullable data-class property is silently omitted from a PATCH — turning "clear this"
 * into "leave it alone". Every such body here is a hand-built `JsonObject`, and the tests
 * assert the null is genuinely on the wire rather than just checking the model.
 */
class RecipesApiTest {

    private val harness = ApiTestHarness()
    private lateinit var api: RecipesApi

    @Before
    fun setUp() {
        harness.start()
        api = RecipesApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens)
    }

    @After
    fun tearDown() = harness.stop()

    // ---- library + detail ------------------------------------------------------

    @Test
    fun loadsTheLibrary() = runTest {
        harness.enqueueJson("""{"recipes":[{"id":"r1","title":"Tacos","cookedCount":2,"isFavorite":true}]}""")
        val list = api.library()
        assertEquals("Tacos", list.single().title)
        assertTrue(list.single().isFavorite)
        assertEquals("/api/recipes", harness.takeRequest().path)
    }

    @Test
    fun loadsOneRecipesDetail() = runTest {
        harness.enqueueJson(
            """{"recipe":{"id":"r1","title":"Tacos"},
                "ingredients":[{"id":"i1","name":"beef","isStaple":false,"inPantry":true}],
                "steps":[{"stepNumber":1,"instruction":"Brown","ingredients":[],"timerSeconds":600}],
                "onHand":{"have":1,"total":3},"toBuy":2,"toBuyNames":["a","b"]}""",
        )
        val d = api.detail("r1")
        assertEquals("Tacos", d.recipe.title)
        assertEquals(true, d.ingredients.single().inPantry)
        assertEquals(600, d.steps.single().timerSeconds)
        assertEquals(1, d.onHand?.have)
        assertEquals("/api/recipes/r1", harness.takeRequest().path)
    }

    @Test
    fun loadsRecentlyViewedForOneScope() = runTest {
        harness.enqueueJson("""{"recipes":[{"id":"r1","title":"Tacos"}]}""")
        api.recent(scope = RecentRecipeScope.Household, limit = 5)
        assertEquals("/api/recipes/recent?scope=household&limit=5", harness.takeRequest().path)
    }

    /**
     * Recording a view is a convenience signal. A failure to record it must never
     * surface as an error on the recipe the user is reading, so this one swallows.
     */
    @Test
    fun recordingAViewNeverThrows() = runTest {
        harness.enqueueError(500, "boom")
        api.recordView("r1")
        assertEquals("/api/recipes/r1/view", harness.takeRequest().path)
    }

    @Test
    fun loadsTheSharableMarkdown() = runTest {
        harness.enqueueJson("""{"markdown":"# Tacos","filename":"tacos.md"}""")
        val md = api.markdown("r1")
        assertEquals("# Tacos", md.markdown)
        assertEquals("/api/recipes/r1/markdown", harness.takeRequest().path)
    }

    @Test
    fun loadsTheHouseholdsSectionNames() = runTest {
        harness.enqueueJson("""{"sections":["For the sauce","For the slaw"]}""")
        assertEquals(2, api.sections().size)
        assertEquals("/api/recipes/sections", harness.takeRequest().path)
    }

    // ---- favourite / cooked ----------------------------------------------------

    @Test
    fun togglesFavorite() = runTest {
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos","isFavorite":true}}""")
        assertTrue(api.setFavorite("r1", true).isFavorite)
        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertTrue(req.body.readUtf8().contains("\"isFavorite\":true"))
    }

    @Test
    fun marksCooked() = runTest {
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos","cookedCount":3}}""")
        assertEquals(3, api.markCooked("r1").cookedCount)
        assertEquals("/api/recipes/r1/cooked", harness.takeRequest().path)
    }

    // ---- the explicitNulls traps -----------------------------------------------

    /**
     * `overrides` **replaces the whole blob**, so a cleared key must go on the wire as an
     * explicit null. Serialising a data class would drop it (`explicitNulls = false`) and
     * "remove my added tags" would silently mean "leave them alone".
     */
    @Test
    fun clearingAnOverrideKeySendsAnExplicitNull() = runTest {
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos"}}""")
        api.updateRecipe(
            "r1",
            overrides = buildJsonObject {
                put("addedTags", JsonNull)
                put("removedTags", JsonNull)
            },
        )
        val body = harness.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"addedTags\":null"), body)
        assertTrue(body.contains("\"removedTags\":null"), body)
    }

    /** User notes and overrides are independent — sending one must not blank the other. */
    @Test
    fun patchingOnlyTheUserNotesLeavesOverridesAlone() = runTest {
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos","userNotes":"less salt"}}""")
        api.updateRecipe("r1", userNotes = "less salt")
        val body = harness.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"userNotes\":\"less salt\""), body)
        assertFalse(body.contains("overrides"), body)
    }

    /**
     * "Nobody" must clear the cook explicitly. The server distinguishes an absent
     * `cookPersonId` (leave it alone) from an explicit null, so `Unchanged` would make
     * un-assigning impossible — and the omission is invisible from the model's side,
     * which is why this asserts on the request body.
     */
    @Test
    fun pickingNobodyPutsAnExplicitNullOnTheWire() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ"}}""")
        api.patchDish("m1", "r1", cook = CookAssignment.Clear)
        val req = harness.takeRequest()
        assertEquals("/api/meals/m1/recipes/r1", req.path)
        assertTrue(req.body.readUtf8().contains("\"cookPersonId\":null"))
    }

    @Test
    fun anUnchangedCookSendsNoCookKeyAtAll() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ"}}""")
        api.patchDish("m1", "r1", role = "dessert", cook = CookAssignment.Unchanged)
        val body = harness.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"role\":\"dessert\""), body)
        assertFalse(body.contains("cookPersonId"), body)
    }

    @Test
    fun assigningACookNamesThePerson() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ"}}""")
        api.patchDish("m1", "r1", cook = CookAssignment.Person("kevin"))
        assertTrue(harness.takeRequest().body.readUtf8().contains("\"cookPersonId\":\"kevin\""))
    }

    // ---- editor writes ---------------------------------------------------------

    @Test
    fun createsARecipeFromTheEditorBody() = runTest {
        harness.enqueueJson("""{"recipe":{"id":"new","title":"Tacos"}}""")
        val body = buildJsonObject { put("title", JsonPrimitive("Tacos")) }
        assertEquals("new", api.createRecipe(body).id)
        val req = harness.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/recipes", req.path)
    }

    @Test
    fun savesRecipeContent() = runTest {
        harness.enqueueJson("""{"recipe":{"id":"r1","title":"Tacos v2"}}""")
        assertEquals("Tacos v2", api.saveRecipeContent("r1", buildJsonObject { }).title)
        assertEquals("PATCH", harness.takeRequest().method)
    }

    /** The server answers a delete with 204 and no body at all. */
    @Test
    fun deletesARecipe() = runTest {
        harness.enqueueNoContent()
        api.deleteRecipe("r1")
        val req = harness.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/recipes/r1", req.path)
    }

    // ---- AI import -------------------------------------------------------------

    @Test
    fun readsTheIngestConfig() = runTest {
        harness.enqueueJson("""{"text":true,"vision":false}""")
        val c = api.ingestConfig()
        assertTrue(c.text)
        assertFalse(c.vision)
    }

    @Test
    fun parsesPastedMarkdown() = runTest {
        harness.enqueueJson("""{"recipe":{"title":"Tacos"},"ingredients":[],"steps":[]}""")
        assertEquals("Tacos", api.parseMarkdown("# Tacos").recipe.title)
        assertEquals("/api/recipes/parse-markdown", harness.takeRequest().path)
    }

    @Test
    fun turnsDictatedTextIntoADraft() = runTest {
        harness.enqueueJson("""{"recipe":{"title":"Tacos"},"ingredients":[],"steps":[],"via":"llm"}""")
        assertEquals("Tacos", api.ingestVoice("tacos with beef").recipe.title)
        assertEquals("/api/recipes/ingest/voice", harness.takeRequest().path)
    }

    @Test
    fun turnsPhotosIntoADraft() = runTest {
        harness.enqueueJson("""{"recipe":{"title":"Tacos"},"ingredients":[],"steps":[]}""")
        api.ingestPhotos(listOf(RecipesApi.EncodedImage("AAAA", "image/jpeg")))
        val req = harness.takeRequest()
        assertEquals("/api/recipes/ingest/photo", req.path)
        assertTrue(req.body.readUtf8().contains("\"contentType\":\"image/jpeg\""))
    }

    /**
     * A missing / failing AI provider is "no suggestion this round", not an error — the
     * editor just shows nothing and keeps probing.
     */
    @Test
    fun aMissingAiProviderYieldsNoSuggestionRatherThanAnError() = runTest {
        harness.enqueueError(501, "NotConfigured", "No AI provider")
        assertNull(api.suggestMetadata("Tacos", listOf("beef"), listOf("brown it")))
    }

    @Test
    fun readsAMetadataSuggestion() = runTest {
        harness.enqueueJson("""{"suggestion":{"cuisine":"mexican","tags":["quick"]}}""")
        assertEquals("mexican", api.suggestMetadata("Tacos", emptyList(), emptyList())?.cuisine)
    }

    // ---- media -----------------------------------------------------------------

    @Test
    fun uploadsMediaAsBase64Json() = runTest {
        harness.enqueueJson("""{"key":"k1","url":"/media/k1.jpg","contentType":"image/jpeg"}""")
        val up = api.uploadMedia("AAAA", "image/jpeg")
        assertEquals("k1", up.key)
        val req = harness.takeRequest()
        assertEquals("/api/media", req.path)
        assertTrue(req.body.readUtf8().contains("\"data\":\"AAAA\""))
    }

    // ---- grocery ---------------------------------------------------------------

    /** Omitting the picked subset adds every non-staple ingredient (the default). */
    @Test
    fun addsAWholeRecipeToTheGroceryList() = runTest {
        harness.enqueueJson("""{"added":4}""")
        assertEquals(4, api.groceryFromRecipe("r1"))
        assertEquals("/api/lists/grocery/from-recipe/r1", harness.takeRequest().path)
    }

    @Test
    fun addsOnlyThePickedIngredients() = runTest {
        harness.enqueueJson("""{"added":2}""")
        api.groceryFromRecipe("r1", weekStart = "2026-08-10", ingredientIds = listOf("i1", "i2"))
        val req = harness.takeRequest()
        assertEquals("/api/lists/grocery/from-recipe/r1?weekStart=2026-08-10", req.path)
        assertTrue(req.body.readUtf8().contains("\"ingredientIds\":[\"i1\",\"i2\"]"))
    }

    @Test
    fun takesARecipeBackOffTheList() = runTest {
        harness.enqueueJson("""{"removed":3}""")
        assertEquals(3, api.removeRecipeFromGrocery("r1"))
        assertEquals("DELETE", harness.takeRequest().method)
    }

    @Test
    fun readsThePantryMatchesForACookedRecipe() = runTest {
        harness.enqueueJson(
            """{"matches":[{"id":"p1","name":"Beef","amount":"1","unit":"lb","isStaple":false,"suggested":"used_up"}]}""",
        )
        assertEquals("used_up", api.pantryForRecipe("r1").single().suggested)
        assertEquals("/api/pantry/for-recipe/r1", harness.takeRequest().path)
    }

    // ---- planning one recipe ---------------------------------------------------

    /** The recipe detail's "Schedule…" — one recipe into one night's slot. */
    @Test
    fun plansOneRecipeIntoASlot() = runTest {
        harness.enqueueNoContent()
        api.planRecipe("2026-08-16", "dinner", recipeId = "r1")
        val req = harness.takeRequest()
        assertEquals("/api/meals/plan", req.path)
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"recipeId\":\"r1\""), body)
        assertTrue(body.contains("\"mealType\":\"dinner\""), body)
        // A free-text night sends no recipe at all, so the key must be absent, not null.
        assertFalse(body.contains("title"), body)
    }

    // ---- plates ----------------------------------------------------------------

    @Test
    fun createsAPlate() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ Sunday","servings":6}}""")
        val m = api.createMeal("BBQ Sunday", servings = 6)
        assertEquals(6, m.servings)
        val req = harness.takeRequest()
        assertEquals("/api/meals", req.path)
        assertTrue(req.body.readUtf8().contains("\"servings\":6"))
    }

    /** `q` matches the plate name OR any dish title, so it must survive encoding. */
    @Test
    fun searchesSavedPlates() = runTest {
        harness.enqueueJson("""{"meals":[]}""")
        api.savedMeals(q = "bbq sunday", limit = 10)
        assertEquals("/api/meals?q=bbq%20sunday&limit=10", harness.takeRequest().path)
    }

    @Test
    fun addsADishUnderAnExplicitRole() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ"}}""")
        api.addDish("m1", "r1", role = "dessert")
        val req = harness.takeRequest()
        assertEquals("/api/meals/m1/recipes", req.path)
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"recipeId\":\"r1\""), body)
        assertTrue(body.contains("\"role\":\"dessert\""), body)
    }

    /** A saved plate added to a plate under construction FLATTENS — meals never nest. */
    @Test
    fun flatteningSendsTheSavedPlatesIdNotARecipeId() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ"}}""")
        api.flattenMeal("m1", "saved-1")
        val body = harness.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"mealId\":\"saved-1\""), body)
        assertFalse(body.contains("recipeId"), body)
    }

    @Test
    fun reordersTheWholePlateInOneWrite() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ"}}""")
        api.reorderDishes("m1", listOf("a", "b", "c"))
        val req = harness.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/meals/m1/recipes/order", req.path)
        assertTrue(req.body.readUtf8().contains("\"recipeIds\":[\"a\",\"b\",\"c\"]"))
    }

    @Test
    fun removesADish() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ","recipes":[]}}""")
        assertTrue(api.removeDish("m1", "r1").recipes.isEmpty())
        assertEquals("/api/meals/m1/recipes/r1", harness.takeRequest().path)
    }

    @Test
    fun schedulesAPlateIntoADayAndSlot() = runTest {
        harness.enqueueJson(
            """{"entry":{"id":"e1","date":"2026-08-16","mealType":"dinner","mealId":"m1"},
                "meal":{"id":"m1","name":"BBQ Sunday"}}""",
        )
        val s = api.scheduleMeal("m1", "2026-08-16", "dinner", cookPersonId = "kevin")
        assertEquals("e1", s.entry.id)
        val body = harness.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"cookPersonId\":\"kevin\""), body)
    }

    @Test
    fun putsAPlatesShoppingOnTheList() = runTest {
        harness.enqueueJson("""{"added":7}""")
        assertEquals(7, api.addMealToGrocery("m1", weekStart = "2026-08-10"))
        assertEquals("/api/meals/m1/add-to-list?weekStart=2026-08-10", harness.takeRequest().path)
    }

    @Test
    fun takesAPlateBackOffTheList() = runTest {
        harness.enqueueJson("""{"removed":2}""")
        assertEquals(2, api.removeMealFromGrocery("m1"))
        val req = harness.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/meals/m1/add-to-list", req.path)
    }

    // ---- auth + errors ---------------------------------------------------------

    /** A 401 refreshes ONCE and replays — the shared `core:network` contract. */
    @Test
    fun refreshesOnceAndReplaysAfterA401() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"recipes":[{"id":"r1","title":"Tacos"}]}""")
        assertEquals("Tacos", api.library().single().title)
        assertEquals(1, harness.refreshCount.get())
        harness.takeRequest()
        assertEquals("Bearer refreshed-access-token", harness.takeRequest().getHeader("Authorization"))
    }

    /** The error text relays what the SERVER said — it knows why, and we don't. */
    @Test
    fun relaysTheServersOwnErrorMessage() = runTest {
        harness.enqueueError(409, "Conflict", "That recipe is already on the plate.")
        val e = assertFailsWith<WaffledApiException> { api.addDish("m1", "r1") }
        assertEquals(409, e.status)
        assertEquals("That recipe is already on the plate.", e.userMessage)
    }
}
