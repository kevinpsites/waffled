package app.waffled.feature.today

import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate

/**
 * The Today dashboard's layout rules — which cards appear, in what order, and which pair
 * up 2-up. Ported from `TodayView.moduleAllows` / `cardRows` / `loadLayout`.
 *
 * Deliberately free of Compose: the layout is server-driven and user-customisable, so it
 * is the part with real behaviour to test. The screen only renders the result.
 */
object TodayCards {

    const val AGENDA = "agenda"
    const val COUNTDOWNS = "countdowns"
    const val TONIGHT = "tonight"
    const val CHORES = "chores"
    const val GROCERY = "grocery"
    const val LISTS = "lists"
    const val GOALS = "goals"
    const val PANTRY = "pantry"
    const val FAMILY_NIGHT = "familyNight"

    /** Known so it gates and labels correctly; Android has no Rhythms card to wire yet. */
    const val RHYTHMS = "rhythms"

    /** The order a server that has never been customised resolves to. */
    val defaultOrder = listOf(AGENDA, TONIGHT, CHORES, GROCERY, GOALS)

    /** Display names for the Customize sheet. */
    val labels = mapOf(
        AGENDA to "Agenda",
        COUNTDOWNS to "Countdowns",
        TONIGHT to "Tonight's dinner",
        CHORES to "Chores",
        GROCERY to "Grocery",
        LISTS to "Lists",
        GOALS to "Goals",
        PANTRY to "Pantry",
        FAMILY_NIGHT to "Family Night",
        RHYTHMS to "Rhythms",
    )

    /** A newer server may send a card key this build doesn't know; show the key, don't crash. */
    fun label(key: String): String = labels[key] ?: key

    /** The two compact cards that sit side by side when they are adjacent. */
    val smallCards = setOf(CHORES, GROCERY)

    /**
     * A card's optional-module gate.
     *
     * Agenda and countdowns are calendar-backed and **never** gated: Calendar is core, not
     * a module, so gating them would blank the home screen of a household that turned
     * meals off.
     */
    fun moduleAllows(key: String, modules: ModuleGate): Boolean = when (key) {
        TONIGHT -> modules.isOn(WaffledModule.Meals)
        CHORES -> modules.isOn(WaffledModule.Chores)
        GROCERY, LISTS -> modules.isOn(WaffledModule.Lists)
        GOALS -> modules.isOn(WaffledModule.Goals)
        PANTRY -> modules.isOn(WaffledModule.Pantry)
        FAMILY_NIGHT -> modules.isOn(WaffledModule.FamilyNight)
        RHYTHMS -> modules.isOn(WaffledModule.Rhythms)
        else -> true
    }

    /** One rendered row: a full-width card, or the two compact ones side by side. */
    sealed interface CardRow {
        val id: String

        data class Single(val key: String) : CardRow {
            override val id: String get() = key
        }

        data class Pair(val first: String, val second: String) : CardRow {
            override val id: String get() = "$first+$second"
        }
    }

    /**
     * Visible cards in the saved order, pairing the two compact cards into a 2-up row when
     * they are adjacent — so the default look is preserved.
     *
     * [available] is the set of card keys the host has actually wired. A key with no
     * content is skipped outright rather than rendering an empty box, which would leave a
     * phantom gap in the spaced column (iOS's `default: EmptyView()` did exactly that).
     */
    fun rows(
        order: List<String>,
        hidden: Set<String>,
        modules: ModuleGate,
        available: Set<String> = labels.keys,
        /** The chores card is showing one person's list, which needs the full width. */
        wideChores: Boolean = false,
    ): List<CardRow> {
        val visible = order.filter {
            it !in hidden && moduleAllows(it, modules) && it in available
        }
        val small = if (wideChores) smallCards - CHORES else smallCards
        val out = mutableListOf<CardRow>()
        var i = 0
        while (i < visible.size) {
            val key = visible[i]
            val next = visible.getOrNull(i + 1)
            if (key in small && next != null && next in small) {
                out += CardRow.Pair(key, next)
                i += 2
            } else {
                out += CardRow.Single(key)
                i += 1
            }
        }
        return out
    }

    /**
     * Surface cards that a server predating them omits from its card set.
     *
     * Each is inserted only when the order doesn't already carry it AND the user hasn't
     * deliberately hidden it. Note the three fallbacks land in **different** places when
     * their anchor is missing: countdowns goes to the front, pantry to the end.
     */
    fun applyFallbacks(order: List<String>, hidden: Set<String>): List<String> {
        val out = order.toMutableList()

        fun insertMissing(key: String, position: (List<String>) -> Int) {
            if (key in out || key in hidden) return
            out.add(position(out).coerceIn(0, out.size), key)
        }

        // Right after the agenda — or at the very front if there is no agenda card.
        insertMissing(COUNTDOWNS) { list -> list.indexOf(AGENDA).takeIf { it >= 0 }?.plus(1) ?: 0 }
        // Right after grocery — or at the END if there is no grocery card, not the front.
        insertMissing(PANTRY) { list -> list.indexOf(GROCERY).takeIf { it >= 0 }?.plus(1) ?: list.size }
        insertMissing(FAMILY_NIGHT) { list -> list.size }

        return out
    }

    /**
     * Move the card at [index] one slot in [delta]'s direction, for the Customize sheet's
     * reorder controls. Out-of-range moves are a no-op — never a wrap-around.
     */
    fun moved(order: List<String>, index: Int, delta: Int): List<String> {
        val target = index + delta
        if (index !in order.indices || target !in order.indices) return order
        val out = order.toMutableList()
        out[index] = order[target]
        out[target] = order[index]
        return out
    }

    /**
     * The review banner's count → headline. `recap` = calendar events to log against a
     * goal; `suggestions` = events that might count toward one. Shared wording so the two
     * banners (phone and tablet) can't drift, as they did on iOS.
     */
    fun reviewRecapTitle(recap: Int, suggestions: Int): String = when {
        recap > 0 && suggestions > 0 -> "$recap to review · $suggestions to link"
        recap > 0 -> if (recap == 1) "1 event to log" else "$recap events to log"
        else -> if (suggestions == 1) "1 event might count" else "$suggestions events might count"
    }
}
