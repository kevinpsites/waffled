package app.waffled.android.session

import app.waffled.core.model.HouseholdWeekStart
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The household week start every planner and chart is handed. The synced row wins; the REST
 * session read stands in while PowerSync is offline; and with neither it stays UNKNOWN —
 * null, never a guessed Sunday (the meals planners rebuild both cuts on unknown).
 */
class HouseholdWeekTest {

    @Test
    fun syncedRowWins() {
        assertEquals(HouseholdWeekStart.Monday, IdentityStore.weekStart(synced = "monday", rest = "sunday"))
    }

    @Test
    fun restStandsInWhileSyncIsOffline() {
        assertEquals(HouseholdWeekStart.Monday, IdentityStore.weekStart(synced = null, rest = "monday"))
    }

    @Test
    fun unknownStaysNull() {
        assertNull(IdentityStore.weekStart(synced = null, rest = null))
    }
}
