package app.waffled.feature.meals

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Cook from your pantry's "Plan" on a ready-to-eat item: iOS writes a free-text night
 * named for the item (`setMealPlan(date:mealType:recipeId: nil, title:)`), and Meals owns
 * that write.
 */
class PlanLeftoverModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: MealsApi
    private lateinit var bus: RefreshBus

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = MealsApi(client, harness.tokens)
        bus = RefreshBus()
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    @Test
    fun `planning a leftover writes a free-text night named for it`() = runTest {
        harness.enqueueJson("""{"entry":{"id":"e"}}""")
        val model = PlanLeftoverModel(api, title = "  Chili  ", refreshBus = bus)

        val ok = model.plan(LocalDate.of(2026, 10, 8), "lunch")

        assertTrue(ok)
        val request = harness.takeRequest()
        assertEquals("/api/meals/plan", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("2026-10-08", body["date"]?.jsonPrimitive?.content)
        assertEquals("lunch", body["mealType"]?.jsonPrimitive?.content)
        assertEquals("Chili", body["title"]?.jsonPrimitive?.content)
        assertNull(body["recipeId"], "a leftover is not a recipe")
        assertEquals(1, bus.revisionOf(RefreshDomain.Meals))
    }

    @Test
    fun `a refused plan says so and tells nobody`() = runTest {
        harness.enqueueError(400, "BadRequest", "date must be a YYYY-MM-DD date")
        val model = PlanLeftoverModel(api, title = "Chili", refreshBus = bus)

        assertFalse(model.plan(LocalDate.of(2026, 10, 8), "dinner"))
        assertEquals("date must be a YYYY-MM-DD date", model.error.value)
        assertEquals(0, bus.revisionOf(RefreshDomain.Meals))
    }

    @Test
    fun `the day choices run a week from today`() {
        val days = PlanLeftoverModel.dayChoices(LocalDate.of(2026, 10, 7))
        assertEquals(7, days.size)
        assertEquals(LocalDate.of(2026, 10, 7), days.first())
        assertEquals(LocalDate.of(2026, 10, 13), days.last())
    }
}
