package app.waffled.feature.today

import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The Today dashboard's layout rules, which the server drives and the user customises:
 * which cards appear (module gating + hide), in what order, and which pair up 2-up.
 *
 * Ported from `TodayView.moduleAllows` / `cardRows` / `loadLayout`'s fallbacks. Pure
 * logic on purpose — the composable only reads the result.
 */
class TodayCardsTest {

    private fun gate(vararg off: WaffledModule) = ModuleGate(
        flags = WaffledModule.entries.associateWith { it !in off },
        loaded = true,
    )

    private val allOn = gate()

    // ---- module gating ----------------------------------------------------------

    @Test
    fun eachOptionalCardGatesOnItsModule() {
        assertFalse(TodayCards.moduleAllows("tonight", gate(WaffledModule.Meals)))
        assertFalse(TodayCards.moduleAllows("chores", gate(WaffledModule.Chores)))
        assertFalse(TodayCards.moduleAllows("grocery", gate(WaffledModule.Lists)))
        assertFalse(TodayCards.moduleAllows("lists", gate(WaffledModule.Lists)))
        assertFalse(TodayCards.moduleAllows("goals", gate(WaffledModule.Goals)))
        assertFalse(TodayCards.moduleAllows("pantry", gate(WaffledModule.Pantry)))
        assertFalse(TodayCards.moduleAllows("familyNight", gate(WaffledModule.FamilyNight)))

        for (key in TodayCards.labels.keys) assertTrue(TodayCards.moduleAllows(key, allOn), key)
    }

    /**
     * Agenda and countdowns are Calendar, which is core — never a module. Gating them
     * would blank the home screen for a household that turned meals off.
     */
    @Test
    fun agendaAndCountdownsAreNeverGated() {
        val everythingOff = ModuleGate(
            flags = WaffledModule.entries.associateWith { false },
            loaded = true,
        )
        assertTrue(TodayCards.moduleAllows("agenda", everythingOff))
        assertTrue(TodayCards.moduleAllows("countdowns", everythingOff))
    }

    /** A card whose module is off must not render at all. */
    @Test
    fun rowsDropCardsWhoseModuleIsOff() {
        val rows = TodayCards.rows(
            order = listOf("agenda", "tonight", "chores", "grocery", "goals"),
            hidden = emptySet(),
            modules = gate(WaffledModule.Meals, WaffledModule.Goals),
        )
        assertEquals(listOf("agenda", "chores+grocery"), rows.map { it.id })
    }

    @Test
    fun rowsDropHiddenCards() {
        val rows = TodayCards.rows(
            order = listOf("agenda", "tonight", "chores"),
            hidden = setOf("tonight"),
            modules = allOn,
        )
        assertEquals(listOf("agenda", "chores"), rows.map { it.id })
    }

    /**
     * A card the host hasn't wired yet (another feature module owns it) is skipped
     * outright rather than rendering an empty box — iOS's `default: EmptyView()` left a
     * phantom gap in the spaced column.
     */
    @Test
    fun rowsSkipUnavailableCards() {
        val rows = TodayCards.rows(
            order = listOf("agenda", "countdowns", "chores"),
            hidden = emptySet(),
            modules = allOn,
            available = setOf("agenda", "chores"),
        )
        assertEquals(listOf("agenda", "chores"), rows.map { it.id })
    }

    // ---- 2-up pairing -----------------------------------------------------------

    @Test
    fun adjacentSmallCardsPairUp() {
        val rows = TodayCards.rows(
            order = listOf("agenda", "chores", "grocery", "goals"),
            hidden = emptySet(),
            modules = allOn,
        )
        assertEquals(
            listOf(
                TodayCards.CardRow.Single("agenda"),
                TodayCards.CardRow.Pair("chores", "grocery"),
                TodayCards.CardRow.Single("goals"),
            ),
            rows,
        )
    }

    @Test
    fun nonAdjacentSmallCardsDoNotPair() {
        val rows = TodayCards.rows(
            order = listOf("chores", "tonight", "grocery"),
            hidden = emptySet(),
            modules = allOn,
        )
        assertEquals(listOf("chores", "tonight", "grocery"), rows.map { it.id })
    }

    /** Hiding one half of a pair leaves the other as a full-width single. */
    @Test
    fun aLoneSmallCardStaysSingle() {
        val rows = TodayCards.rows(
            order = listOf("chores", "grocery"),
            hidden = setOf("grocery"),
            modules = allOn,
        )
        assertEquals(listOf(TodayCards.CardRow.Single("chores")), rows)
    }

