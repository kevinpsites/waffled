package app.waffled.feature.settings

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** One row of Settings → Modules. Copy is iOS `WaffledModule` (itself lifted from modules.ts). */
data class ModuleInfo(
    val key: String,
    val name: String,
    val icon: String,
    val summary: String,
    val defaultOn: Boolean,
    val isAvailable: Boolean = true,
)

/**
 * The module catalog as Settings shows it. Wider than `core:model`'s `WaffledModule`,
 * which predates `rhythms` and `weeklyPlanning`; keep both in step with modules.ts.
 */
object ModuleCatalog {
    val all = listOf(
        ModuleInfo("chores", "Chores & Tasks", "✅", "The Tasks board — assignable chores, photo proof, approvals, and stars.", defaultOn = true),
        ModuleInfo("goals", "Goals", "🎯", "Personal and family goals with progress, streaks, and checklists.", defaultOn = true),
        ModuleInfo("meals", "Meals & Recipes", "🍽️", "Recipe library, weekly meal planning, and meals on the calendar.", defaultOn = true),
        ModuleInfo("lists", "Lists & Groceries", "🛒", "Shared lists and the auto-built grocery board.", defaultOn = true),
        ModuleInfo("pantry", "Pantry", "🥫", "Track what's on hand (freezer/fridge/pantry) and feed meal planning.", defaultOn = false),
        ModuleInfo("rhythms", "Rhythms", "🔁", "The things that should keep happening — the air filter, trash night, a quarterly self-care day — with a place to confirm each one is actually handled.", defaultOn = false),
        ModuleInfo("familyNight", "Family Night", "🏡", "A weekly family gathering with a rotating agenda and a Today card.", defaultOn = false),
        ModuleInfo("weeklyPlanning", "Weekly Planning", "🗓️", "A guided session that walks the family through deciding the week ahead — loose ends, the calendar, meals, tasks and goals — reading from the modules you already use.", defaultOn = false),
        ModuleInfo("waffledBites", "Waffled-Bites", "🧇", "Pair a kid's companion touchscreen — quiet time, wake-light, nightlight, alarm, and sound machine.", defaultOn = false),
        ModuleInfo("quotes", "Daily quote", "💬", "A daily quote or snippet on the Today tab.", defaultOn = false, isAvailable = false),
    )

    val available: List<ModuleInfo> get() = all.filter { it.isAvailable }
    val planned: List<ModuleInfo> get() = all.filter { !it.isAvailable }

    fun info(key: String): ModuleInfo? = all.firstOrNull { it.key == key }

    /** `flags[key] ?? defaultOn`; a planned module never gates on. */
    fun isOn(key: String, flags: Map<String, Boolean>): Boolean {
        val info = info(key) ?: return flags[key] ?: false
        if (!info.isAvailable) return false
        return flags[key] ?: info.defaultOn
    }
}

/**
 * Settings → Modules state: optimistic toggles that adopt the server's merged map, or
 * roll back on failure. [onChanged] receives the new map so `app`'s module gate (nav,
 * Today cards) updates without a relaunch.
 */
class ModulesModel(
    private val fetch: suspend () -> SettingsApi.HouseholdModules,
    private val setModules: suspend (Map<String, Boolean>) -> Map<String, Boolean>,
    private val setRewards: suspend (Boolean) -> Boolean,
    private val onChanged: (Map<String, Boolean>) -> Unit = {},
) {
    data class State(
        val flags: Map<String, Boolean> = emptyMap(),
        /** Null until loaded. */
        val rewards: Boolean? = null,
        val loading: Boolean = true,
        /** Keys mid-write, including `"rewards"`. */
        val saving: Set<String> = emptySet(),
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val flags get() = _state.value.flags
    val rewards get() = _state.value.rewards
    val loading get() = _state.value.loading
    val saving get() = _state.value.saving

    fun isOn(module: ModuleInfo): Boolean = ModuleCatalog.isOn(module.key, flags)

    suspend fun load() {
        val m = runCatching { fetch() }.getOrNull()
        _state.update {
            if (m == null) it.copy(loading = false)
            else it.copy(flags = m.modules, rewards = m.rewards, loading = false)
        }
    }

    suspend fun setModule(key: String, on: Boolean) {
        val prev = flags[key]
        _state.update { it.copy(flags = it.flags + (key to on), saving = it.saving + key) }
        val merged = runCatching { setModules(mapOf(key to on)) }.getOrNull()
        _state.update {
            val restored = if (prev == null) it.flags - key else it.flags + (key to prev)
            it.copy(flags = merged ?: restored, saving = it.saving - key)
        }
        if (merged != null) onChanged(merged)
    }

    suspend fun setRewards(on: Boolean) {
        val prev = rewards
        _state.update { it.copy(rewards = on, saving = it.saving + REWARDS) }
        val saved = runCatching { setRewards.invoke(on) }.getOrNull()
        _state.update { it.copy(rewards = saved ?: prev, saving = it.saving - REWARDS) }
        if (saved != null) onChanged(flags)
    }

    private companion object {
        const val REWARDS = "rewards"
    }
}
