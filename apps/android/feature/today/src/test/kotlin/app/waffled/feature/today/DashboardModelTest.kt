package app.waffled.feature.today

import app.waffled.core.network.RestState
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/DashboardModelTests.swift` — the spec for the Today
 * dashboard's REST-backed model.
 *
 * The contract these lock down, in the iOS author's words: cards must be able to tell
 * "still loading" apart from "loaded and empty" (no flash of an empty state before data
 * arrives), and a failed refresh must keep the prior values instead of blanking a card.
 */

// ---- stub plumbing (the Swift `StubFeed`) ---------------------------------------

/**
 * Mutable fetch results the stubbed lambdas read — lets a test flip a domain between
 * "succeeds with N rows" and "fails" (null) across successive loads.
 */
private class StubFeed {
    var meals: List<TodayApi.WeekEntry>? = emptyList()
    var chores: List<TodayApi.PersonChores>? = emptyList()
    var grocery: List<TodayApi.GroceryItem>? = emptyList()
    var goals: List<TodayApi.Goal>? = emptyList()
    var recap: List<TodayApi.GoalRecapItem>? = emptyList()
    var suggestions: List<TodayApi.GoalSuggestionItem>? = emptyList()
}

/** The Swift `URLError(.notConnectedToInternet)`: a null feed fails like a dead network. */
internal fun offline(): Nothing = throw java.net.UnknownHostException("offline")

private fun model(feed: StubFeed) = DashboardModel(
    fetchMeals = { feed.meals ?: offline() },
    fetchChores = { feed.chores ?: offline() },
    fetchGrocery = { feed.grocery ?: offline() },
    fetchGoals = { feed.goals ?: offline() },
    fetchRecap = { feed.recap ?: offline() },
    fetchSuggestions = { feed.suggestions ?: offline() },
)

private var seq = 0
private fun nextId(): String = "id-${seq++}"

private fun dinner(date: String, title: String? = "Tacos") = TodayApi.WeekEntry(
    id = nextId(), date = date, mealType = "dinner", title = title,
)

/** A night holding a Meal Builder plate — no `recipeId`, dishes on `meal`. */
private fun plateDinner(
    date: String,
    name: String = "BBQ Sunday",
    dishes: List<String> = listOf("r1", "r2", "r3"),
) = TodayApi.WeekEntry(
    id = nextId(), date = date, mealType = "dinner", title = name, recipeId = null,
    mealId = "m1",
    meal = TodayApi.MealSlot(
        id = "m1", name = name, servings = 6,
        recipes = dishes.mapIndexed { i, r ->
            TodayApi.Dish(
                recipeId = r, title = "Dish $r", emoji = null,
                role = if (i == 0) "main" else "side", sortOrder = i,
            )
        },
    ),
)

private fun person(name: String, total: Int, done: Int = 0) = TodayApi.PersonChores(
    id = nextId(), name = name, avatarEmoji = null, colorHex = null,
    total = total, done = done, stars = done,
)

private fun goal(title: String) = TodayApi.Goal(id = nextId(), title = title)

private const val TODAY = "2026-07-16"

// ---- loading state --------------------------------------------------------------

class DashboardModelLoadingStateTest {

    @Test
    fun firstOfflineLoadIsUnavailableAndNeverAuthoritative() = runTest {
        val feed = StubFeed()
        feed.meals = null; feed.chores = null; feed.grocery = null; feed.goals = null
        val m = model(feed)
        m.load(TODAY)
        m.loadGoals()
        assertEquals(RestState.Offline(null), m.mealsState)
        assertEquals(RestState.Offline(null), m.choresState)
        assertEquals(RestState.Offline(null), m.groceryState)
        assertEquals(RestState.Offline(null), m.goalsState)
        assertFalse(m.loaded)
        assertFalse(m.goalsLoaded)
    }

    @Test
    fun anOfflineRefreshKeepsItsAgeAndItsRows() = runTest {
        val feed = StubFeed()
        feed.chores = listOf(person("June", total = 2))
        val m = model(feed)
        m.load(TODAY)
        assertTrue(m.choresState.isAuthoritative)

        feed.chores = null
        m.load(TODAY)

        assertIs<RestState.Offline>(m.choresState)
        assertNotNull(m.choresState.updatedAt, "offline after a success still knows its age")
        assertEquals(1, m.chores.size)
    }

    @Test
    fun theReviewQueuesShareOneState() = runTest {
        val feed = StubFeed()
        feed.recap = null
        val m = model(feed)
        m.loadGoals()
        assertEquals(RestState.Offline(null), m.reviewState)
        assertTrue(m.goalsLoaded, "the goals card does not wait on the review queues")
    }

    @Test
    fun anOlderLoadFinishingLastCannotOverwriteANewerOne() = runTest {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        var calls = 0
        val m = DashboardModel(
            fetchMeals = { emptyList() },
            fetchChores = {
                calls++
                if (calls == 1) {
                    gate.await()
                    listOf(person("Old", total = 1))
                } else {
                    listOf(person("New", total = 1))
                }
            },
            fetchGrocery = { emptyList() },
            fetchGoals = { emptyList() },
            fetchRecap = { emptyList() },
            fetchSuggestions = { emptyList() },
        )
        val first = launch { m.load(TODAY) }
        testScheduler.runCurrent()
        m.load(TODAY)
        gate.complete(Unit)
        first.join()
        assertEquals(listOf("New"), m.chores.map { it.name })
    }

    /**
     * The bug: cards must be able to tell "still loading" apart from "loaded and empty".
     * A fresh model reports neither domain loaded.
     */
    @Test
    fun startsUnloaded() {
        val m = model(StubFeed())
        assertFalse(m.loaded)
        assertFalse(m.goalsLoaded)
    }

    /**
     * Goals finishing with zero rows is "loaded and empty" — only then may the card show
     * its empty state.
     */
    @Test
    fun emptyGoalsAreLoadedNotLoading() = runTest {
        val m = model(StubFeed())
        m.loadGoals()
        assertTrue(m.goalsLoaded)
        assertTrue(m.goals.isEmpty())
    }

    /**
     * The dash `loaded` flag must not stand in for the goals fetch: after only `load()`
     * (meals/chores/grocery), goals still count as loading.
     */
    @Test
    fun dashLoadDoesNotMarkGoalsLoaded() = runTest {
        val m = model(StubFeed())
        m.load(TODAY)
        assertTrue(m.loaded)
        assertFalse(m.goalsLoaded)
    }

    @Test
    fun loadGoalsStoresRows() = runTest {
        val feed = StubFeed()
        feed.goals = listOf(goal("Read 10 books"))
        val m = model(feed)
        m.loadGoals()
        assertEquals(listOf("Read 10 books"), m.goals.map { it.title })
        assertTrue(m.goalsLoaded)
    }
}

// ---- refresh semantics ----------------------------------------------------------

class DashboardModelRefreshTest {

    /** Tonight's dinner comes from today's dinner slot; other days/slots don't count. */
    @Test
    fun picksTonightsDinner() = runTest {
        val feed = StubFeed()
        feed.meals = listOf(dinner("2026-07-15"), dinner(TODAY, title = "Waffles"))
        val m = model(feed)
        m.load(TODAY)
        assertEquals("Waffles", m.tonight?.title)
        assertTrue(m.loaded)
    }

    /**
     * A successful refresh with no dinner clears the card — the plan changed elsewhere
     * and today's meal was removed.
     *
     * This is the canary for the `RestDomain` shape: `apply(null)` always keeps the prior
     * value, so tonight must be modelled as a LIST (empty = "no dinner", null = "fetch
     * failed") rather than as a nullable single value.
     */
    @Test
    fun successfulRefreshClearsRemovedDinner() = runTest {
        val feed = StubFeed()
        feed.meals = listOf(dinner(TODAY))
        val m = model(feed)
        m.load(TODAY)
        assertNotNull(m.tonight)
        feed.meals = emptyList()
        m.load(TODAY)
        assertNull(m.tonight)
    }

    /**
     * A failed refresh (offline, expired token) keeps the prior values instead of
     * blanking the cards to their empty states.
     */
    @Test
    fun failedRefreshKeepsPriorValues() = runTest {
        val feed = StubFeed()
        feed.meals = listOf(dinner(TODAY, title = "Curry"))
        feed.chores = listOf(person("June", total = 3, done = 1))
        feed.grocery = listOf(
            TodayApi.GroceryItem("a", checked = false),
            TodayApi.GroceryItem("b", checked = true),
        )
        feed.goals = listOf(goal("Bike 100 mi"))
        val m = model(feed)
        m.load(TODAY)
        m.loadGoals()

        feed.meals = null; feed.chores = null; feed.grocery = null; feed.goals = null
        m.load(TODAY)
        m.loadGoals()

        assertEquals("Curry", m.tonight?.title)
        assertEquals(1, m.chores.size)
        assertEquals(1, m.groceryRemaining)
        assertEquals(1, m.goals.size)
    }

    /** People with no chores today are dropped; grocery counts only unchecked items. */
    @Test
    fun filtersChoresAndCountsGrocery() = runTest {
        val feed = StubFeed()
        feed.chores = listOf(person("June", total = 2), person("Rex", total = 0))
        feed.grocery = listOf(
            TodayApi.GroceryItem("a", checked = false),
            TodayApi.GroceryItem("b", checked = false),
            TodayApi.GroceryItem("c", checked = true),
        )
        val m = model(feed)
        m.load(TODAY)
        assertEquals(listOf("June"), m.chores.map { it.name })
        assertEquals(2, m.groceryRemaining)
    }

    /** The aggregate tallies the compact chores card renders. */
    @Test
    fun aggregatesChoreProgress() = runTest {
        val feed = StubFeed()
        feed.chores = listOf(person("June", total = 3, done = 2), person("Rex", total = 2, done = 1))
        val m = model(feed)
        m.load(TODAY)
        assertEquals(3, m.choreDone)
        assertEquals(5, m.choreTotal)
        assertEquals(3, m.choreStars)
    }
}

// ---- tonight's meal: plates vs recipes vs eating out ----------------------------

/**
 * A night can hold a Meal Builder plate instead of a single recipe. The plate-backed slot
 * has NO `recipeId`, and the Tonight card decided everything from that one field: it
 * announced "No recipe attached yet" about a meal with three dishes, and offered neither
 * "View recipe" nor "Cook Mode".
 */
class TonightMealPlateTest {

    @Test
    fun aPlateNightIsCookableAndNamed() {
        val t = TonightMeal(plateDinner(TODAY))
        assertEquals("BBQ Sunday", t.title)
        assertTrue(t.isMealBacked)
        assertEquals("m1", t.mealId)
        assertEquals(3, t.dishCount)
        // The card's action gate: there IS something to open here.
        assertTrue(t.isCookable)
        assertFalse(t.eatingOut)
    }

    /**
     * `recipeSummary` is the placeholder the card opens for a single recipe. A plate has
     * no single recipe to stand in for it, so this stays null — the card must route by
     * `mealId` instead of quietly opening the wrong thing.
     */
    @Test
    fun aPlateHasNoStandInRecipe() {
        assertNull(TonightMeal(plateDinner(TODAY)).recipeSummary)
    }

    @Test
    fun anOrdinaryRecipeNightIsUnchanged() {
        val e = TodayApi.WeekEntry(
            id = "1", date = TODAY, mealType = "dinner", title = null, recipeId = "r9",
            recipe = TodayApi.RecipeInfo(
                title = "Curry", emoji = "🍛", category = "dinner",
                prepTimeMinutes = 5, cookTimeMinutes = 30, servings = 4,
            ),
        )
        val t = TonightMeal(e)
        assertFalse(t.isMealBacked)
        assertEquals(0, t.dishCount)
        assertTrue(t.isCookable)
        assertEquals("r9", t.recipeSummary?.id)
        assertEquals("Curry", t.title)
    }

    /** A free-text "takeout" night still reads as eating out... */
    @Test
    fun aFreeTextTakeoutNightStillReadsAsEatingOut() {
        val t = TonightMeal(dinner(TODAY, title = "Takeout"))
        assertTrue(t.eatingOut)
        assertFalse(t.isCookable)
        assertEquals("Eating out", t.title)
    }

    /**
     * ...but a PLATE someone named "Takeout Night" is a real meal with real dishes, and
     * must not be swallowed by that heuristic.
     */
    @Test
    fun aPlateNamedLikeTakeoutIsStillAPlate() {
        val t = TonightMeal(plateDinner(TODAY, name = "Takeout Night"))
        assertFalse(t.eatingOut)
        assertTrue(t.isCookable)
        assertEquals("Takeout Night", t.title)
    }

    /** The full eating-out regex table, mirroring the web. */
    @Test
    fun matchesEveryEatingOutPhrasing() {
        for (title in listOf(
            "Eating out", "eat out", "Dining Out", "going out", "Take-out", "takeout",
            "take out", "ordering in", "order in", "Delivery night", "Takeaway",
        )) {
            assertTrue(TonightMeal.isEatingOut(title), "expected '$title' to read as eating out")
        }
        for (title in listOf(null, "", "Outdoor grill", "Order of operations", "Cutout cookies")) {
            assertFalse(TonightMeal.isEatingOut(title), "expected '$title' NOT to read as eating out")
        }
    }
}
