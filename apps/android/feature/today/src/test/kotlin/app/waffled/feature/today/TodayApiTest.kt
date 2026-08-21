package app.waffled.feature.today

import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Today API slice, driven against a real MockWebServer via the shared
 * [ApiTestHarness] — the envelopes each Today card unwraps, the layout write's wire
 * shape, and the 401 → refresh → replay path.
 */
class TodayApiTest {

    private val harness = ApiTestHarness()
    private lateinit var api: TodayApi

    @BeforeTest
    fun setUp() {
        harness.start()
        api = TodayApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens)
    }

    @AfterTest
    fun tearDown() = harness.stop()

    // ---- the card reads ---------------------------------------------------------

    @Test
    fun mealsWeekUnwrapsEntriesAndPassesTheStartDate() = runTest {
        harness.enqueueJson(
            """{"entries":[{"id":"e1","date":"2026-07-16","mealType":"dinner","title":"Tacos",
               "recipe":{"title":"Tacos","emoji":"🌮","cookTimeMinutes":25,"servings":4}}]}""",
        )
        val entries = api.mealsWeek("2026-07-16")
        assertEquals(1, entries.size)
        assertEquals("🌮", entries.first().recipe?.emoji)
        assertEquals("/api/meals/week?start=2026-07-16", harness.takeRequest().path)
    }

    /**
     * A plate-backed slot carries `meal.recipes`; an entry whose plate was soft-deleted
     * serialises `name: null`. Non-nullable, that one row throws and takes the WHOLE
     * fetch with it — blanking the Tonight card.
     */
    @Test
    fun mealsWeekDecodesAPlateWithANullName() = runTest {
        harness.enqueueJson(
            """{"entries":[{"id":"e1","date":"2026-07-16","mealType":"dinner","mealId":"m1",
               "meal":{"id":"m1","name":null,"servings":6,
                 "recipes":[{"recipeId":"r1","title":"Ribs","role":"main","sortOrder":0}]}}]}""",
        )
        val entry = api.mealsWeek("2026-07-16").single()
        assertNull(entry.meal?.name)
        assertEquals(1, entry.meal?.recipes?.size)
    }

    /** An unknown field from a newer server must not break the decode. */
    @Test
    fun unknownFieldsAreIgnored() = runTest {
        harness.enqueueJson("""{"entries":[{"id":"e1","date":"d","mealType":"dinner","brandNew":42}]}""")
        assertEquals("e1", api.mealsWeek("d").single().id)
    }

    @Test
    fun choresTodayUnwrapsPeople() = runTest {
        harness.enqueueJson("""{"people":[{"id":"p1","name":"June","total":3,"done":1,"stars":1}]}""")
        assertEquals("June", api.choresToday().single().name)
        assertEquals("/api/chores/today", harness.takeRequest().path)
    }

    @Test
    fun groceryItemsUnwrapsItems() = runTest {
        harness.enqueueJson("""{"items":[{"id":"a","checked":false},{"id":"b","checked":true}]}""")
        assertEquals(2, api.groceryItems().size)
        assertEquals("/api/lists/grocery", harness.takeRequest().path)
    }

    @Test
    fun goalsUnwrapsGoals() = runTest {
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Read 10 books","target":10,"totalProgress":4}]}""")
        val goal = api.goals().single()
        assertEquals("Read 10 books", goal.title)
        assertEquals(4.0, goal.totalProgress)
        assertEquals("/api/goals", harness.takeRequest().path)
    }

    @Test
    fun recapAndSuggestionsUnwrapItems() = runTest {
        harness.enqueueJson("""{"items":[{"eventId":"e1","occurrenceDate":"2026-07-16","title":"Run","goalId":"g1","goalTitle":"Miles"}]}""")
        assertEquals("Run", api.goalRecap().single().title)
        assertEquals("/api/goal-calendar/recap", harness.takeRequest().path)

        harness.enqueueJson("""{"items":[{"eventId":"e2","title":"Swim","goalId":"g1","goalTitle":"Miles"}]}""")
        assertEquals("Swim", api.goalSuggestions().single().title)
        assertEquals("/api/goal-calendar/suggestions", harness.takeRequest().path)
    }

    @Test
    fun weatherDecodesAnUnconfiguredHousehold() = runTest {
        harness.enqueueJson("""{"configured":false}""")
        val w = api.weather()
        assertEquals(false, w.configured)
        assertNull(w.tempF)
        assertEquals("/api/weather", harness.takeRequest().path)
    }

    // ---- the MOBILE layout — never the web one ---------------------------------

    /**
     * Web and mobile keep SEPARATE layouts (the web's is 3-column and reorder-only).
     * Reading or writing `/api/today-layout/web` from here would silently reshape the
     * other platform's home screen.
     */
    @Test
    fun layoutReadsTheMobileTier() = runTest {
        harness.enqueueJson(
            """{"resolved":{"order":["agenda","tonight"],"hidden":["goals"]},
                "source":"user","cards":["agenda","tonight","goals"],"canEditFamily":true}""",
        )
        val resp = api.todayLayout()
        assertEquals(listOf("agenda", "tonight"), resp.resolved.order)
        assertEquals(listOf("goals"), resp.resolved.hidden)
        assertTrue(resp.canEditFamily)
        assertEquals("/api/today-layout/mobile", harness.takeRequest().path)
    }

    /** The save body is `{scope, layout:{order, hidden}}` — nested, not flat. */
    @Test
    fun savingTheLayoutSendsTheNestedBody() = runTest {
        harness.enqueueJson("""{"ok":true}""")
        api.saveTodayLayout(scope = "family", order = listOf("agenda", "chores"), hidden = listOf("goals"))

        val request = harness.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/today-layout/mobile", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("family", body["scope"]?.jsonPrimitive?.content)
        val layout = body["layout"]!!.jsonObject
        assertEquals(
            listOf("agenda", "chores"),
            layout["order"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals(listOf("goals"), layout["hidden"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    /** Reset drops a tier back to inheriting — the scope rides in the query string. */
    @Test
    fun resettingTheLayoutDeletesTheScope() = runTest {
        harness.enqueueJson("", status = 204)
        api.resetTodayLayout("user")
        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/today-layout/mobile?scope=user", request.path)
    }

    // ---- auth -------------------------------------------------------------------

    /**
     * A 401 refreshes ONCE and replays. The refresh is handed the token the failed
     * request actually sent, so a staggered second 401 doesn't burn another rotation.
     */
    @Test
    fun anExpiredTokenRefreshesOnceAndReplays() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"people":[{"id":"p1","name":"June","total":1,"done":0,"stars":0}]}""")

        assertEquals("June", api.choresToday().single().name)
        assertEquals(1, harness.refreshCount.get())
        harness.takeRequest()
        assertEquals("Bearer refreshed-access-token", harness.takeRequest().getHeader("Authorization"))
    }

    /** A dead session surfaces the SERVER's message rather than a guess. */
    @Test
    fun aServerErrorRelaysItsMessage() = runTest {
        harness.refreshedToken = null
        harness.enqueueError(403, "Forbidden", "Device token required")
        val failure = runCatching { api.choresToday() }.exceptionOrNull()
        assertTrue(failure?.message?.contains("Device token required") == true, "got: ${failure?.message}")
    }
}
