package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.RecipeRef
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The two plan sheets' state machines.
 *
 * The point of these is the seam: the sheets must be dumb executors of [MealPlanApply].
 * With the week-derivation inline, a revert to one `rebuildGrocery(monthStart)` call — the
 * original grocery bug — passed every test in the suite.
 */
class PlanSheetModelsTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: MealsApi

    private val pool = listOf(RecipeRef(id = "lib1", title = "Shepherd's Pie"))

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

    private fun weekModel(start: String = "2026-09-06") = PlanWeekModel(
        api = api, libraryRecipes = pool, householdWeekStart = HouseholdWeekStart.Sunday,
        familySize = 4, start = start,
        weekDays = MealsFormat.weekDays(LocalDate.parse(start)),
    )

    private fun monthModel(
        start: String = "2026-09-01",
        firstDay: HouseholdWeekStart? = HouseholdWeekStart.Sunday,
    ) = PlanMonthModel(
        api = api, libraryRecipes = pool, householdWeekStart = firstDay,
        familySize = 4, monthStart = start,
    )

    private fun paths(n: Int) = (1..n).map { harness.takeRequest().path.orEmpty() }

    // ---- week -------------------------------------------------------------------

    @Test
    fun `the week sheet defaults to weekdays and the whole family`() {
        val model = weekModel()
        // Sun 2026-09-06 … Sat 2026-09-12; Mon-Fri is the 7th to the 11th.
        assertEquals(
            listOf("2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"),
            model.selectedDays.value.sorted(),
        )
        assertEquals(0, model.cookingFor.value)
        assertEquals(4, model.servings)
    }

    @Test
    fun `a drafted week lands in review`() = runTest {
        harness.enqueueJson(
            """{"start":"2026-09-06","mealType":"dinner","via":"anthropic","suggestions":[
                 {"date":"2026-09-07","mealType":"dinner","title":"Tacos","recipeId":"r1"}]}""",
        )
        val model = weekModel()
        model.selectedDays.value = setOf("2026-09-07")

        model.suggest()

        assertEquals(PlanPhase.Review, model.phase.value)
        assertEquals(listOf("Tacos"), model.suggestions.value.map { it.title })
        assertEquals("anthropic", model.via.value)
    }

    @Test
    fun `a planner opened from the pantry arrives with its use-up names`() {
        val names = (1..14).map { "item$it" }
        val model = PlanWeekModel(
            api = api, libraryRecipes = pool, householdWeekStart = HouseholdWeekStart.Sunday,
            familySize = 4, start = "2026-09-06",
            weekDays = MealsFormat.weekDays(LocalDate.parse("2026-09-06")),
            seedUseUp = names,
        )
        assertEquals(names.take(12), model.useUp.value, "capped like a typed list")
    }

    @Test
    fun `a narrowing host picks the meal and the nights`() {
        val model = PlanWeekModel(
            api = api, libraryRecipes = pool, householdWeekStart = HouseholdWeekStart.Sunday,
            familySize = 4, start = "2026-09-06",
            weekDays = MealsFormat.weekDays(LocalDate.parse("2026-09-06")),
            mealTypes = listOf("lunch"),
            initialDays = listOf("2026-09-09", "2026-09-12"),
        )
        // Planning "dinner" when only lunch is on offer would draft the wrong meal.
        assertEquals("lunch", model.mealType.value)
        assertEquals(setOf("2026-09-09", "2026-09-12"), model.selectedDays.value)
    }

    @Test
    fun `the standalone week keeps dinner when dinner is on offer`() {
        assertEquals("dinner", weekModel().mealType.value)
        assertEquals(listOf("breakfast", "lunch", "dinner"), weekModel().mealTypes)
    }

    @Test
    fun `a host's onApply replaces the per-slot writes`() = runTest {
        harness.enqueueJson(
            """{"start":"2026-09-06","mealType":"dinner","suggestions":[
                 {"date":"2026-09-07","mealType":"dinner","title":"Tacos","recipeId":"r1"}]}""",
        )
        var handed: List<PlanCardDTO>? = null
        val model = PlanWeekModel(
            api = api, libraryRecipes = pool, householdWeekStart = HouseholdWeekStart.Sunday,
            familySize = 4, start = "2026-09-06",
            weekDays = MealsFormat.weekDays(LocalDate.parse("2026-09-06")),
            onApply = { cards -> handed = cards; true },
        )
        model.selectedDays.value = setOf("2026-09-07")
        model.suggest()
        harness.takeRequest()
        val baseline = harness.requestCount

        assertTrue(model.apply())

        assertEquals(listOf("Tacos"), handed?.map { it.title })
        // Running both would plan every night twice.
        assertEquals(baseline, harness.requestCount)
    }

    /** A runtime provider failure shows the provider's own words, not a generic error. */
    @Test
    fun `a provider failure lands in failed with a friendly message`() = runTest {
        harness.enqueueJson("""{"start":"2026-09-06","mealType":"dinner","suggestions":[],"error":"AIUnavailable"}""")
        val model = weekModel()
        model.selectedDays.value = setOf("2026-09-07")

        model.suggest()

        assertEquals(PlanPhase.Failed, model.phase.value)
        assertContains(model.errorMessage.value.orEmpty(), "No AI provider is set up")
        // …and Try again puts the user back on the config they already filled in.
        model.backToConfig()
        assertEquals(PlanPhase.Config, model.phase.value)
    }

    /**
     * The whole reason [MealPlanApply] is a separate value: the apply must issue a rebuild
     * per touched week, after every write. A Sun-Sat grid straddles two Sunday-cut weeks
     * only when it spans a boundary — here two nights in one week is one rebuild.
     */
    @Test
    fun `applying a week writes every night and then rebuilds its grocery week`() = runTest {
        harness.enqueueJson(
            """{"start":"2026-09-06","mealType":"dinner","suggestions":[
                 {"date":"2026-09-07","mealType":"dinner","title":"Tacos","recipeId":"r1"},
                 {"date":"2026-09-08","mealType":"dinner","title":"Curry","recipeId":"r2"}]}""",
        )
        val model = weekModel()
        model.selectedDays.value = setOf("2026-09-07", "2026-09-08")
        model.suggest()
        harness.takeRequest() // the draft

        repeat(2) { harness.enqueueJson("""{"entry":{"id":"e"}}""") }
        harness.enqueueJson("""{"board":{}}""")

        model.apply()

        val issued = paths(3)
        assertEquals(listOf("/api/meals/plan", "/api/meals/plan"), issued.take(2))
        // The rebuild comes LAST — issued before its night is written, it would build the
        // list from the plan as it was.
        assertContains(issued[2], "/api/lists/grocery/rebuild")
        assertContains(issued[2], "weekStart=2026-09-06")
    }

    @Test
    fun `picking a recipe replaces that night and keeps the list sorted`() = runTest {
        val model = weekModel()
        harness.enqueueJson(
            """{"start":"2026-09-06","mealType":"dinner","suggestions":[
                 {"date":"2026-09-08","mealType":"dinner","title":"Curry"},
                 {"date":"2026-09-07","mealType":"dinner","title":"Tacos"}]}""",
        )
        model.selectedDays.value = setOf("2026-09-07", "2026-09-08")
        model.suggest()

        model.pick("2026-09-07", RecipeRef(id = "r9", title = "Ramen"))

        assertEquals(listOf("Ramen", "Curry"), model.suggestions.value.map { it.title })
        assertEquals("r9", model.suggestions.value.first().recipeId)
        assertEquals("Your pick", model.suggestions.value.first().note)
    }

    /** Use-up chips dedupe, trim and cap — the same rule the server expects. */
    @Test
    fun `use-up chips dedupe, trim and cap`() {
        val model = weekModel()
        model.useUpInput.value = "  spinach  "
        model.addUseUp()
        model.useUpInput.value = "spinach"
        model.addUseUp()
        assertEquals(listOf("spinach"), model.useUp.value)

        repeat(20) {
            model.useUpInput.value = "item$it"
            model.addUseUp()
        }
        assertEquals(12, model.useUp.value.size)

        model.removeUseUp("spinach")
        assertFalse(model.useUp.value.contains("spinach"))
    }

    /** A locked night refuses to move, from either end. */
    @Test
    fun `a locked night refuses to move`() = runTest {
        harness.enqueueJson(
            """{"start":"2026-09-06","mealType":"dinner","suggestions":[
                 {"date":"2026-09-07","mealType":"dinner","title":"Tacos"},
                 {"date":"2026-09-08","mealType":"dinner","title":"Curry"}]}""",
        )
        val model = weekModel()
        model.selectedDays.value = setOf("2026-09-07", "2026-09-08")
        model.suggest()

        model.toggleLock("2026-09-07")
        model.moveCard("2026-09-07", "2026-09-08")
        assertEquals(listOf("Tacos", "Curry"), model.suggestions.value.map { it.title })

        model.toggleLock("2026-09-07")
        model.moveCard("2026-09-07", "2026-09-08")
        assertEquals(listOf("Curry", "Tacos"), model.suggestions.value.map { it.title })
    }

    // ---- month ------------------------------------------------------------------

    private val monthDraft = """
        {"start":"2026-09-01","mealType":"dinner",
         "suggestions":[{"date":"2026-09-02","mealType":"dinner","title":"New","recipeId":"r1"}],
         "existing":[{"date":"2026-09-16","mealType":"dinner","title":"Old","recipeId":"r2"}]}
    """.trimIndent()

    private suspend fun draftedMonth(): PlanMonthModel {
        harness.enqueueJson(monthDraft)
        val model = monthModel()
        model.suggest()
        harness.takeRequest()
        return model
    }

    /** The review shows the WHOLE month — freshly drafted nights AND already-planned ones. */
    @Test
    fun `a drafted month shows existing nights alongside the new ones`() = runTest {
        val model = draftedMonth()
        assertEquals(listOf("2026-09-02", "2026-09-16"), model.suggestions.value.map { it.date })
        assertEquals(setOf("2026-09-16"), model.plannedDates.value)
        assertTrue(model.dirty.value.isEmpty())
    }

    /**
     * An already-planned night that wasn't edited is left alone: its shopping is already on
     * the list, and rewriting it is pointless traffic.
     */
    @Test
    fun `an untouched existing night is not rewritten`() = runTest {
        val model = draftedMonth()
        harness.enqueueJson("""{"entry":{"id":"e"}}""")
        harness.enqueueJson("""{"board":{}}""")

        model.apply()

        val issued = paths(2)
        assertEquals("/api/meals/plan", issued[0])
        assertContains(issued[1], "weekStart=2026-08-30") // only the written night's week
    }

    /**
     * Moving a card in the MONTH review makes both ends dirty — unlike the week sheet.
     * An already-planned night whose dish has changed must be rewritten, or the apply
     * silently leaves the old dinner in place.
     */
    @Test
    fun `moving a month card marks both nights dirty so they are rewritten`() = runTest {
        val model = draftedMonth()

        model.moveCard("2026-09-02", "2026-09-16")

        assertEquals(setOf("2026-09-02", "2026-09-16"), model.dirty.value)
        assertEquals(listOf("Old", "New"), model.suggestions.value.map { it.title })

        repeat(2) { harness.enqueueJson("""{"entry":{"id":"e"}}""") }
        repeat(2) { harness.enqueueJson("""{"board":{}}""") }
        model.apply()

        val issued = paths(4)
        assertEquals(listOf("/api/meals/plan", "/api/meals/plan"), issued.take(2))
        // Both touched weeks are rebuilt — 2026-09-02 is in the week of Aug 30, and
        // 2026-09-16 in the week of Sep 13.
        assertTrue(issued.drop(2).any { it.contains("weekStart=2026-08-30") })
        assertTrue(issued.drop(2).any { it.contains("weekStart=2026-09-13") })
    }

    /**
     * A skipped night that WAS planned is cleared, and its week is rebuilt too — otherwise
     * its shopping stays on the list for a dinner nobody is cooking.
     */
    @Test
    fun `a skipped night that was planned is cleared and its week rebuilt`() = runTest {
        val model = draftedMonth()
        val existing = model.suggestions.value.first { it.date == "2026-09-16" }

        model.skip(existing)
        assertEquals(listOf("2026-09-02"), model.suggestions.value.map { it.date })

        harness.enqueueJson("""{"entry":{"id":"e"}}""") // the new night
        harness.enqueueJson("", status = 204) // the clear
        repeat(2) { harness.enqueueJson("""{"board":{}}""") }
        model.apply()

        val requests = (1..4).map { harness.takeRequest() }
        assertEquals("POST", requests[0].method)
        assertEquals("DELETE", requests[1].method)
        assertContains(requests[1].path.orEmpty(), "date=2026-09-16")
        val rebuilds = requests.drop(2).map { it.path.orEmpty() }
        assertTrue(rebuilds.any { it.contains("weekStart=2026-09-13") })
        assertTrue(rebuilds.any { it.contains("weekStart=2026-08-30") })
    }

    /**
     * Skipping a night that was never planned needs no clear — there is nothing to clear —
     * and the one already-planned night is untouched, so the whole apply sends NOTHING.
     * Not even a rebuild: a stray one would un-tick a shopper's list for no reason at all.
     */
    @Test
    fun `an apply with nothing to change sends nothing at all`() = runTest {
        val model = draftedMonth()
        model.skip(model.suggestions.value.first { it.date == "2026-09-02" })
        val baseline = harness.requestCount

        model.apply()

        assertEquals(baseline, harness.requestCount)
    }

    @Test
    fun `the review groups nights by their sunday week, in date order`() = runTest {
        val model = draftedMonth()
        val groups = model.weekGroups(model.suggestions.value)
        assertEquals(listOf("2026-08-30", "2026-09-13"), groups.map { it.first })
        assertEquals(listOf("2026-09-02"), groups.first().second.map { it.date })
    }

    @Test
    fun `a monday household's review groups by monday weeks`() {
        val model = monthModel(firstDay = HouseholdWeekStart.Monday)
        val cards = listOf("2026-09-06", "2026-09-02", "2026-09-07").map {
            PlanCardDTO(date = it, mealType = "dinner", title = "x")
        }
        val groups = model.weekGroups(cards)
        // Sunday the 6th closes the Aug 31 week; Monday the 7th opens the next.
        assertEquals(listOf("2026-08-31", "2026-09-07"), groups.map { it.first })
        assertEquals(listOf("2026-09-02", "2026-09-06"), groups.first().second.map { it.date })
    }

    @Test
    fun `collapsing a week toggles`() = runTest {
        val model = draftedMonth()
        assertTrue(model.collapsedWeeks.value.isEmpty())
        model.toggleWeek("2026-08-30")
        assertEquals(setOf("2026-08-30"), model.collapsedWeeks.value)
        model.toggleWeek("2026-08-30")
        assertTrue(model.collapsedWeeks.value.isEmpty())
    }

    /** Turning a weekday off drops its theme too — a theme with no night is dead config. */
    @Test
    fun `deselecting a weekday clears its theme`() {
        val model = monthModel()
        model.setTheme(3, "tacos")
        assertEquals("tacos", model.themes.value[3])
        model.toggleWeekday(3)
        assertNull(model.themes.value[3])
    }

    @Test
    fun `the month draft sends its guardrails`() = runTest {
        harness.enqueueJson(monthDraft)
        val model = monthModel()
        model.quickWeeknights.value = true
        model.weeknightMax.value = 20
        model.setTheme(1, "meatless")

        model.suggest()

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, """"weeknightMaxMin":20""")
        assertContains(body, """"weekdayThemes":{"1":"meatless"}""")
        assertNotNull(model.suggestions.value.firstOrNull())
    }
}
