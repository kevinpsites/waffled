package app.waffled.feature.pantry

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The pantry API slice, driven against a real MockWebServer through [ApiTestHarness].
 *
 * Pantry is **online-only** — none of its tables are in the PowerSync schema — so this
 * slice is the module's entire data path, and the request bodies are asserted on the
 * wire rather than trusted.
 */
class PantryApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: PantryApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = PantryApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    // ---- the list + its inline household config -------------------------------------

    @Test
    fun `list carries the items and the household's pantry config`() = runTest {
        harness.enqueueJson(
            """
            {"items":[
              {"id":"i1","name":"Greek yogurt","amount":"2","unit":"tubs","location":"Fridge",
               "expiresOn":"2026-08-24","note":"","usedUp":false,"barcode":"0049000028200",
               "brand":"Fage","imageUrl":"/media/ab/cd.jpg","quantityText":"500 g",
               "servingBasis":"per 100 g",
               "nutrition":{"calories":97,"protein_g":9.0,"fat_g":5.0,"carbs_g":3.6,"sodium_mg":36},
               "allergens":["milk"],"traces":["tree_nut"],"dietary":["vegetarian"],
               "source":"openfoodfacts","lowAt":1.0,"isMeal":false,
               "createdAt":"2026-08-01T10:00:00Z","addedOn":"2026-08-01"}
             ],
             "locations":["Freezer","Fridge","Pantry"],
             "showOnToday":true,
             "avoidAllergens":["gluten"],
             "allergenPeople":{"peanut":["Jerry"]},
             "lowThreshold":1.0,
             "locationIcons":{"Fridge":"🧊"},
             "staleMonths":6.0}
            """.trimIndent(),
        )

        val response = api.list()

        assertEquals("/api/pantry", harness.takeRequest().path)
        val item = response.items.single()
        assertEquals("Greek yogurt", item.name)
        assertEquals("2", item.amount)
        assertEquals("Fridge", item.location)
        assertEquals("2026-08-24", item.expiresOn)
        assertEquals("Fage", item.brand)
        assertEquals(listOf("milk"), item.allergens)
        assertEquals(listOf("tree_nut"), item.traces)
        assertEquals(listOf("vegetarian"), item.dietary)
        assertEquals("2026-08-01", item.addedOn)
        assertEquals(1.0, item.lowAt)
        // Nutrition arrives snake_case and must land on the Kotlin names.
        assertEquals(9.0, item.nutrition?.proteinG)
        assertEquals(36.0, item.nutrition?.sodiumMg)

        assertEquals(listOf("Freezer", "Fridge", "Pantry"), response.locations)
        assertEquals(listOf("gluten"), response.avoidAllergens)
        assertEquals(mapOf("peanut" to listOf("Jerry")), response.allergenPeople)
        assertEquals(1.0, response.lowThreshold)
        assertEquals(mapOf("Fridge" to "🧊"), response.locationIcons)
        assertEquals(6.0, response.staleMonths)
        assertTrue(response.showOnToday)
    }

    @Test
    fun `an item added by hand decodes with no product snapshot at all`() = runTest {
        harness.enqueueJson(
            """
            {"items":[{"id":"i2","name":"Flour","amount":"a pinch","unit":"","location":"Pantry",
                       "note":"","usedUp":false}],
             "locations":[],"showOnToday":true,"avoidAllergens":[],"allergenPeople":{},
             "lowThreshold":1.0}
            """.trimIndent(),
        )

        val item = api.list().items.single()

        assertNull(item.barcode)
        assertNull(item.nutrition)
        assertNull(item.allergens)
        assertNull(item.sourceLabel)
        assertEquals("a pinch", item.amount)
    }

    @Test
    fun `sourceLabel credits whichever Open Star Facts database answered`() = runTest {
        assertEquals("Open Food Facts", PantryApi.productSourceLabel("openfoodfacts"))
        assertEquals("Open Beauty Facts", PantryApi.productSourceLabel("openbeautyfacts"))
        assertEquals("Open Products Facts", PantryApi.productSourceLabel("openproductsfacts"))
        assertEquals("Open Pet Food Facts", PantryApi.productSourceLabel("openpetfoodfacts"))
        // A manual/unknown add has nothing to credit.
        assertNull(PantryApi.productSourceLabel("manual"))
        assertNull(PantryApi.productSourceLabel(null))
    }

    // ---- barcode lookup --------------------------------------------------------------

    @Test
    fun `lookup strips non-digits and returns the normalised product`() = runTest {
        harness.enqueueJson(
            """
            {"found":true,"product":{"barcode":"0049000028200","name":"Coke","brand":"Coca-Cola",
             "imageUrl":"https://images.off/1.jpg","quantityText":"330 ml","servingBasis":"per 100 ml",
             "nutrition":{"calories":42},"allergens":[],"traces":[],"dietary":["vegan"],
             "nutriscore":"e","nova":4,"source":"openfoodfacts"}}
            """.trimIndent(),
        )

        val product = api.lookup(" 0049-0000-28200 ")

        assertEquals("/api/pantry/lookup/0049000028200", harness.takeRequest().path)
        assertEquals("Coke", product?.name)
        assertEquals("Open Food Facts", product?.sourceLabel)
        assertEquals(listOf("vegan"), product?.dietary)
        assertEquals(42.0, product?.nutrition?.calories)
    }

    @Test
    fun `a barcode with no digits never reaches the server`() = runTest {
        assertNull(api.lookup("abc"))
        assertEquals(0, harness.requestCount)
    }

    @Test
    fun `an unknown barcode is null — that is a real answer, not a failure`() = runTest {
        harness.enqueueJson("""{"found":false,"barcode":"111"}""", status = 404)

        assertNull(api.lookup("111"))
    }

    @Test
    fun `an unreachable product database THROWS, so the UI can say so`() = runTest {
        // 502 is the server telling us Open Food Facts is down. Collapsing that into
        // "not found" would offer to add an unknown item when the truth is "try again".
        harness.enqueueError(502, "LookupFailed", "Open Food Facts is unreachable — add it manually.")

        val failure = assertFailsWith<WaffledApiException> { api.lookup("111") }
        assertEquals(502, failure.status)
        assertContains(failure.userMessage, "unreachable")
    }

    // ---- creating, scanning, editing ---------------------------------------------------

    @Test
    fun `create posts the body and unwraps the item envelope`() = runTest {
        harness.enqueueJson("""{"item":{"id":"i9","name":"Rice","amount":"1","unit":"","location":"Pantry","note":"","usedUp":false}}""")

        val body = buildJsonObject {
            put("name", JsonPrimitive("Rice"))
            put("amount", JsonPrimitive("1"))
        }
        val item = api.create(body)

        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/pantry", request.path)
        assertContains(request.body.readUtf8(), "\"name\":\"Rice\"")
        assertEquals("i9", item.id)
    }

    @Test
    fun `scan reports whether an existing item was incremented instead of duplicated`() = runTest {
        harness.enqueueJson(
            """{"item":{"id":"i1","name":"Coke","amount":"3","unit":"","location":"Pantry","note":"","usedUp":false},"incremented":true}""",
        )

        val result = api.scan(buildJsonObject { put("name", JsonPrimitive("Coke")) })

        assertEquals("/api/pantry/scan", harness.takeRequest().path)
        assertTrue(result.incremented)
        assertEquals("3", result.item.amount)
    }

    @Test
    fun `update PATCHes and returns the merged item`() = runTest {
        harness.enqueueJson("""{"item":{"id":"i1","name":"Rice","amount":"4","unit":"","location":"Pantry","note":"","usedUp":false}}""")

        val item = api.update("i1", buildJsonObject { put("amount", JsonPrimitive("4")) })

        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/pantry/i1", request.path)
        assertEquals("4", item.amount)
    }

    /**
     * The `explicitNulls = false` trap, on the field where it does the most damage.
     *
     * `WaffledJson` OMITS a null property, so modelling this PATCH as a data class would
     * turn "clear the best-by date" into "leave it alone" — silently, and the user would
     * see the date they just removed come straight back. The body has to be a
     * [kotlinx.serialization.json.JsonObject] carrying an explicit [JsonNull].
     */
    @Test
    fun `clearing the best-by date puts an explicit null on the wire`() = runTest {
        harness.enqueueJson("""{"item":{"id":"i1","name":"Rice","amount":"1","unit":"","location":"Pantry","note":"","usedUp":false}}""")

        api.update("i1", PantryApi.itemBody(name = "Rice", amount = "1", unit = "", location = "Pantry", note = "", expiresOn = null, addedOn = "2026-08-01", lowAt = null, isMeal = false))

        val sent = harness.takeRequest().body.readUtf8()
        assertContains(sent, "\"expiresOn\":null")
        assertContains(sent, "\"lowAt\":null")
    }

    @Test
    fun `a best-by date that IS set rides along as a string`() = runTest {
        harness.enqueueJson("""{"item":{"id":"i1","name":"Rice","amount":"1","unit":"","location":"Pantry","note":"","usedUp":false}}""")

        api.update("i1", PantryApi.itemBody(name = "Rice", amount = "1", unit = "", location = "Pantry", note = "", expiresOn = "2026-09-01", addedOn = "2026-08-01", lowAt = 2.0, isMeal = true))

        val sent = harness.takeRequest().body.readUtf8()
        assertContains(sent, "\"expiresOn\":\"2026-09-01\"")
        assertContains(sent, "\"lowAt\":2")
        assertContains(sent, "\"isMeal\":true")
    }

    @Test
    fun `delete is a 204 with no body`() = runTest {
        harness.enqueueNoContent()

        api.delete("i1")

        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/pantry/i1", request.path)
    }

    @Test
    fun `a failed delete relays the server's own message`() = runTest {
        harness.enqueueError(404, "NotFound", "item not found")

        val failure = assertFailsWith<WaffledApiException> { api.delete("nope") }
        assertEquals("item not found", failure.userMessage)
    }

    // ---- sections ------------------------------------------------------------------------

    @Test
    fun `addLocation appends one section and returns the whole list`() = runTest {
        harness.enqueueJson("""{"locations":["Freezer","Fridge","Garage shelf"],"added":true}""")

        val locations = api.addLocation("Garage shelf")

        val request = harness.takeRequest()
        assertEquals("/api/pantry/locations", request.path)
        assertContains(request.body.readUtf8(), "\"name\":\"Garage shelf\"")
        assertEquals(listOf("Freezer", "Fridge", "Garage shelf"), locations)
    }

    // ---- cook-from-pantry ------------------------------------------------------------------

    @Test
    fun `cookable splits ready recipes from on-hand mains`() = runTest {
        harness.enqueueJson(
            """
            {"ready":[{"recipeId":"r1","title":"Fried rice","emoji":"🍚","have":["Rice","Egg"],
                       "expiringItem":"Spring onion"}],
             "mains":[{"protein":"chicken","item":{"name":"Chicken thighs","amount":"1","unit":"pack",
                       "expiresOn":"2026-08-23"},"count":7,
                       "recipes":[{"recipeId":"r2","title":"Roast chicken","have":4,"total":6,
                                   "missing":["Lemon","Thyme"]}]}]}
            """.trimIndent(),
        )

        val cookable = api.cookable()

        assertEquals("/api/pantry/cookable", harness.takeRequest().path)
        val ready = cookable.ready.single()
        assertEquals("Fried rice", ready.title)
        assertEquals(listOf("Rice", "Egg"), ready.have)
        assertEquals("Spring onion", ready.expiringItem)

        val main = cookable.mains.single()
        assertEquals("chicken", main.protein)
        assertEquals("Chicken thighs", main.item?.name)
        assertEquals(7, main.count)
        assertEquals(listOf("Lemon", "Thyme"), main.recipes.single().missing)
    }

    @Test
    fun `forRecipe returns the server's matches with its suggested action`() = runTest {
        harness.enqueueJson(
            """{"matches":[{"id":"i1","name":"Rice","amount":"2","unit":"bags","isStaple":true,"suggested":"skip"}]}""",
        )

        val matches = api.forRecipe("r1")

        assertEquals("/api/pantry/for-recipe/r1", harness.takeRequest().path)
        val match = matches.single()
        assertTrue(match.isStaple)
        assertEquals("skip", match.suggested)
    }

    @Test
    fun `consume sends id and mode pairs and returns the updated items`() = runTest {
        harness.enqueueJson("""{"items":[{"id":"i1","name":"Rice","amount":"1","unit":"","location":"Pantry","note":"","usedUp":true}]}""")

        val updated = api.consume(listOf("i1" to PantryApi.MODE_USED_UP))

        val request = harness.takeRequest()
        assertEquals("/api/pantry/consume", request.path)
        val sent = request.body.readUtf8()
        assertContains(sent, "\"id\":\"i1\"")
        assertContains(sent, "\"mode\":\"used_up\"")
        assertTrue(updated.single().usedUp)
    }

    @Test
    fun `consume never sends a skipped row`() = runTest {
        harness.enqueueJson("""{"items":[]}""")

        api.consume(listOf("i1" to PantryApi.MODE_SKIP, "i2" to PantryApi.MODE_DECREMENT))

        val sent = harness.takeRequest().body.readUtf8()
        assertFalse(sent.contains("\"i1\""))
        assertContains(sent, "\"i2\"")
    }

    // ---- auth --------------------------------------------------------------------------------

    @Test
    fun `a 401 refreshes once and replays the request`() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"items":[],"locations":[],"showOnToday":true,"avoidAllergens":[],"allergenPeople":{},"lowThreshold":1.0}""")

        val response = api.list()

        assertTrue(response.items.isEmpty())
        assertEquals(1, harness.refreshCount.get())
        assertEquals(2, harness.requestCount)
        harness.takeRequest()
        assertEquals("Bearer refreshed-access-token", harness.takeRequest().getHeader("Authorization"))
    }
}
