package app.waffled.android.shell

import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FamilyGatesTest {

    @Test
    fun weeklyPlanningTileFollowsItsModule() {
        val on = ModuleGate(flags = mapOf(WaffledModule.WeeklyPlanning to true), loaded = true)
        val off = ModuleGate(flags = mapOf(WaffledModule.WeeklyPlanning to false), loaded = true)
        assertTrue(familyGates(on, rewardsSub = true).weeklyPlanning)
        assertFalse(familyGates(off, rewardsSub = true).weeklyPlanning)
    }
}
