package app.waffled.feature.lists

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * "By store" grouping — the port of `apps/ios/Tests/StoreGroupingTests.swift`.
 *
 * The store box is free text and only NEW writes are snapped to a canonical spelling, so
 * rows saved earlier can still hold a variant casing. The section header is uppercased
 * for display, so "costco" and "Costco" both read as "COSTCO" — two identically-labelled
 * sections unless the grouping folds case. The web already folds; these lock the same
 * rule here.
 */
class StoreGroupingTest {

    @Test
    fun `folds stores typed with different casing`() {
        val groups = StoreGrouping.sections(
            listOf(
                stored("i1", "Rotisserie chicken", "Costco"),
                stored("i2", "Batteries", "costco"),
                stored("i3", "Muffins", "COSTCO"),
            ),
        )
        assertEquals(1, groups.size)
        assertEquals(3, groups[0].items.size)
        // First-seen casing wins the label, matching the web.
        assertEquals("Costco", groups[0].title)
    }

    @Test
    fun `ignores surrounding whitespace`() {
        val groups = StoreGrouping.sections(
            listOf(
                stored("i1", "Wine", "Trader Joe's"),
                stored("i2", "Bread", "  trader joe's  "),
            ),
        )
        assertEquals(1, groups.size)
        assertEquals(2, groups[0].items.size)
    }

    @Test
    fun `unassigned items trail in their own group`() {
        val groups = StoreGrouping.sections(
            listOf(
                stored("i1", "Milk"),
                stored("i2", "Eggs", "Walmart"),
                stored("i3", "Whitespace only", "   "),
            ),
        )
        assertEquals(2, groups.size)
        assertEquals("Walmart", groups[0].title)
        assertEquals("No store", groups[1].title)
        assertEquals(listOf("Milk", "Whitespace only"), groups[1].items.map { it.name }.sorted())
        // The "No store" header is not a real category — a move into it must clear, not set it.
        assertNull(groups[1].sectionValue)
    }

    @Test
    fun `stores are listed alphabetically, ignoring case`() {
        val groups = StoreGrouping.sections(
            listOf(
                stored("i1", "a", "Walmart"),
                stored("i2", "b", "Costco"),
                stored("i3", "c", "aldi"),
            ),
        )
        assertEquals(listOf("aldi", "Costco", "Walmart"), groups.map { it.title })
    }
}
