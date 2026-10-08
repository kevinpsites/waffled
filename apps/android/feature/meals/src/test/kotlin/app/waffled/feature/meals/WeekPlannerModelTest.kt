package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The week planner's move, driven end to end against a fake server.
 *
 * The pure math is pinned in [MealPlanSwapWritesTest]; what this adds is that the model
 * actually ISSUES those writes in that order, and that a failure lands the user in the
 * right state rather than a plausible-looking wrong one.
 */
class WeekPlannerModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private var firstDay: HouseholdWeekStart? = HouseholdWeekStart.Sunday
    private lateinit var model: WeekPlannerModel

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        model = WeekPlannerModel(
            api = MealsApi(client, harness.tokens),
            zone = ZoneId.of("UTC"),
            locale = Locale.US,
            firstDay = { firstDay },
            // Pinned so the fixture week can't rot as the real date moves on. A Sunday
            // household, so this is the week of Sun 2026-07-12.
            today = { LocalDate.parse("2026-07-15") },
        )
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private val week = """
        {"entries":[
          {"id":"a","date":"2026-07-13","mealType":"dinner","recipeId":"r1",
           "recipe":{"title":"Tacos","emoji":"🌮"}},
          {"id":"b","date":"2026-07-16","mealType":"dinner","recipeId":"r2",
           "recipe":{"title":"Curry","emoji":"🍛"}}
        ]}
    """.trimIndent()

    /** Load the fixture week and return the request count to measure writes against. */
    private suspend fun loadWeek(): Int {
        harness.enqueueJson(week)
        model.load()
        harness.takeRequest()
        return harness.requestCount
    }

    private fun planned(date: String) =
        model.entries.value.firstOrNull { it.date == date && it.mealType == "dinner" }?.displayTitle

    @Test
    fun `a successful swap writes the moved meal into the target first`() = runTest {
        loadWeek()
        harness.enqueueJson("""{"entry":{"id":"a"}}""") // write 1
        harness.enqueueJson("""{"entry":{"id":"b"}}""") // write 2
        harness.enqueueJson(week) // no settle reload is queued, so none is consumed

        model.move("2026-07-13", "dinner", "2026-07-16", "dinner")

        // Write 1 targets the DESTINATION with the dragged meal — its own row untouched,
        // so a failure here leaves the server unchanged.
        val first = harness.takeRequest().body.readUtf8()
        assertContains(first, """"date":"2026-07-16"""")
        assertContains(first, """"recipeId":"r1"""")
        // Only then is the source slot rewritten with the displaced meal.
        val second = harness.takeRequest().body.readUtf8()
        assertContains(second, """"date":"2026-07-13"""")
        assertContains(second, """"recipeId":"r2"""")

        assertEquals("Tacos", planned("2026-07-16"))
        assertEquals("Curry", planned("2026-07-13"))
        assertNull(model.moveError.value)
    }

    /** A move onto an empty night clears the source rather than rewriting it. */
    @Test
    fun `a move to an empty night clears the source slot`() = runTest {
        loadWeek()
        harness.enqueueJson("""{"entry":{"id":"a"}}""")
        harness.enqueueJson("", status = 204)

        model.move("2026-07-13", "dinner", "2026-07-15", "dinner")

        harness.takeRequest()
        assertEquals("DELETE", harness.takeRequest().method)
        assertEquals("Tacos", planned("2026-07-15"))
        assertNull(planned("2026-07-13"))
    }

    /**
     * The first write failing means the server never changed, so the snapshot rollback is
     * a TRUE rollback and no reload is needed.
     */
    @Test
    fun `a first-write failure rolls the entries back locally`() = runTest {
        val baseline = loadWeek()
        harness.enqueueError(500, "ServerError")

        model.move("2026-07-13", "dinner", "2026-07-16", "dinner")

        assertEquals("Tacos", planned("2026-07-13"))
        assertEquals("Curry", planned("2026-07-16"))
        assertNotNull(model.moveError.value)
        // One attempted write, and no reload — the server was never touched.
        assertEquals(baseline + 1, harness.requestCount)
    }

    /**
     * The SECOND write failing leaves the meal in both slots. That is recoverable and the
     * compensation is attempted; what must never happen is the meal vanishing.
     */
    @Test
    fun `a second-write failure compensates instead of losing the meal`() = runTest {
        loadWeek()
        harness.enqueueJson("""{"entry":{"id":"a"}}""") // write 1 lands
        harness.enqueueError(500, "ServerError") // write 2 fails
        harness.enqueueJson("""{"entry":{"id":"b"}}""") // compensation

        model.move("2026-07-13", "dinner", "2026-07-16", "dinner")

        harness.takeRequest()
        harness.takeRequest()
        // The compensating write restores the TARGET slot to its pre-move content.
        val compensation = harness.takeRequest().body.readUtf8()
        assertContains(compensation, """"date":"2026-07-16"""")
        assertContains(compensation, """"recipeId":"r2"""")
        assertNotNull(model.moveError.value)
    }

    @Test
    fun `a no-op move issues nothing`() = runTest {
        val baseline = loadWeek()
        model.move("2026-07-13", "dinner", "2026-07-13", "dinner")
        model.move("2026-07-14", "dinner", "2026-07-15", "dinner") // empty source
        assertEquals(baseline, harness.requestCount)
    }

    /** A failed fetch keeps the week on screen rather than blanking it. */
    @Test
    fun `a failed reload keeps the week that is already shown`() = runTest {
        loadWeek()
        harness.enqueueError(500, "ServerError")

        model.load()

        assertEquals("Tacos", planned("2026-07-13"))
    }

    // ---- derived view state ------------------------------------------------------

    @Test
    fun `days are precomputed with labels and per-slot entries`() = runTest {
        loadWeek()
        val days = model.days(model.entries.value)
        assertEquals(7, days.size)
        val thirteenth = days.first { it.ymd == "2026-07-13" }
        assertEquals("Tacos", thirteenth.entry("dinner")?.displayTitle)
        assertNull(thirteenth.entry("lunch"))
        assertTrue(thirteenth.weekdayLabel.isNotEmpty())
    }

    @Test
    fun `a week with an unplanned night offers the plan CTA`() = runTest {
        loadWeek()
        assertTrue(model.hasEmptyNight(model.entries.value))
        val full = model.weekDays.map {
            WeekEntryDTO(id = it.toString(), date = MealsFormat.ymd(it), mealType = "dinner", title = "Something")
        }
        assertTrue(!model.hasEmptyNight(full))
    }

    @Test
    fun `move targets exclude the source and name their occupants`() = runTest {
        loadWeek()
        val targets = model.moveTargets("2026-07-13", "dinner")
        assertTrue(targets.none { it.date == "2026-07-13" && it.mealType == "dinner" })
        assertEquals("Curry", targets.first { it.date == "2026-07-16" && it.mealType == "dinner" }.occupantTitle)
    }

    @Test
    fun `a monday household's week is cut on monday, whatever the device says`() {
        firstDay = HouseholdWeekStart.Monday
        assertEquals(LocalDate.parse("2026-07-13"), model.weekStart)
        assertEquals(LocalDate.parse("2026-07-19"), model.weekDays.last())
    }

    @Test
    fun `an unsynced household falls back to a sunday week`() {
        firstDay = null
        assertEquals(LocalDate.parse("2026-07-12"), model.weekStart)
    }
}
