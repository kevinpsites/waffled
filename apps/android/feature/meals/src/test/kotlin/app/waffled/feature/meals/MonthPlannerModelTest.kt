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
 * The month planner, driven end to end against a fake server.
 *
 * September 2026 begins on a Tuesday, so the Sunday-cut grid starts on 2026-08-30 and the
 * leading two cells belong to August.
 */
class MonthPlannerModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private var firstDay: HouseholdWeekStart? = HouseholdWeekStart.Sunday
    private lateinit var model: MonthPlannerModel

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        model = MonthPlannerModel(
            api = MealsApi(client, harness.tokens),
            zone = ZoneId.of("UTC"),
            locale = Locale.US,
            firstDay = { firstDay },
            // Pinned so the fixture month can't rot as the real date moves on.
            today = { LocalDate.parse("2026-09-15") },
        )
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private val month = """
        {"entries":[
          {"id":"a","date":"2026-09-02","mealType":"dinner","recipeId":"r1",
           "recipe":{"title":"Tacos","emoji":"🌮"}},
          {"id":"b","date":"2026-09-09","mealType":"dinner","recipeId":"r2",
           "recipe":{"title":"Curry","emoji":"🍛"}},
          {"id":"c","date":"2026-09-03","mealType":"lunch","title":"Sandwiches"}
        ]}
    """.trimIndent()

    private suspend fun loadMonth(): Int {
        harness.enqueueJson(month)
        model.load()
        return harness.requestCount
    }

    private fun dinner(date: String) =
        model.entries.value.firstOrNull { it.date == date }?.displayTitle

    /** The grid is a 42-day window off the SUNDAY before the 1st, dinners only. */
    @Test
    fun `the month loads a 42-day window and keeps only dinners`() = runTest {
        loadMonth()

        val req = harness.takeRequest()
        assertContains(req.path.orEmpty(), "start=2026-08-30")
        assertContains(req.path.orEmpty(), "days=42")
        // The lunch is dropped — this view is the web's dinner-only month.
        assertEquals(listOf("2026-09-02", "2026-09-09"), model.entries.value.map { it.date })
    }

    @Test
    fun `cells cover the grid and mark what is in month`() = runTest {
        loadMonth()
        harness.takeRequest()

        val cells = model.cells(model.entries.value)
        assertEquals(42, cells.size)
        assertEquals("2026-08-30", cells.first().ymd)
        // The two leading cells belong to August and are drawn dimmed and inert.
        assertTrue(cells.take(2).none { it.inMonth })
        assertTrue(cells.first { it.ymd == "2026-09-01" }.inMonth)
        assertEquals("Tacos", cells.first { it.ymd == "2026-09-02" }.entry?.displayTitle)
        assertTrue(cells.first { it.ymd == "2026-09-15" }.isToday)
    }

    /** A free-text "eating out" night gets a fork; a real plate never does. */
    @Test
    fun `an eating-out night is drawn with a fork`() = runTest {
        harness.enqueueJson(
            """{"entries":[
                 {"id":"x","date":"2026-09-04","mealType":"dinner","title":"Takeout"},
                 {"id":"y","date":"2026-09-05","mealType":"dinner","title":"Takeout Night",
                  "mealId":"m1","meal":{"id":"m1","name":"Takeout Night","recipes":[]}}
               ]}""",
        )
        model.load()

        val cells = model.cells(model.entries.value)
        assertEquals("🍴", cells.first { it.ymd == "2026-09-04" }.emoji)
        // The plate is a real meal with real dishes, whatever it is called.
        assertEquals("🍽️", cells.first { it.ymd == "2026-09-05" }.emoji)
    }

    @Test
    fun `a successful swap writes the moved dinner into the target first`() = runTest {
        loadMonth()
        harness.takeRequest()
        harness.enqueueJson("""{"entry":{"id":"a"}}""")
        harness.enqueueJson("""{"entry":{"id":"b"}}""")

        model.move("2026-09-02", "2026-09-09")

        val first = harness.takeRequest().body.readUtf8()
        assertContains(first, """"date":"2026-09-09"""")
        assertContains(first, """"recipeId":"r1"""")
        val second = harness.takeRequest().body.readUtf8()
        assertContains(second, """"date":"2026-09-02"""")
        assertContains(second, """"recipeId":"r2"""")

        assertEquals("Tacos", dinner("2026-09-09"))
        assertEquals("Curry", dinner("2026-09-02"))
        assertNull(model.moveError.value)
    }

    @Test
    fun `a first-write failure rolls the entries back locally`() = runTest {
        val baseline = loadMonth()
        harness.takeRequest()
        harness.enqueueError(500, "ServerError")

        model.move("2026-09-02", "2026-09-09")

        assertEquals("Tacos", dinner("2026-09-02"))
        assertEquals("Curry", dinner("2026-09-09"))
        assertNotNull(model.moveError.value)
        // One attempted write and no reload — the server was never touched.
        assertEquals(baseline + 1, harness.requestCount)
    }

    /**
     * The second write failing leaves the dinner in both nights — recoverable — and the
     * compensation restores the target. What must never happen is the dinner vanishing.
     */
    @Test
    fun `a second-write failure compensates instead of losing the dinner`() = runTest {
        loadMonth()
        harness.takeRequest()
        harness.enqueueJson("""{"entry":{"id":"a"}}""")
        harness.enqueueError(500, "ServerError")
        harness.enqueueJson("""{"entry":{"id":"b"}}""")

        model.move("2026-09-02", "2026-09-09")

        harness.takeRequest()
        harness.takeRequest()
        val compensation = harness.takeRequest().body.readUtf8()
        assertContains(compensation, """"date":"2026-09-09"""")
        assertContains(compensation, """"recipeId":"r2"""")
        assertNotNull(model.moveError.value)
    }

    @Test
    fun `a no-op move issues nothing`() = runTest {
        val baseline = loadMonth()
        harness.takeRequest()
        model.move("2026-09-02", "2026-09-02")
        model.move("2026-09-04", "2026-09-05") // empty source
        assertEquals(baseline, harness.requestCount)
    }

    /**
     * Only in-month nights are offered: the grid's leading and trailing cells belong to the
     * neighbouring months, and moving a dinner onto one would put it somewhere the user
     * cannot see it from here.
     */
    @Test
    fun `move targets stay inside the month and name their occupants`() = runTest {
        loadMonth()
        harness.takeRequest()

        val targets = model.moveTargets("2026-09-02")
        assertEquals(29, targets.size) // 30 September days, minus the source
        assertTrue(targets.none { it.date.startsWith("2026-08") || it.date.startsWith("2026-10") })
        assertTrue(targets.none { it.date == "2026-09-02" })
        assertEquals("Curry", targets.first { it.date == "2026-09-09" }.occupantTitle)
        assertTrue(targets.all { it.mealType == "dinner" })
    }

    @Test
    fun `stepping months moves the window and the label`() = runTest {
        loadMonth()
        harness.takeRequest()
        harness.enqueueJson("""{"entries":[]}""")

        model.step(1)

        assertEquals("October 2026", model.monthYearLabel)
        assertEquals("October", model.monthLabel)
        assertTrue(!model.isCurrentMonth)
        // October 2026 begins on a Thursday, so the grid opens on Sunday 2026-09-27.
        assertContains(harness.takeRequest().path.orEmpty(), "start=2026-09-27")

        harness.enqueueJson(month)
        model.jumpToThisMonth()
        assertTrue(model.isCurrentMonth)
    }

    @Test
    fun `a failed reload keeps the month that is already shown`() = runTest {
        loadMonth()
        harness.takeRequest()
        harness.enqueueError(500, "ServerError")

        model.load()

        assertEquals("Tacos", dinner("2026-09-02"))
    }

    @Test
    fun `a monday household's month grid and headings start on monday`() = runTest {
        firstDay = HouseholdWeekStart.Monday
        assertEquals(listOf("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"), model.weekdaySymbols)
        loadMonth()
        assertContains(harness.takeRequest().path.orEmpty(), "start=2026-08-31")
        assertEquals(LocalDate.parse("2026-08-31"), model.cells(model.entries.value).first().date)
    }
}
