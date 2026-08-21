package app.waffled.android.shell

import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The phone bar has a FLEX slot: one module tab between Calendar and Family. It shows
 * Meals when enabled, otherwise backfills Goals → Chores → Lists → Pantry.
 *
 * The bar must stay at five slots whatever happens, because the capture FAB is centred
 * on the middle one — a missing tab would visibly shift it off-centre.
 */
class FlexSlotTest {

    private fun gate(vararg on: Pair<WaffledModule, Boolean>) =
        ModuleGate(flags = on.toMap(), loaded = true)

    @Test
    fun mealsWinsWhenEnabled() {
        val g = gate(
            WaffledModule.Meals to true,
            WaffledModule.Goals to true,
            WaffledModule.Chores to true,
        )
        assertEquals(WaffledModule.Meals, FlexSlot.resolve(g))
    }

    @Test
    fun backfillsToGoalsWhenMealsIsOff() {
        val g = gate(WaffledModule.Meals to false, WaffledModule.Goals to true)
        assertEquals(WaffledModule.Goals, FlexSlot.resolve(g))
    }

    @Test
    fun backfillOrderIsGoalsThenChoresThenListsThenPantry() {
        assertEquals(
            WaffledModule.Chores,
            FlexSlot.resolve(
                gate(
                    WaffledModule.Meals to false,
                    WaffledModule.Goals to false,
                    WaffledModule.Chores to true,
                ),
            ),
        )
        assertEquals(
            WaffledModule.Lists,
            FlexSlot.resolve(
                gate(
                    WaffledModule.Meals to false,
                    WaffledModule.Goals to false,
                    WaffledModule.Chores to false,
                    WaffledModule.Lists to true,
                ),
            ),
        )
        assertEquals(
            WaffledModule.Pantry,
            FlexSlot.resolve(
                gate(
                    WaffledModule.Meals to false,
                    WaffledModule.Goals to false,
                    WaffledModule.Chores to false,
                    WaffledModule.Lists to false,
                    WaffledModule.Pantry to true,
                ),
            ),
        )
    }

    @Test
    fun everythingOffLeavesTheSlotEmpty() {
        val g = gate(
            WaffledModule.Meals to false,
            WaffledModule.Goals to false,
            WaffledModule.Chores to false,
            WaffledModule.Lists to false,
            WaffledModule.Pantry to false,
        )
        assertNull(FlexSlot.resolve(g))
    }

    @Test
    fun theBarAlwaysHasFourTabsSoTheFabStaysCentred() {
        // Even with every optional module off, the bar must not collapse — the flex slot
        // renders a disabled placeholder rather than disappearing.
        val allOff = gate(
            WaffledModule.Meals to false,
            WaffledModule.Goals to false,
            WaffledModule.Chores to false,
            WaffledModule.Lists to false,
            WaffledModule.Pantry to false,
        )
        assertEquals(4, FlexSlot.tabs(allOff).size)
        assertEquals(4, FlexSlot.tabs(gate(WaffledModule.Meals to true)).size)
    }

    @Test
    fun defaultsApplyBeforeModuleFlagsLoad() {
        // Meals defaults on, so a cold start shows Meals rather than an empty slot.
        assertEquals(WaffledModule.Meals, FlexSlot.resolve(ModuleGate(loaded = false)))
    }
}
