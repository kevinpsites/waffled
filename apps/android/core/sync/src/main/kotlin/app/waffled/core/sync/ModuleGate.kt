package app.waffled.core.sync

import app.waffled.core.model.WaffledModule

/**
 * Per-household optional-module gate — the twin of the iOS `SyncManager.module(_:)`.
 *
 * Mirrors `apps/api/src/platform/modules.ts`. The server enforces independently, so this
 * is a UX gate; but if the two disagree the UI offers actions the server will reject.
 *
 * [loaded] is deliberately allowed to be false: before the household's flags arrive we
 * return the catalog defaults so the UI doesn't flash empty on cold start.
 */
data class ModuleGate(
    val flags: Map<WaffledModule, Boolean> = emptyMap(),
    val loaded: Boolean = false,
) {

    fun isOn(module: WaffledModule): Boolean {
        // A module that isn't built must never gate on, whatever the server says.
        if (!module.isAvailable) return false
        return flags[module] ?: module.defaultOn
    }

    /**
     * Rewards is a SUB-FLAG of chores, not a module of its own: chores must be on AND
     * the `chores.rewards` sub-flag enabled.
     */
    fun rewardsOn(subEnabled: Boolean): Boolean = isOn(WaffledModule.Chores) && subEnabled

    companion object {
        /** Build from the server's string-keyed flags (`GET /api/household/modules`). */
        fun fromServer(raw: Map<String, Boolean>): ModuleGate = ModuleGate(
            flags = raw.mapNotNull { (k, v) -> WaffledModule.fromKey(k)?.let { it to v } }.toMap(),
            loaded = true,
        )
    }
}
