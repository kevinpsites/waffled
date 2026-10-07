package app.waffled.feature.kiosktoday

import app.waffled.core.network.RestState
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.lists.ListItemDTO
import app.waffled.feature.today.TodayApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/KioskTodayModelTests.swift`. The iPad Today model
 * honours the phone's loading contract: a failed fetch keeps prior values instead of
 * blanking the always-on display, each domain tracks its own state, and an empty success
 * genuinely clears. The shared `RestDomain` cases live in `core:network` already.
 */

private class KioskFeed {
    var chores: List<TodayApi.PersonChores>? = emptyList()
    var meals: List<TodayApi.WeekEntry>? = emptyList()
    var grocery: List<ListItemDTO>? = emptyList()
    var goals: List<GoalsApi.Goal>? = emptyList()
}

/** The Swift `URLError(.notConnectedToInternet)`: classified Offline via its IOException. */
private fun offline(): Nothing = throw java.net.UnknownHostException("offline")

private fun model(feed: KioskFeed) = KioskTodayModel(
    fetchChores = { feed.chores ?: offline() },
    fetchMeals = { feed.meals ?: offline() },
    fetchGrocery = { feed.grocery ?: offline() },
    fetchGoals = { feed.goals ?: offline() },
    fetchWeather = { null },
)

private var seq = 0
private fun nextId() = "id-${seq++}"

private fun dinner(date: String, title: String? = "Tacos") =
    TodayApi.WeekEntry(id = nextId(), date = date, mealType = "dinner", title = title)

private fun person(name: String, total: Int) =
    TodayApi.PersonChores(id = nextId(), name = name, total = total)

private fun item(name: String, checked: Boolean = false) =
    ListItemDTO(id = nextId(), name = name, checked = checked)

private fun goal(title: String) = GoalsApi.Goal(id = nextId(), title = title, target = 10.0, totalProgress = 2.0)

private const val TODAY = "2026-07-16"

class KioskTodayModelTest {

    @Test
    fun firstOfflineLoadIsUnavailableAndNeverAuthoritative() = runTest {
        val feed = KioskFeed().apply { meals = null; chores = null; grocery = null; goals = null }
        val m = model(feed)
        m.load(TODAY)
        m.loadGoals()
        assertEquals(RestState.Offline(null), m.mealsState)
        assertEquals(RestState.Offline(null), m.choresState)
        assertEquals(RestState.Offline(null), m.groceryState)
        assertEquals(RestState.Offline(null), m.goalsState)
    }

    @Test
    fun startsUnloaded() {
        val m = model(KioskFeed())
        assertFalse(m.choresLoaded)
        assertFalse(m.mealsLoaded)
        assertFalse(m.groceryLoaded)
        assertFalse(m.goalsLoaded)
    }

    /** The original flash: chores (one fast call) finishing must not mark the slower domains loaded. */
    @Test
    fun loadChoresDoesNotMarkOtherDomainsLoaded() = runTest {
        val m = model(KioskFeed())
        m.loadChores()
        assertTrue(m.choresLoaded)
        assertFalse(m.mealsLoaded)
        assertFalse(m.groceryLoaded)
        assertFalse(m.goalsLoaded)
    }

    /** A network blip on the always-on display must not blank it to "All bought ✓" / "No dinner planned". */
    @Test
    fun failedRefreshKeepsPriorValues() = runTest {
        val feed = KioskFeed().apply {
            meals = listOf(dinner(TODAY, title = "Curry"), dinner("2026-07-17"))
            chores = listOf(person("June", total = 3))
            grocery = listOf(item("Milk"), item("Eggs", checked = true))
            goals = listOf(goal("Bike 100 mi"))
        }
        val m = model(feed)
        m.load(TODAY)
        assertEquals("Curry", m.tonight?.title)
        assertEquals(2, m.weekDinners.size)

        feed.meals = null; feed.chores = null; feed.grocery = null; feed.goals = null
        m.load(TODAY)
        assertEquals("Curry", m.tonight?.title)
        assertEquals(2, m.weekDinners.size)
        assertEquals(listOf("June"), m.chores.map { it.name })
        assertEquals(2, m.grocery.size)
        assertEquals(listOf("Bike 100 mi"), m.goals.map { it.title })
    }

    /** An empty success is real data: the plan changed and tonight's dinner is gone. */
    @Test
    fun emptyMealsSuccessClearsTonight() = runTest {
        val feed = KioskFeed().apply { meals = listOf(dinner(TODAY)) }
        val m = model(feed)
        m.loadMeals(TODAY)
        assertNotNull(m.tonight)
        feed.meals = emptyList()
        m.loadMeals(TODAY)
        assertNull(m.tonight)
        assertTrue(m.weekDinners.isEmpty())
        assertTrue(m.mealsLoaded)
    }

    /** Chores keep their existing filter: people with nothing assigned drop out. */
    @Test
    fun choresFilterPeopleWithNoneToday() = runTest {
        val feed = KioskFeed().apply { chores = listOf(person("June", total = 2), person("Rex", total = 0)) }
        val m = model(feed)
        m.loadChores()
        assertEquals(listOf("June"), m.chores.map { it.name })
    }

    // ---- beyond the Swift file: the rest of KioskTodayModel's behaviour -----------

    /** Only dinners count, sorted by date, and tonight is today's dinner slot. */
    @Test
    fun weekDinnersAreDinnersOnlySortedByDate() = runTest {
        val feed = KioskFeed().apply {
            meals = listOf(
                dinner("2026-07-18", title = "Pizza"),
                TodayApi.WeekEntry(id = nextId(), date = TODAY, mealType = "lunch", title = "Soup"),
                dinner(TODAY, title = "Curry"),
            )
        }
        val m = model(feed)
        m.loadMeals(TODAY)
        assertEquals(listOf(TODAY, "2026-07-18"), m.weekDinners.map { it.date })
        assertEquals("Curry", m.tonight?.title)
    }

    /** A checked row lingers ("settling") for two seconds so the tap is visible, then leaves. */
    @Test
    fun checkingAGroceryRowSettlesOutAfterTwoSeconds() = runTest {
        val milk = item("Milk")
        val writes = mutableListOf<Pair<String, Boolean>>()
        val m = KioskTodayModel(
            fetchChores = { emptyList() }, fetchMeals = { emptyList() },
            fetchGrocery = { listOf(milk) }, fetchGoals = { emptyList() }, fetchWeather = { null },
            setGroceryChecked = { id, checked -> writes += id to checked },
        )
        m.loadGrocery()
        m.toggleGrocery(milk.id, backgroundScope)
        assertEquals(listOf(milk.id to true), writes)
        assertEquals(listOf("Milk"), m.groceryActive.map { it.name })
        assertTrue(m.grocery.single().checked)

        advanceTimeBy(KioskTodayModel.SETTLE_MILLIS + 1)
        runCurrent()
        assertTrue(m.groceryActive.isEmpty())
    }

    /** A failed write puts the row back exactly as it was. */
    @Test
    fun failedGroceryWriteRollsBack() = runTest {
        val milk = item("Milk")
        val m = KioskTodayModel(
            fetchChores = { emptyList() }, fetchMeals = { emptyList() },
            fetchGrocery = { listOf(milk) }, fetchGoals = { emptyList() }, fetchWeather = { null },
            setGroceryChecked = { _, _ -> offline() },
        )
        m.loadGrocery()
        m.toggleGrocery(milk.id, backgroundScope)
        assertFalse(m.grocery.single().checked)
        assertEquals(listOf("Milk"), m.groceryActive.map { it.name })
    }

    /** Blank input is ignored; a real name is trimmed, sent, and the list reloads. */
    @Test
    fun addGroceryTrimsAndReloads() = runTest {
        val sent = mutableListOf<String>()
        var rows = emptyList<ListItemDTO>()
        val m = KioskTodayModel(
            fetchChores = { emptyList() }, fetchMeals = { emptyList() },
            fetchGrocery = { rows }, fetchGoals = { emptyList() }, fetchWeather = { null },
            addGroceryItem = { name -> sent += name; rows = rows + item(name) },
        )
        m.addGrocery("   ")
        assertTrue(sent.isEmpty())
        m.addGrocery("  Milk \n")
        assertEquals(listOf("Milk"), sent)
        assertEquals(listOf("Milk"), m.grocery.map { it.name })
    }

    /** Weather keeps its prior reading when a refresh fails. */
    @Test
    fun weatherKeepsPriorOnFailure() = runTest {
        var fail = false
        val m = KioskTodayModel(
            fetchChores = { emptyList() }, fetchMeals = { emptyList() },
            fetchGrocery = { emptyList() }, fetchGoals = { emptyList() },
            fetchWeather = { if (fail) offline() else TodayApi.Weather(configured = true, tempF = 71.6) },
        )
        m.loadWeather()
        fail = true
        m.loadWeather()
        assertEquals(71.6, m.weather.value?.tempF)
    }
}
