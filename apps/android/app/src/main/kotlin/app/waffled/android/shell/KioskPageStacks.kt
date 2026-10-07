package app.waffled.android.shell

import app.waffled.feature.kiosk.KioskNav
import app.waffled.feature.kiosktoday.KioskTodayDestination

/**
 * One drill-in stack per tablet rail page, held ABOVE `KioskRoot` so a page left and
 * re-entered comes back where it was (the shell disposes the page on every switch).
 *
 * [seenResets] records each page's last reset key: the shell bumps it on a re-tap of the
 * open item, which pops that page to root. Its counters are not saved across a rotation,
 * so a key that fell back is adopted without popping.
 */
data class KioskPageStacks<R>(
    private val stacks: Map<KioskNav, List<R>> = emptyMap(),
    private val seenResets: Map<KioskNav, Int> = emptyMap(),
) {
    fun stackOf(nav: KioskNav): List<R> = stacks[nav].orEmpty()

    fun top(nav: KioskNav): R? = stackOf(nav).lastOrNull()

    fun push(nav: KioskNav, route: R): KioskPageStacks<R> = copy(stacks = stacks + (nav to stackOf(nav) + route))

    fun pop(nav: KioskNav): KioskPageStacks<R> =
        if (stackOf(nav).isEmpty()) this else copy(stacks = stacks + (nav to stackOf(nav).dropLast(1)))

    fun replaceTop(nav: KioskNav, route: R): KioskPageStacks<R> =
        copy(stacks = stacks + (nav to stackOf(nav).dropLast(1) + route))

    fun observeReset(nav: KioskNav, key: Int): KioskPageStacks<R> {
        val seen = seenResets[nav]
        if (seen == key) return this
        val popped = if (seen != null && key > seen) stacks - nav else stacks
        return copy(stacks = popped, seenResets = seenResets + (nav to key))
    }
}

/** Where a kiosk Today card's "see all" lands on the rail. */
fun kioskNavFor(destination: KioskTodayDestination): KioskNav = when (destination) {
    KioskTodayDestination.Calendar -> KioskNav.Calendar
    KioskTodayDestination.Meals -> KioskNav.Meals
    KioskTodayDestination.Tasks -> KioskNav.Tasks
    KioskTodayDestination.Lists -> KioskNav.Lists
    KioskTodayDestination.Goals -> KioskNav.Goals
    KioskTodayDestination.Pantry -> KioskNav.Pantry
    KioskTodayDestination.Rhythms -> KioskNav.Rhythms
}