    /** Gating (not just hiding) also breaks a pair. */
    @Test
    fun aModuleGateBreaksAPair() {
        val rows = TodayCards.rows(
            order = listOf("chores", "grocery"),
            hidden = emptySet(),
            modules = gate(WaffledModule.Lists),
        )
        assertEquals(listOf(TodayCards.CardRow.Single("chores")), rows)
    }

    // ---- fallbacks for a server whose card set predates a card ------------------

    @Test
    fun countdownsIsInsertedRightAfterAgenda() {
        assertEquals(
            listOf("agenda", "countdowns", "tonight", "chores", "grocery", "pantry", "goals", "familyNight"),
            TodayCards.applyFallbacks(listOf("agenda", "tonight", "chores", "grocery", "goals"), emptySet()),
        )
    }

    /** With no agenda card in the order, countdowns goes to the FRONT. */
    @Test
    fun countdownsFallsBackToTheFrontWithoutAgenda() {
        val out = TodayCards.applyFallbacks(listOf("tonight", "goals"), setOf("pantry", "familyNight"))
        assertEquals(listOf("countdowns", "tonight", "goals"), out)
    }

    /** Pantry goes after grocery — but with no grocery card, to the END, not the front. */
    @Test
    fun pantryFallsBackToTheEndWithoutGrocery() {
        val out = TodayCards.applyFallbacks(listOf("agenda", "tonight"), setOf("countdowns", "familyNight"))
        assertEquals(listOf("agenda", "tonight", "pantry"), out)
    }

    @Test
    fun familyNightIsAppended() {
        val out = TodayCards.applyFallbacks(listOf("agenda"), setOf("countdowns", "pantry"))
        assertEquals(listOf("agenda", "familyNight"), out)
    }

    /** A card the user deliberately HID must never be re-inserted by the fallback. */
    @Test
    fun aHiddenCardIsNotReInserted() {
        val hidden = setOf("countdowns", "pantry", "familyNight")
        val order = listOf("agenda", "tonight", "grocery")
        assertEquals(order, TodayCards.applyFallbacks(order, hidden))
    }

    /** A current server already sends all three — the guard must not duplicate them. */
    @Test
    fun aCompleteOrderIsLeftAlone() {
        val order = listOf("agenda", "countdowns", "tonight", "grocery", "pantry", "familyNight")
        assertEquals(order, TodayCards.applyFallbacks(order, emptySet()))
    }

    // ---- reordering (the Customize sheet) --------------------------------------

    @Test
    fun movingACardSwapsItWithItsNeighbour() {
        val order = listOf("agenda", "tonight", "chores")
        assertEquals(listOf("tonight", "agenda", "chores"), TodayCards.moved(order, 1, -1))
        assertEquals(listOf("agenda", "chores", "tonight"), TodayCards.moved(order, 1, 1))
    }

    /** Moving off either end is a no-op, not a crash and not a wrap-around. */
    @Test
    fun movingOffTheEndsDoesNothing() {
        val order = listOf("agenda", "tonight", "chores")
        assertEquals(order, TodayCards.moved(order, 0, -1))
        assertEquals(order, TodayCards.moved(order, 2, 1))
        assertEquals(order, TodayCards.moved(order, 9, 1))
    }

    // ---- labels -----------------------------------------------------------------

    /** Every key the layout can carry needs a label for the Customize sheet. */
    @Test
    fun everyCardKeyHasALabel() {
        val keys = TodayCards.defaultOrder + listOf("countdowns", "lists", "pantry", "familyNight")
        for (key in keys) assertTrue(TodayCards.labels.containsKey(key), "no label for $key")
    }

    /** An unknown key from a newer server falls back to the key itself, never a crash. */
    @Test
    fun anUnknownKeyLabelsAsItself() {
        assertEquals("somethingNew", TodayCards.label("somethingNew"))
    }
}

/** The review banner's count → headline (`reviewRecapTitle` on iOS). */
class ReviewRecapTitleTest {

    @Test
    fun bothQueuesReadAsTwoCounts() {
        assertEquals("3 to review · 2 to link", TodayCards.reviewRecapTitle(3, 2))
    }

    @Test
    fun recapOnlyPluralises() {
        assertEquals("1 event to log", TodayCards.reviewRecapTitle(1, 0))
        assertEquals("4 events to log", TodayCards.reviewRecapTitle(4, 0))
    }

    @Test
    fun suggestionsOnlyPluralise() {
        assertEquals("1 event might count", TodayCards.reviewRecapTitle(0, 1))
        assertEquals("5 events might count", TodayCards.reviewRecapTitle(0, 5))
    }
}
