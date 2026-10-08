package app.waffled.feature.kiosk

import app.waffled.core.sync.ModuleGate
import app.waffled.core.sync.SyncState

/**
 * The shell's selection plus a per-page reset counter. Re-tapping the open rail item
 * pops that page back to its root (iOS clears the page's nav path or bumps `navReset`);
 * a page key-ing its content on [resetKey] gets the same effect.
 */
data class KioskShellNav(
    val selection: KioskNav = KioskNav.Today,
    val resets: Map<KioskNav, Int> = emptyMap(),
) {
    fun resetKey(nav: KioskNav): Int = resets[nav] ?: 0

    /** A rail / bottom-bar tap. */
    fun tap(item: KioskNav): KioskShellNav =
        if (item != selection) copy(selection = item) else copy(resets = resets + (item to resetKey(item) + 1))

    /** A jump from inside a page (More grid, a Today card) — never a reset. */
    fun navigate(item: KioskNav): KioskShellNav = copy(selection = item)

    /** A module switched off under the open page falls back to Today. */
    fun corrected(modules: ModuleGate, rewardsOn: Boolean): KioskShellNav =
        if (KioskRail.moduleEnabled(selection, modules, rewardsOn)) this else copy(selection = KioskNav.Today)
}

object KioskBoot {
    /** How long the boot cover waits before turning into an escapable error. */
    const val STALL_AFTER_MS = 8_000L

    /** The cold-start window: no members yet and sync still idle or connecting. */
    fun isBooting(membersEmpty: Boolean, state: SyncState): Boolean =
        membersEmpty && (state == SyncState.Idle || state == SyncState.Connecting)

    fun firstName(name: String): String = name.trim().split(' ').firstOrNull().orEmpty()
}
