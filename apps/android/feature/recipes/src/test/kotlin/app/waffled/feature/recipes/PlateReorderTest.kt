package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Moving a dish between roles in the meal builder — the Kotlin port of
 * `apps/ios/Tests/PlateReorderTests.swift`.
 *
 * The builder renders its roles as ONE flat run — header, that role's dishes, then its
 * ＋ — so a dish landing under a different header is what re-files it. The trap this
 * file exists to lock down: the ＋ rows are NOT draggable but they still occupy an index.
 * Leave them out of the array the move is resolved against and every index below one is
 * off by one, so a drag lands the wrong dish in the wrong role — silently, because there
 * is nothing to see except a dish that went somewhere odd.
 */
class PlateReorderTest {

    /**
     * main: [m1] · side: [s1, s2] · dessert: [] — laid out flat, that's:
     *  0 header(main) · 1 m1 · 2 add(main)
     *  3 header(side) · 4 s1 · 5 s2 · 6 add(side)
     *  7 header(dessert) · 8 empty(dessert) · 9 add(dessert)
     */
    private val groups = PlateRoles.groups(
        listOf(
            plateDish("m1", "m1", role = "main"),
            plateDish("s1", "s1", role = "side", sortOrder = 1),
            plateDish("s2", "s2", role = "side", sortOrder = 2),
        ),
    )

    private fun move(from: Int, to: Int) = PlateReorder.move(groups, setOf(from), to)

    @Test
    fun theFlatRunKeepsEveryRoleAndAnEmptyOneGetsADropSlot() {
        val rows = PlateReorder.rows(groups)
        assertEquals(10, rows.size)
        assertEquals(PlateReorder.Row.Header("main"), rows[0])
        assertEquals(PlateReorder.Row.Item("m1", "main"), rows[1])
        assertEquals(PlateReorder.Row.Item("add:main", "main"), rows[2])
        assertEquals(PlateReorder.Row.Header("side"), rows[3])
        assertEquals(PlateReorder.Row.Header("dessert"), rows[7])
        // The empty role's placeholder. Without it the role is a run of non-movable rows
        // (header + ＋), which offers nowhere to drop into — an empty Dessert silently
        // refused every drag.
        assertEquals(PlateReorder.Row.Item("empty:dessert", "dessert"), rows[8])
        assertEquals(PlateReorder.Row.Item("add:dessert", "dessert"), rows[9])
        // A role that HAS dishes gets no placeholder — its own rows are the slots.
        assertFalse(rows.contains(PlateReorder.Row.Item("empty:side", "side")))
    }

    /**
     * A brand-new plate has nothing to drag, so inviting a drag in all three roles would
     * be three rows asking for something impossible.
     */
    @Test
    fun aPlateWithNoDishesAtAllShowsNoDropSlots() {
        val empty = PlateRoles.groups(emptyList())
        assertFalse(PlateReorder.showsEmptySlots(empty))
        val rows = PlateReorder.rows(empty)
        // header + ＋ per role, and nothing else
        assertEquals(6, rows.size)
        assertFalse(rows.any { it is PlateReorder.Row.Item && it.id.startsWith("empty:") })
    }

    /** One dish anywhere is enough — it's the thing you'd be dragging. */
    @Test
    fun oneDishOnThePlateBringsTheOtherRolesSlotsBack() {
        val one = PlateRoles.groups(listOf(plateDish("m1", "m1", role = "main")))
        assertTrue(PlateReorder.showsEmptySlots(one))
        val rows = PlateReorder.rows(one)
        assertTrue(rows.contains(PlateReorder.Row.Item("empty:side", "side")))
        assertTrue(rows.contains(PlateReorder.Row.Item("empty:dessert", "dessert")))
        // the role that HAS the dish still gets no slot
        assertFalse(rows.contains(PlateReorder.Row.Item("empty:main", "main")))
    }

    /** Dragging the placeholder itself must write nothing. */
    @Test
    fun anEmptyRolesDropSlotNeverRefilesAnything() {
        assertNull(move(from = 8, to = 1))
    }

    @Test
    fun draggingTheMainDownUnderSidesRefilesItAsASide() {
        val r = assertNotNull(move(from = 1, to = 5))
        assertEquals("m1", r.id)
        assertEquals("side", r.role.key)
    }

    @Test
    fun draggingASideUpUnderMainRefilesItAsTheMain() {
        val r = assertNotNull(move(from = 4, to = 2))
        assertEquals("s1", r.id)
        assertEquals("main", r.role.key)
    }

    /** The empty role is the interesting one — its header is the only thing marking it. */
    @Test
    fun aDishCanBeDraggedIntoARoleThatHasNoDishesYet() {
        val r = assertNotNull(move(from = 5, to = 9))
        assertEquals("s2", r.id)
        assertEquals("dessert", r.role.key)
    }

    /**
     * The position matters as much as the role: `sort_order` is plate-wide and each role
     * renders by sorting on it, so a dish that keeps its old number lands wherever that
     * number falls. Dropped at the TOP of Sides, it must come out first.
     */
    @Test
    fun aDishDroppedAtTheTopOfARoleLandsFirstInIt() {
        val m = assertNotNull(move(from = 1, to = 4))
        assertEquals("m1", m.id)
        assertEquals("side", m.role.key)
        // ahead of s1 — not merely "somewhere in Sides"
        assertEquals(listOf("m1", "s1", "s2"), m.order)
    }

    @Test
    fun aDishDroppedAtTheBottomOfARoleLandsLastInIt() {
        val m = assertNotNull(move(from = 1, to = 6))
        assertEquals("side", m.role.key)
        assertEquals(listOf("s1", "s2", "m1"), m.order)
    }

    /** Reordering *within* a role is a real write rather than a no-op gesture. */
    @Test
    fun swappingTwoDishesInsideOneRoleRewritesTheOrder() {
        val m = assertNotNull(move(from = 5, to = 4))
        assertEquals("s2", m.id)
        assertEquals("side", m.role.key)
        assertEquals(listOf("m1", "s2", "s1"), m.order)
    }

    /** Writing the same role back would be a pointless round-trip on every nudge. */
    @Test
    fun droppingADishBackWhereItStartedWritesNothing() {
        assertNull(move(from = 5, to = 6))
    }

    /** The ＋ rows are not draggable, but the rule must not depend on the view for that. */
    @Test
    fun anAddRowNeverRefilesAnything() {
        assertNull(move(from = 2, to = 6))
    }

    /** A drop above the very first header has no role to adopt. */
    @Test
    fun droppingAboveTheFirstHeaderIsIgnored() {
        assertNull(move(from = 4, to = 0))
    }

    /** An index that isn't in the run at all resolves to nothing rather than crashing. */
    @Test
    fun anOutOfRangeSourceIsIgnored() {
        assertNull(move(from = 99, to = 1))
        assertNull(PlateReorder.move(groups, emptySet(), 1))
    }
}
