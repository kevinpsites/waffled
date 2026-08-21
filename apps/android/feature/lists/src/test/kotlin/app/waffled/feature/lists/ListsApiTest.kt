package app.waffled.feature.lists

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
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
 * The Lists API slice, driven against a real MockWebServer through [ApiTestHarness].
 *
 * The assertions that matter most here are on the **request body**, not the parsed
 * result: `WaffledJson` has `explicitNulls = false`, so a field that must CLEAR has to be
 * proved to be on the wire as `null`. A call that merely succeeds proves nothing about
 * whether the key was silently omitted.
 */
class ListsApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: ListsApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = ListsApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun lastBody(): String = harness.takeRequest().body.readUtf8()

    // ---- the index -------------------------------------------------------------

    @Test
    fun `lists unwraps the envelope and drops templates`() = runTest {
        harness.enqueueJson(
            """{"lists":[
                 {"id":"l1","name":"Groceries","emoji":"🛒","listType":"grocery","itemCount":12},
                 {"id":"l2","name":"Camping gear","emoji":null,"listType":"custom","itemCount":7},
                 {"id":"t1","name":"Packing","emoji":"📑","listType":"template","itemCount":9}
               ]}""",
        )

        val lists = api.lists()

        assertEquals(listOf("l1", "l2"), lists.map { it.id })
        assertEquals(12, lists[0].itemCount)
        assertTrue(lists[0].isGrocery)
        assertEquals("/api/lists", harness.takeRequest().path)
    }

    @Test
    fun `templates come from their own route and envelope`() = runTest {
        harness.enqueueJson("""{"templates":[{"id":"t1","name":"Packing","listType":"template","itemCount":4}]}""")

        val templates = api.templates()

        assertEquals(1, templates.size)
        assertTrue(templates[0].isTemplate)
        assertEquals("/api/lists/templates", harness.takeRequest().path)
    }

    /**
     * The create reply is bare `presentList(...)` with **no** `itemCount`. A required
     * field there silently turned "create a list then open it" into a no-op.
     */
    @Test
    fun `createList decodes a reply that carries no itemCount`() = runTest {
        harness.enqueueJson("""{"list":{"id":"new","name":"Camping gear","emoji":"⛺","listType":"custom"}}""")

        val created = api.createList("Camping gear", "⛺")

        assertEquals("new", created.id)
        assertEquals(0, created.itemCount)
        val req = harness.takeRequest()
        assertEquals("/api/lists", req.path)
        assertContains(req.body.readUtf8(), """"emoji":"⛺"""")
    }

    /** No emoji has to reach the server as an explicit null, not as a missing key. */
    @Test
    fun `createList sends an explicit null emoji when none was picked`() = runTest {
        harness.enqueueJson("""{"list":{"id":"new","name":"Hardware run","listType":"custom"}}""")

        api.createList("Hardware run", null)

        assertContains(lastBody(), """"emoji":null""")
    }

    /** Clearing the emoji is the canonical `explicitNulls = false` trap on this screen. */
    @Test
    fun `updateList clears the emoji with a null on the wire`() = runTest {
        harness.enqueueJson("""{"list":{"id":"l2","name":"Camping gear","emoji":null,"listType":"custom"}}""")

        api.updateList("l2", name = "Camping gear", emoji = Field.Set(""))

        val req = harness.takeRequest()
        assertEquals("/api/lists/l2", req.path)
        val body = req.body.readUtf8()
        assertContains(body, """"emoji":null""")
        assertContains(body, """"name":"Camping gear"""")
    }

    /** An untouched emoji must NOT be sent — absent means "leave whatever is there". */
    @Test
    fun `updateList omits the emoji key when it was not touched`() = runTest {
        harness.enqueueJson("""{"list":{"id":"l2","name":"Renamed","emoji":"⛺","listType":"custom"}}""")

        api.updateList("l2", name = "Renamed")

        assertFalse(lastBody().contains("emoji"))
    }

    @Test
    fun `deleteList tolerates an empty 204`() = runTest {
        harness.enqueueJson("", status = 204)

        api.deleteList("l2")

        val req = harness.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/lists/l2", req.path)
    }

    @Test
    fun `template conversion routes unwrap their own envelopes`() = runTest {
        harness.enqueueJson("""{"template":{"id":"l2","name":"Camping gear","listType":"template"}}""")
        assertTrue(api.saveAsTemplate("l2").isTemplate)
        assertEquals("/api/lists/l2/save-as-template", harness.takeRequest().path)

        harness.enqueueJson("""{"list":{"id":"l2","name":"Camping gear","listType":"custom"}}""")
        assertFalse(api.unmarkTemplate("l2").isTemplate)
        assertEquals("/api/lists/l2/unmark-template", harness.takeRequest().path)

        harness.enqueueJson("""{"list":{"id":"l9","name":"Beach trip","listType":"custom"}}""")
        assertEquals("l9", api.applyTemplate("t1", "Beach trip").id)
        val req = harness.takeRequest()
        assertEquals("/api/lists/templates/t1/apply", req.path)
        assertContains(req.body.readUtf8(), """"name":"Beach trip"""")
    }

    // ---- items -----------------------------------------------------------------

    @Test
    fun `items decodes a plain list row that omits the board-only fields`() = runTest {
        harness.enqueueJson(
            """{"items":[{"id":"i1","name":"Sunscreen","quantity":null,"checked":false,
                 "section":"Toiletries","store":null,"priority":3,"source":"manual"}]}""",
        )

        val rows = api.items("l2")

        assertEquals(1, rows.size)
        assertEquals("Toiletries", rows[0].section)
        assertNull(rows[0].pantry)
        assertNull(rows[0].aisle)
        assertEquals("manual", rows[0].source)
        assertEquals("/api/lists/l2", harness.takeRequest().path)
    }

    @Test
    fun `addItem maps section onto the server's category field`() = runTest {
        harness.enqueueJson("""{"item":{"id":"i9","name":"Tent pegs","checked":false}}""")

        api.addItem("l2", name = "Tent pegs", quantity = "8", section = "Gear", store = "  ")

        val req = harness.takeRequest()
        assertEquals("/api/lists/l2/items", req.path)
        val body = req.body.readUtf8()
        assertContains(body, """"category":"Gear"""")
        assertContains(body, """"quantity":"8"""")
        // A blank store is not a store — it must not be sent at all on a create.
        assertFalse(body.contains("store"))
    }

    @Test
    fun `addGroceryItem uses grocery's own create route`() = runTest {
        harness.enqueueJson("""{"item":{"id":"i9","name":"Milk","checked":false}}""")

        api.addGroceryItem("Milk", quantity = "1 gal")

        assertEquals("/api/lists/grocery/items", harness.takeRequest().path)
    }

    /** Ticking a row off is the single most-used write on the screen. */
    @Test
    fun `patchItem sends only the fields it was given`() = runTest {
        harness.enqueueJson("", status = 204)

        api.patchItem("i1", checked = true)

        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/list-items/i1", req.path)
        assertEquals("""{"checked":true}""", req.body.readUtf8())
    }

    /**
     * The `explicitNulls = false` trap, on the field it bites hardest: emptying the
     * quantity has to CLEAR it, and a dropped key would leave the old value in place.
     */
    @Test
    fun `patchItem clears an emptied quantity with an explicit null`() = runTest {
        harness.enqueueJson("", status = 204)

        api.patchItem("i1", quantity = Field.Set(""))

        assertEquals("""{"quantity":null}""", lastBody())
    }

    @Test
    fun `patchItem clears the section and the store with explicit nulls`() = runTest {
        harness.enqueueJson("", status = 204)

        api.patchItem("i1", section = Field.Set(null), store = Field.Set("  "))

        val body = lastBody()
        assertContains(body, """"category":null""")
        assertContains(body, """"store":null""")
    }

    /** Absent is not the same as null — an untouched store must not be cleared. */
    @Test
    fun `patchItem leaves an absent field off the wire entirely`() = runTest {
        harness.enqueueJson("", status = 204)

        api.patchItem("i1", name = "Whole milk")

        val body = lastBody()
        assertEquals("""{"name":"Whole milk"}""", body)
        assertFalse(body.contains("store"))
        assertFalse(body.contains("category"))
    }

    /** Nothing to say means no request at all, not an empty PATCH. */
    @Test
    fun `patchItem with nothing set makes no request`() = runTest {
        api.patchItem("i1")
        assertEquals(0, harness.requestCount)
    }

    /**
     * The Details editor's contract is "what you see is what the row becomes", so every
     * emptied field clears — all five nulls have to be on the wire.
     */
    @Test
    fun `updateItemDetails always sends every field, nulls included`() = runTest {
        harness.enqueueJson("", status = 204)

        api.updateItemDetails(
            id = "i1",
            name = "Milk",
            quantity = "",
            assignedTo = null,
            section = "",
            store = "",
            priority = 3,
        )

        val body = lastBody()
        assertContains(body, """"quantity":null""")
        assertContains(body, """"assignedTo":null""")
        assertContains(body, """"category":null""")
        assertContains(body, """"store":null""")
        assertContains(body, """"priority":3""")
    }

    @Test
    fun `bulkPatchItems nests the patch and can unassign the whole selection`() = runTest {
        harness.enqueueJson("", status = 204)

        api.bulkPatchItems(listOf("i1", "i2"), assignedTo = Field.Set(null), priority = 5)

        val req = harness.takeRequest()
        assertEquals("/api/list-items/bulk", req.path)
        val body = req.body.readUtf8()
        assertContains(body, """"ids":["i1","i2"]""")
        assertContains(body, """"assignedTo":null""")
        assertContains(body, """"priority":5""")
    }

    @Test
    fun `bulkPatchItems does nothing with no ids or an empty patch`() = runTest {
        api.bulkPatchItems(emptyList(), assignedTo = Field.Set("p1"))
        api.bulkPatchItems(listOf("i1"))
        assertEquals(0, harness.requestCount)
    }

    @Test
    fun `deleteItem and clearCompleted hit their routes`() = runTest {
        harness.enqueueJson("", status = 204)
        api.deleteItem("i1")
        assertEquals("/api/list-items/i1", harness.takeRequest().path)

        harness.enqueueJson("", status = 204)
        api.clearCompleted("l2")
        assertEquals("/api/lists/l2/clear-completed", harness.takeRequest().path)
    }

    @Test
    fun `stores unwraps the quick-select list`() = runTest {
        harness.enqueueJson("""{"stores":["Costco","Aldi"]}""")

        assertEquals(listOf("Costco", "Aldi"), api.stores())
        assertEquals("/api/lists/stores", harness.takeRequest().path)
    }

    // ---- the grocery board -----------------------------------------------------

    @Test
    fun `groceryBoard decodes plates, off-plan recipes, staples and pantry hits`() = runTest {
        harness.enqueueJson(
            """{"weekStart":"2026-08-16",
                "meals":[{"recipeId":null,"mealId":"m1","title":"BBQ Sunday","emoji":null,
                          "color":"#2F7FED","date":"2026-08-17","mealType":"dinner",
                          "recipes":[{"recipeId":"d1","title":"Ribs","emoji":null,"role":"main"}]}],
                "unscheduled":[{"recipeId":"r9","title":"Guacamole","emoji":"🥑","color":"#8B5CF6"}],
                "unscheduledMeals":[{"mealId":"m2","name":"Taco Tuesday","color":"#8B5CF6",
                                     "recipes":[{"recipeId":"d9","title":"Carnitas","emoji":null,"role":"main"}]}],
                "items":[{"id":"i1","name":"Eggs","quantity":"12","checked":false,
                          "section":"Dairy & Chilled","aisle":"Dairy & Chilled","priority":3,
                          "source":"auto","sourceRecipeIds":["d1"],"weekStart":"2026-08-16",
                          "pantry":{"name":"Free-range eggs","amount":"6","unit":""}}],
                "staples":[{"id":"s1","name":"Soy sauce"}]}""",
        )

        val board = api.groceryBoard()

        assertEquals("2026-08-16", board.weekStart)
        assertEquals(listOf("d1"), board.meals[0].contributingRecipeIds)
        assertEquals("Taco Tuesday", board.unscheduledMeals[0].name)
        assertEquals("Guacamole", board.unscheduled[0].title)
        assertEquals("Free-range eggs", board.items[0].pantry?.name)
        assertEquals("auto", board.items[0].source)
        assertEquals("Soy sauce", board.staples[0].name)
        // No weekStart asked for: the SERVER picks the week.
        assertEquals("/api/lists/grocery/board", harness.takeRequest().path)
    }

    /** A board from an older server that omits the newer collections must still decode. */
    @Test
    fun `groceryBoard tolerates a payload with only the oldest fields`() = runTest {
        harness.enqueueJson("""{"weekStart":"2026-08-16","meals":[],"items":[],"staples":[]}""")

        val board = api.groceryBoard()

        assertTrue(board.unscheduled.isEmpty())
        assertTrue(board.unscheduledMeals.isEmpty())
    }

    @Test
    fun `groceryBoard passes through the week it was asked for verbatim`() = runTest {
        harness.enqueueJson("""{"weekStart":"2026-08-23"}""")

        api.groceryBoard("2026-08-23")

        assertEquals("/api/lists/grocery/board?weekStart=2026-08-23", harness.takeRequest().path)
    }

    @Test
    fun `rebuild and clear-checks unwrap the board envelope`() = runTest {
        harness.enqueueJson("""{"board":{"weekStart":"2026-08-16","items":[]}}""")
        assertEquals("2026-08-16", api.rebuildGrocery("2026-08-16").weekStart)
        assertEquals("/api/lists/grocery/rebuild?weekStart=2026-08-16", harness.takeRequest().path)

        harness.enqueueJson("""{"board":{"weekStart":"2026-08-16","items":[]}}""")
        api.clearGroceryChecks("2026-08-16")
        assertEquals("/api/lists/grocery/clear-checks?weekStart=2026-08-16", harness.takeRequest().path)
    }

    @Test
    fun `removing a recipe or a plate reports how many rows went`() = runTest {
        harness.enqueueJson("""{"removed":3}""")
        assertEquals(3, api.removeRecipeFromGrocery("r9", "2026-08-16"))
        val a = harness.takeRequest()
        assertEquals("DELETE", a.method)
        assertEquals("/api/lists/grocery/from-recipe/r9?weekStart=2026-08-16", a.path)

        harness.enqueueJson("""{"removed":2}""")
        assertEquals(2, api.removeMealFromGrocery("m2"))
        assertEquals("/api/meals/m2/add-to-list", harness.takeRequest().path)
    }

    // ---- pantry staples --------------------------------------------------------

    @Test
    fun `pantry staples round-trip`() = runTest {
        harness.enqueueJson("""{"staples":[{"id":"s1","name":"Soy sauce"}]}""")
        assertEquals("Soy sauce", api.pantryStaples()[0].name)
        assertEquals("/api/pantry-staples", harness.takeRequest().path)

        harness.enqueueJson("""{"staple":{"id":"s2","name":"Olive oil"}}""")
        assertEquals("s2", api.addPantryStaple("Olive oil").id)
        assertContains(harness.takeRequest().body.readUtf8(), """"name":"Olive oil"""")

        harness.enqueueJson("", status = 204)
        api.removePantryStaple("s2")
        assertEquals("/api/pantry-staples/s2", harness.takeRequest().path)
    }

    // ---- auth + errors ---------------------------------------------------------

    /** A 401 refreshes once and replays — not once per call site. */
    @Test
    fun `a 401 refreshes once and replays the request`() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"Groceries","listType":"grocery"}]}""")

        val lists = api.lists()

        assertEquals(1, lists.size)
        assertEquals(1, harness.refreshCount.get())
        assertEquals(2, harness.requestCount)
    }

    /** Errors relay what the SERVER said — it knows why the request failed and we don't. */
    @Test
    fun `a failure surfaces the server's own message`() = runTest {
        harness.enqueueError(409, "ListConflict", "Grocery lists can't be turned into templates.")

        val e = assertFailsWith<WaffledApiException> { api.saveAsTemplate("grocery") }

        assertEquals(409, e.status)
        assertEquals("Grocery lists can't be turned into templates.", e.userMessage)
    }
}
