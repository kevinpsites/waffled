package app.waffled.core.model

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * KEEP IN SYNC with `apps/api/src/platform/modules.ts` (`MODULES`). A key missing here
 * makes `ModuleGate` drop the household's flag, so the module can never be turned on.
 */
class ModulesTest {

    @Test
    fun theModuleCatalogMatchesTheServer() {
        val expected = mapOf(
            "pantry" to false,
            "chores" to true,
            "goals" to true,
            "meals" to true,
            "lists" to true,
            "familyNight" to false,
            "quotes" to false,
            "waffledBites" to false,
            "rhythms" to false,
            "weeklyPlanning" to false,
        )
        assertEquals(expected, WaffledModule.entries.associate { it.key to it.defaultOn })
    }

    @Test
    fun theNewModulesParseFromTheirServerKeys() {
        assertEquals(WaffledModule.Rhythms, WaffledModule.fromKey("rhythms"))
        assertEquals(WaffledModule.WeeklyPlanning, WaffledModule.fromKey("weeklyPlanning"))
    }
}
