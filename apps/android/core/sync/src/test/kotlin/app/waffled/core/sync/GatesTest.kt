package app.waffled.core.sync

import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledModule
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Module + capability gates. These mirror `apps/api/src/platform/modules.ts` and the web
 * `can()`; the server enforces independently, so these are UX gates only — but they must
 * agree, or the UI offers actions the server will reject.
 */
class ModuleGateTest {

    @Test
    fun beforeFlagsLoadTheCatalogDefaultsApply() {
        // Optimistic: return catalog defaults until the household's flags arrive, so the
        // UI doesn't flash empty on cold start.
        val gate = ModuleGate(flags = emptyMap(), loaded = false)
        assertTrue(gate.isOn(WaffledModule.Chores))   // default on
        assertTrue(gate.isOn(WaffledModule.Meals))    // default on
        assertFalse(gate.isOn(WaffledModule.Pantry))  // default off
        assertFalse(gate.isOn(WaffledModule.FamilyNight))
        assertFalse(gate.isOn(WaffledModule.WaffledBites))
    }

    @Test
    fun householdFlagsOverrideDefaults() {
        val gate = ModuleGate(
            flags = mapOf(WaffledModule.Pantry to true, WaffledModule.Meals to false),
            loaded = true,
        )
        assertTrue(gate.isOn(WaffledModule.Pantry))
        assertFalse(gate.isOn(WaffledModule.Meals))
    }

    @Test
    fun anUnavailableModuleIsAlwaysOffEvenIfTheServerSaysOn() {
        // `quotes` is declared but not built — it must never gate on.
        val gate = ModuleGate(flags = mapOf(WaffledModule.Quotes to true), loaded = true)
        assertFalse(gate.isOn(WaffledModule.Quotes))
    }

    @Test
    fun rewardsIsASubFlagOfChoresNotItsOwnModule() {
        assertTrue(ModuleGate(mapOf(WaffledModule.Chores to true), true).rewardsOn(subEnabled = true))
        // Chores off ⇒ rewards off, regardless of the sub-flag.
        assertFalse(ModuleGate(mapOf(WaffledModule.Chores to false), true).rewardsOn(subEnabled = true))
        // Chores on but the sub-flag off ⇒ off.
        assertFalse(ModuleGate(mapOf(WaffledModule.Chores to true), true).rewardsOn(subEnabled = false))
    }

    @Test
    fun flagsParseFromTheServersStringKeys() {
        val gate = ModuleGate.fromServer(mapOf("pantry" to true, "notAModule" to true))
        assertTrue(gate.isOn(WaffledModule.Pantry))
        assertTrue(gate.loaded)
    }
}

class CapabilityGateTest {

    private fun person(admin: Boolean, caps: List<String>) =
        Person(id = "p1", name = "Sam", isAdmin = admin, capabilities = caps)

    @Test
    fun adminCanDoEverything() {
        val p = person(admin = true, caps = emptyList())
        Capability.all.forEach { assertTrue(p.can(it), "admin should have $it") }
    }

    @Test
    fun aGrantedCapabilityIsAllowed() {
        val p = person(admin = false, caps = listOf(Capability.CHORE_APPROVE))
        assertTrue(p.can(Capability.CHORE_APPROVE))
    }

    @Test
    fun capabilitiesGateIndependently() {
        // A chores-only grant shows the approvals queue, but only its chore buttons.
        val p = person(admin = false, caps = listOf(Capability.CHORE_APPROVE))
        assertTrue(p.can(Capability.CHORE_APPROVE))
        assertFalse(p.can(Capability.REWARD_APPROVE))
        assertFalse(p.can(Capability.CHORE_MANAGE))
    }

    @Test
    fun noCapabilitiesMeansNoApprovalUi() {
        val p = person(admin = false, caps = emptyList())
        assertFalse(Capability.all.any { p.can(it) })
    }

    @Test
    fun displayEmojiFallsBackToAnInitial() {
        assertEquals("🐷", Person(id = "1", name = "Sam", avatarEmoji = "🐷").displayEmoji)
        assertEquals("S", Person(id = "1", name = "sam").displayEmoji)
        assertEquals("?", Person(id = "1", name = "  ").displayEmoji)
    }
}
