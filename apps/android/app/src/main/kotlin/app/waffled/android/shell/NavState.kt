package app.waffled.android.shell

/**
 * The phone's navigation: the selected tab plus one push stack per tab — the twin of the
 * iOS `todayPath` / `mealsPath` / `modulePath` / `familyPath` lifted to `AppRoot`.
 *
 * Hand-rolled rather than Navigation-Compose because routes carry DTOs (a goal, a recipe
 * summary) that a string route can't, and an immutable value is trivially testable.
 */
data class NavState<R>(
    val tab: String,
    private val stacks: Map<String, List<R>> = emptyMap(),
) {
    fun stackOf(tab: String): List<R> = stacks[tab].orEmpty()

    /** The pushed screen on the current tab, or null at the tab's root. */
    val top: R? get() = stackOf(tab).lastOrNull()

    fun push(route: R): NavState<R> = copy(stacks = stacks + (tab to stackOf(tab) + route))

    fun replaceTop(route: R): NavState<R> =
        copy(stacks = stacks + (tab to stackOf(tab).dropLast(1) + route))

    /** One step back, or null at the root so the system Back falls through to the OS. */
    fun pop(): NavState<R>? =
        if (stackOf(tab).isEmpty()) null else copy(stacks = stacks + (tab to stackOf(tab).dropLast(1)))

    /** Tap a tab: switch to it, or — when it is already selected — pop it to root. */
    fun select(tab: String): NavState<R> =
        if (tab == this.tab) copy(stacks = stacks - tab) else copy(tab = tab)

    /** Land on [tab] with [route] pushed over its root (a deep link). */
    fun open(tab: String, route: R): NavState<R> =
        copy(tab = tab, stacks = stacks + (tab to listOf(route)))
}
