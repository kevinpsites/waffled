package app.waffled.feature.kiosktoday

import app.waffled.core.network.RestState
import app.waffled.feature.kiosktoday.KioskColumn.Agenda
import app.waffled.feature.kiosktoday.KioskColumn.ChoreGrocery
import app.waffled.feature.kiosktoday.KioskColumn.Goal
import app.waffled.feature.kiosktoday.KioskColumn.Meals
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The iPad Today's per-device layout presets (iOS `DashLayout`, stored under
 * `waffled.kioskDashLayout`) and the column rules `KioskDashboard.dashRow` encodes.
 */
class KioskDashLayoutTest {

    @Test
    fun rawValuesMatchIosSoAStoredPrefCarriesOver() {
        assertEquals(listOf("balanced", "agenda", "meals", "goal"), DashLayout.entries.map { it.raw })
        assertEquals(
            listOf("Balanced", "Agenda-focused", "Meals-focused", "Goal-focused"),
            DashLayout.entries.map { it.label },
        )
    }

    @Test
    fun unknownOrMissingRawFallsBackToBalanced() {
        assertEquals(DashLayout.Balanced, DashLayout.parse(null))
        assertEquals(DashLayout.Balanced, DashLayout.parse("wide"))
        assertEquals(DashLayout.Goal, DashLayout.parse("goal"))
    }

    @Test
    fun columnOrderAndWeightsPerPreset() {
        assertEquals(listOf(Agenda to 1f, Meals to 1f, ChoreGrocery to 1f), DashLayout.Balanced.columns)
        assertEquals(listOf(Agenda to 1.7f, Meals to 0.95f, ChoreGrocery to 0.95f), DashLayout.Agenda.columns)
        assertEquals(listOf(Meals to 1.5f, Agenda to 1f, ChoreGrocery to 1f), DashLayout.Meals.columns)
        assertEquals(listOf(Goal to 1.5f, Agenda to 1f, ChoreGrocery to 1f), DashLayout.Goal.columns)
    }

    /** Picking a goal from the card must never drift the wall off the goal-focused view. */
    @Test
    fun pinningAGoalAlsoForcesTheGoalLayout() {
        val prefs = KioskDashPrefs(DashLayout.Meals, pinnedGoalId = "").pinning("g1")
        assertEquals(KioskDashPrefs(DashLayout.Goal, "g1"), prefs)
        assertEquals(KioskDashPrefs(DashLayout.Goal, ""), prefs.pinning(""))
    }

    private val at = Instant.parse("2026-07-16T12:00:00Z")

    /** The goal column shows tonight while it might exist, else the week's dinners. */
    @Test
    fun goalColumnShowsTonightUnlessConfirmedAbsent() {
        assertTrue(KioskTodayRules.goalColumnShowsTonight(hasTonight = true, RestState.Ready(at)))
        assertTrue(KioskTodayRules.goalColumnShowsTonight(hasTonight = false, RestState.Loading))
        assertTrue(KioskTodayRules.goalColumnShowsTonight(hasTonight = false, RestState.Offline(null)))
        assertFalse(KioskTodayRules.goalColumnShowsTonight(hasTonight = false, RestState.Empty(at)))
    }

    @Test
    fun goalCardHidesOnlyWhenAFailedFetchLeftNothing() {
        assertTrue(KioskTodayRules.showsGoalCard(hasGoals = true, RestState.Offline(null)))
        assertTrue(KioskTodayRules.showsGoalCard(hasGoals = false, RestState.Loading))
        assertTrue(KioskTodayRules.showsGoalCard(hasGoals = false, RestState.Empty(at)))
        assertFalse(KioskTodayRules.showsGoalCard(hasGoals = false, RestState.Error("x")))
    }

    /** "N to buy" only once a count has been confirmed at least once. */
    @Test
    fun groceryCountOnlyWhenConfirmed() {
        assertEquals("3 to buy", KioskTodayRules.groceryTrailing(3, RestState.Ready(at)))
        assertEquals("3 to buy", KioskTodayRules.groceryTrailing(3, RestState.Stale(at, "x")))
        assertEquals(null, KioskTodayRules.groceryTrailing(0, RestState.Loading))
        assertEquals(null, KioskTodayRules.groceryTrailing(0, RestState.Offline(null)))
    }

    /** A card's empty copy is true only on an authoritative answer; a failure shows nothing. */
    @Test
    fun emptyCopyIsAuthoritativeOnly() {
        assertEquals("No chores today", KioskTodayRules.emptyCopy(RestState.Empty(at), "No chores today"))
        assertEquals("Loading…", KioskTodayRules.emptyCopy(RestState.Loading, "No chores today"))
        assertEquals(null, KioskTodayRules.emptyCopy(RestState.Offline(null), "No chores today"))
    }
}
