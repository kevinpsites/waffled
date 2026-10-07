package app.waffled.feature.settings

import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Settings → Modules: optimistic toggles that adopt the server's map or roll back. */
class ModulesModelTest {

    private fun fetched(modules: Map<String, Boolean> = emptyMap(), rewards: Boolean = true) =
        SettingsApi.HouseholdModules(modules = modules, rewards = rewards)

    @Test
    fun `catalog lists available modules in iOS order with quotes as coming soon`() {
        assertEquals(
            listOf("chores", "goals", "meals", "lists", "pantry", "rhythms", "familyNight", "weeklyPlanning", "waffledBites"),
            ModuleCatalog.available.map { it.key },
        )
        assertEquals(listOf("quotes"), ModuleCatalog.planned.map { it.key })
    }

    @Test
    fun `opt-in modules default off and core modules default on`() {
        val model = ModulesModel(fetch = { fetched() }, setModules = { it }, setRewards = { it })
        assertTrue(model.isOn(ModuleCatalog.info("chores")!!))
        assertFalse(model.isOn(ModuleCatalog.info("pantry")!!))
        assertFalse(model.isOn(ModuleCatalog.info("weeklyPlanning")!!))
        assertFalse(model.isOn(ModuleCatalog.info("rhythms")!!))
    }

    @Test
    fun `load adopts server flags and rewards`() = runTest {
        val model = ModulesModel(
            fetch = { fetched(mapOf("pantry" to true, "chores" to false), rewards = false) },
            setModules = { it }, setRewards = { it },
        )
        assertTrue(model.loading)
        model.load()
        assertFalse(model.loading)
        assertTrue(model.isOn(ModuleCatalog.info("pantry")!!))
        assertFalse(model.isOn(ModuleCatalog.info("chores")!!))
        assertEquals(false, model.rewards)
    }

    @Test
    fun `failed load stops loading and keeps defaults`() = runTest {
        val model = ModulesModel(fetch = { error("offline") }, setModules = { it }, setRewards = { it })
        model.load()
        assertFalse(model.loading)
        assertTrue(model.isOn(ModuleCatalog.info("chores")!!))
        assertNull(model.rewards)
    }

    @Test
    fun `successful toggle adopts the merged server map and reports it`() = runTest {
        var reported: Map<String, Boolean>? = null
        val model = ModulesModel(
            fetch = { fetched() },
            setModules = { patch -> mapOf("goals" to false) + patch },
            setRewards = { it },
            onChanged = { reported = it },
        )
        model.load()

        model.setModule("pantry", true)

        assertEquals(mapOf("goals" to false, "pantry" to true), model.flags)
        assertEquals(model.flags, reported)
        assertFalse("pantry" in model.saving)
    }

    @Test
    fun `failed toggle rolls back to the prior value`() = runTest {
        var reported = false
        val model = ModulesModel(
            fetch = { fetched(mapOf("pantry" to false)) },
            setModules = { error("403") },
            setRewards = { it },
            onChanged = { reported = true },
        )
        model.load()

        model.setModule("pantry", true)

        assertEquals(false, model.flags["pantry"])
        assertFalse(reported)
        assertTrue(model.saving.isEmpty())
    }

    @Test
    fun `failed toggle of a never-set key removes the optimistic value`() = runTest {
        val model = ModulesModel(fetch = { fetched() }, setModules = { error("403") }, setRewards = { it })
        model.load()
        model.setModule("familyNight", true)
        assertFalse("familyNight" in model.flags)
    }

    @Test
    fun `rewards sub-toggle adopts the server answer or rolls back`() = runTest {
        val ok = ModulesModel(fetch = { fetched(rewards = true) }, setModules = { it }, setRewards = { false })
        ok.load()
        ok.setRewards(false)
        assertEquals(false, ok.rewards)

        val failing = ModulesModel(fetch = { fetched(rewards = true) }, setModules = { it }, setRewards = { error("x") })
        failing.load()
        failing.setRewards(false)
        assertEquals(true, failing.rewards)
        assertFalse("rewards" in failing.saving)
    }
}
