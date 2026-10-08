package app.waffled.feature.meals

import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MealsApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: MealsApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = MealsApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun lastBody(): String = harness.takeRequest().body.readUtf8()

    // ---- reads -----------------------------------------------------------------

    @Test
    fun `mealsWeek unwraps the envelope and passes the window through`() = runTest {
        harness.enqueueJson(
            """{"entries":[
                 {"id":"e1","date":"2026-07-13","mealType":"dinner","recipeId":"r1",
                  "recipe":{"title":"Tacos","emoji":"🌮","cookTimeMinutes":25}}
               ]}""",
        )

        val entries = api.mealsWeek("2026-07-13", days = 42)

        assertEquals(listOf("e1"), entries.map { it.id })
        assertEquals("Tacos", entries.first().displayTitle)
        val req = harness.takeRequest()
        assertEquals("GET", req.method)
        assertContains(req.path.orEmpty(), "start=2026-07-13")
        assertContains(req.path.orEmpty(), "days=42")
    }

    /** Omitting the window must not send `days` at all — the server's default is 7. */
    @Test
    fun `mealsWeek omits days when no window is asked for`() = runTest {
        harness.enqueueJson("""{"entries":[]}""")
        api.mealsWeek("2026-07-13")
        assertFalse(harness.takeRequest().path.orEmpty().contains("days"))
    }

    /**
     * An entry pointing at a soft-deleted plate serialises `meal.name: null`. If that one
     * row failed to decode it would take the WHOLE week with it, blanking the grid.
     */
    @Test
    fun `a plate-backed entry with a deleted plate still decodes`() = runTest {
        harness.enqueueJson(
            """{"entries":[
                 {"id":"e1","date":"2026-07-13","mealType":"dinner","title":"BBQ Sunday",
                  "mealId":"m1","meal":{"id":"m1","name":null,"recipes":[]}}
               ]}""",
        )
        val e = api.mealsWeek("2026-07-13").single()
        assertTrue(e.isMealBacked)
        // No plate name left, so the free-text title is what shows.
        assertEquals("BBQ Sunday", e.displayTitle)
    }

    @Test
    fun `savedMeals unwraps the envelope and url-encodes the query`() = runTest {
        harness.enqueueJson("""{"meals":[{"id":"m1","name":"BBQ Sunday","servings":6}]}""")

        val meals = api.savedMeals(q = "bbq sunday", limit = 20)

        assertEquals(listOf("m1"), meals.map { it.id })
        val path = harness.takeRequest().path.orEmpty()
        assertContains(path, "/api/meals?")
        assertContains(path, "limit=20")
        assertFalse(path.contains("bbq sunday")) // a raw space would be an invalid URL
    }

    @Test
    fun `meal fetches one plate by id`() = runTest {
        harness.enqueueJson("""{"meal":{"id":"m1","name":"BBQ Sunday","recipeCount":2}}""")
        assertEquals("BBQ Sunday", api.meal("m1").name)
        assertEquals("/api/meals/m1", harness.takeRequest().path)
    }

    // ---- planning one slot ------------------------------------------------------

    /**
     * `POST /api/meals/plan` is a FULL upsert: every key it does not receive is written
     * as null. So a recipe-backed write must NOT carry a title — otherwise the free text
     * survives alongside the recipe.
     */
    @Test
    fun `a recipe-backed write sends the id and no title`() = runTest {
        harness.enqueueJson("""{"entry":{"id":"e1","date":"2026-07-13","mealType":"dinner"}}""")

        api.planMeal(date = "2026-07-13", mealType = "dinner", recipeId = "r1")

        val req = harness.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/meals/plan", req.path)
        val body = req.body.readUtf8()
        assertContains(body, """"recipeId":"r1"""")
        assertFalse(body.contains("title"))
        assertFalse(body.contains("mealId"))
    }

    /**
     * The reverse: replacing a recipe night with free text must send NO `recipeId`, so
     * the upsert nulls the old recipe out. Sending both is what made a picked recipe land
     * as a plain string.
     */
    @Test
    fun `a free-text write sends the words and no recipeId`() = runTest {
        harness.enqueueJson("""{"entry":{"id":"e1","date":"2026-07-13","mealType":"dinner"}}""")

        api.planMeal(date = "2026-07-13", mealType = "dinner", title = "Eating out")

        val body = lastBody()
        assertContains(body, """"title":"Eating out"""")
        assertFalse(body.contains("recipeId"))
    }

    /**
     * A plate-backed write sends `mealId` and no title: the server rejects `recipeId` +
     * `mealId` together with a 400, and sending the plate's NAME as a title would freeze
     * it in the row, so renaming the plate would stop showing here.
     */
    @Test
    fun `a plate-backed write sends the mealId alone`() = runTest {
        harness.enqueueJson("""{"entry":{"id":"e1","date":"2026-07-13","mealType":"dinner"}}""")

        api.planMeal(date = "2026-07-13", mealType = "dinner", mealId = "m1", cookPersonId = "p1")

        val body = lastBody()
        assertContains(body, """"mealId":"m1"""")
        assertContains(body, """"cookPersonId":"p1"""")
        assertFalse(body.contains("recipeId"))
        assertFalse(body.contains(""""title""""))
    }

    @Test
    fun `clearMeal deletes the slot by date and mealType`() = runTest {
        harness.enqueueJson("", status = 204)

        api.clearMeal("2026-07-13", "dinner")

        val req = harness.takeRequest()
        assertEquals("DELETE", req.method)
        assertContains(req.path.orEmpty(), "date=2026-07-13")
        assertContains(req.path.orEmpty(), "mealType=dinner")
    }

    /**
     * Clearing a slot that was already empty answers 404. That is the normal outcome of
     * a move onto an empty night's compensation, so it must not read as a failure.
     */
    @Test
    fun `clearing an already-empty slot is not an error`() = runTest {
        harness.enqueueError(404, "NotFound", "Nothing planned there")
        api.clearMeal("2026-07-13", "dinner") // must not throw
    }

    // ---- executing a planned write ---------------------------------------------

    /** A move's Op carries a whole entry; the API decides what of it goes on the wire. */
    @Test
    fun `performing a move op sends the entry's recipe and cook`() = runTest {
        harness.enqueueJson("""{"entry":{"id":"e1","date":"2026-07-15","mealType":"dinner"}}""")

        api.perform(
            MealPlanSwap.Op(
                date = "2026-07-15", mealType = "dinner",
                entry = WeekEntryDTO(
                    id = "e1", date = "2026-07-13", mealType = "dinner",
                    title = "Tacos", recipeId = "r1",
                    cook = WeekCookDTO(personId = "p1", name = "Jerry"),
                ),
            ),
        )

        val body = lastBody()
        assertContains(body, """"recipeId":"r1"""")
        assertContains(body, """"cookPersonId":"p1"""")
        // Recipe-backed, so the stale free-text title must not ride along.
        assertFalse(body.contains(""""title""""))
    }

    @Test
    fun `performing a move op with a null entry clears the slot`() = runTest {
        harness.enqueueJson("", status = 204)
        api.perform(MealPlanSwap.Op("2026-07-13", "dinner", entry = null))
        assertEquals("DELETE", harness.takeRequest().method)
    }

    @Test
    fun `performing an apply op routes set, clear and rebuild`() = runTest {
        harness.enqueueJson("""{"entry":{"id":"e1","date":"2026-09-02","mealType":"dinner"}}""")
        harness.enqueueJson("", status = 204)
        harness.enqueueJson("""{"board":{"weekStart":"2026-08-30"}}""")

        api.perform(MealPlanApply.Op.Set("2026-09-02", "dinner", recipeId = "r1"))
        api.perform(MealPlanApply.Op.Clear("2026-09-16", "dinner"))
        api.perform(MealPlanApply.Op.Rebuild("2026-08-30"))

        assertEquals("POST", harness.takeRequest().method)
        assertEquals("DELETE", harness.takeRequest().method)
        val rebuild = harness.takeRequest()
        assertEquals("POST", rebuild.method)
        assertContains(rebuild.path.orEmpty(), "/api/lists/grocery/rebuild")
        assertContains(rebuild.path.orEmpty(), "weekStart=2026-08-30")
    }

    // ---- drafting ---------------------------------------------------------------

    @Test
    fun `planWeek sends the guardrails and omits the empty ones`() = runTest {
        harness.enqueueJson("""{"start":"2026-07-13","mealType":"dinner","suggestions":[],"via":"anthropic"}""")

        val result = api.planWeek(
            start = "2026-07-13", mealType = "dinner",
            dates = listOf("2026-07-13"), cookingFor = null,
            keepInMind = "", useUp = emptyList(), avoidTitles = listOf("Tacos"),
            wantToTry = null, trySomethingNew = null,
        )

        assertEquals("anthropic", result.via)
        val body = lastBody()
        assertContains(body, """"start":"2026-07-13"""")
        assertContains(body, """"avoidTitles":["Tacos"]""")
        // Omitted so the server applies its own defaults rather than being told "none".
        assertFalse(body.contains("cookingFor"))
        assertFalse(body.contains("keepInMind"))
        assertFalse(body.contains("useUp"))
        assertFalse(body.contains("trySomethingNew"))
    }

    /**
     * A runtime provider failure comes back as a 200 with `error` set and no suggestions —
     * it must decode, not throw, so the sheet can show the provider's own words.
     */
    @Test
    fun `a provider failure decodes as a result with an error`() = runTest {
        harness.enqueueJson("""{"start":"2026-07-13","mealType":"dinner","suggestions":[],"error":"AIUnavailable"}""")
        val result = api.planWeek(
            start = "2026-07-13", mealType = "dinner", dates = null, cookingFor = null,
            keepInMind = null, useUp = null, avoidTitles = null,
            wantToTry = null, trySomethingNew = null,
        )
        assertEquals("AIUnavailable", result.error)
        assertTrue(result.suggestions.isEmpty())
    }

    @Test
    fun `planMonth always sends the rotation guardrails`() = runTest {
        harness.enqueueJson("""{"start":"2026-09-01","mealType":"dinner","suggestions":[],"existing":[]}""")

        api.planMonth(
            start = "2026-09-01", weekdays = listOf(1, 2, 3, 4, 5), skipDates = null, dates = null,
            cookingFor = 4, keepInMind = null, useUp = null, avoidTitles = null,
            allowRepeats = true, repeatGapDays = 7, weekdayThemes = mapOf("1" to "meatless"),
            weeknightMaxMin = null, leftovers = false,
        )

        val body = lastBody()
        assertContains(body, """"weekdays":[1,2,3,4,5]""")
        assertContains(body, """"cookingFor":4""")
        // allowRepeats / repeatGapDays / leftovers are unconditional, so `false` really
        // means false rather than "the server decides".
        assertContains(body, """"allowRepeats":true""")
        assertContains(body, """"repeatGapDays":7""")
        assertContains(body, """"leftovers":false""")
        assertContains(body, """"weekdayThemes":{"1":"meatless"}""")
        assertFalse(body.contains("weeknightMaxMin"))
    }

    @Test
    fun `an existing-nights month result decodes both lists`() = runTest {
        harness.enqueueJson(
            """{"start":"2026-09-01","mealType":"dinner",
                "suggestions":[{"date":"2026-09-02","mealType":"dinner","title":"New"}],
                "existing":[{"date":"2026-09-09","mealType":"dinner","title":"Old"}]}""",
        )
        val r = api.planMonth(
            start = "2026-09-01", weekdays = null, skipDates = null, dates = null,
            cookingFor = null, keepInMind = null, useUp = null, avoidTitles = null,
            allowRepeats = false, repeatGapDays = 7, weekdayThemes = null,
            weeknightMaxMin = null, leftovers = false,
        )
        assertEquals(listOf("2026-09-02"), r.suggestions.map { it.date })
        assertEquals(listOf("2026-09-09"), r.existing.map { it.date })
    }

    // ---- plate actions ----------------------------------------------------------

    @Test
    fun `addMealToGrocery returns how many rows were added`() = runTest {
        harness.enqueueJson("""{"added":3}""")
        assertEquals(3, api.addMealToGrocery("m1"))
        assertEquals("/api/meals/m1/add-to-list", harness.takeRequest().path)
    }

    @Test
    fun `scheduleMeal posts the target slot`() = runTest {
        harness.enqueueJson("""{"entry":{"id":"e1","date":"2026-07-13","mealType":"dinner"},"meal":{"id":"m1"}}""")

        api.scheduleMeal("m1", date = "2026-07-13", mealType = "dinner")

        val req = harness.takeRequest()
        assertEquals("/api/meals/m1/schedule", req.path)
        assertContains(req.body.readUtf8(), """"date":"2026-07-13"""")
    }

    // ---- auth -------------------------------------------------------------------

    /**
     * A single 401 rotates the token once and replays the request — passing the token the
     * failed request actually sent is what stops a staggered 401 burning a second
     * rotation of a single-use refresh token.
     */
    @Test
    fun `a 401 refreshes once and replays the request`() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"entries":[]}""")

        assertTrue(api.mealsWeek("2026-07-13").isEmpty())

        assertEquals(1, harness.refreshCount.get())
        assertEquals(2, harness.requestCount)
    }

    @Test
    fun `a server error surfaces the server's own message`() = runTest {
        harness.enqueueError(400, "BadRequest", "a slot takes recipeId or mealId, not both")
        val failure = runCatching { api.planMeal("2026-07-13", "dinner", recipeId = "r1") }.exceptionOrNull()
        assertEquals("a slot takes recipeId or mealId, not both", failure?.message)
    }

    /** A failed week fetch must not blank the grid — the caller keeps what it has. */
    @Test
    fun `mealsWeekOrNull answers null on failure rather than throwing`() = runTest {
        harness.enqueueError(500, "ServerError")
        assertNull(api.mealsWeekOrNull("2026-07-13"))
    }
}
