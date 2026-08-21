package app.waffled.feature.lists

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * "Share list" — the plain-text handoff. The Kotlin port of
 * `apps/ios/Tests/ShareListTests.swift`, which itself mirrors the web formatter's suite
 * (`apps/web/src/kiosk/components/share-list.ts`) 1:1, so the three platforms can't drift
 * into producing different text for the same list. Change one, change all three.
 */
class ShareListTest {

    private fun item(
        name: String,
        quantity: String?,
        group: String,
        checked: Boolean = false,
        store: String? = null,
        assignee: String? = null,
    ) = ShareList.Item(name, quantity, checked, group, store, assignee)

    @Test
    fun `groups unchecked items by aisle in board order`() {
        val text = ShareList.format(
            listOf(
                item("Milk", "1 gal", "Dairy & Chilled"),
                item("Asparagus", "2 bunch", "Produce"),
                item("Tomatoes", "2", "Produce"),
            ),
        )
        assertEquals(
            listOf(
                "PRODUCE", "- Asparagus (2 bunch)", "- Tomatoes (2)", "",
                "DAIRY & CHILLED", "- Milk (1 gal)",
            ).joinToString("\n"),
            text,
        )
    }

    @Test
    fun `omits the parens when an item has no quantity`() {
        assertEquals("BAKERY\n- Bread", ShareList.format(listOf(item("Bread", null, "Bakery"))))
    }

    @Test
    fun `excludes checked items entirely`() {
        val text = ShareList.format(
            listOf(
                item("Asparagus", "2 bunch", "Produce"),
                item("Butter", null, "Dairy & Chilled", checked = true),
            ),
        )
        assertEquals("PRODUCE\n- Asparagus (2 bunch)", text)
    }

    @Test
    fun `files group-less items under Other`() {
        val text = ShareList.format(
            listOf(item("Cookies", null, ""), item("Asparagus", "2 bunch", "Produce")),
        )
        assertEquals(
            listOf("PRODUCE", "- Asparagus (2 bunch)", "", "OTHER", "- Cookies").joinToString("\n"),
            text,
        )
    }

    @Test
    fun `appends unknown aisles after the known board order`() {
        val text = ShareList.format(
            listOf(item("Charcoal", null, "Seasonal"), item("Asparagus", null, "Produce")),
        )
        assertEquals(
            listOf("PRODUCE", "- Asparagus", "", "SEASONAL", "- Charcoal").joinToString("\n"),
            text,
        )
    }

    @Test
    fun `returns an empty string when everything is checked`() {
        assertTrue(ShareList.format(listOf(item("Butter", null, "Dairy & Chilled", checked = true))).isEmpty())
    }

    /**
     * Custom lists (hardware run, packing list) often have no sections at all. Filing the
     * whole thing under a lone OTHER header is noise, not structure.
     */
    @Test
    fun `omits headers entirely when nothing is grouped`() {
        val text = ShareList.format(
            listOf(
                item("Wood screws", "1 box", ""),
                item("Sandpaper", null, ""),
                item("Wood glue", null, ""),
            ),
        )
        assertEquals(listOf("- Wood screws (1 box)", "- Sandpaper", "- Wood glue").joinToString("\n"), text)
    }

    @Test
    fun `keeps the header when the single group is a real section`() {
        assertEquals("HARDWARE\n- Wood screws", ShareList.format(listOf(item("Wood screws", null, "Hardware"))))
    }

    @Test
    fun `still uses Other when some items are grouped and some are not`() {
        val text = ShareList.format(listOf(item("Wood screws", null, "Hardware"), item("Snacks", null, "")))
        assertEquals(listOf("HARDWARE", "- Wood screws", "", "OTHER", "- Snacks").joinToString("\n"), text)
    }

    // The two things a shopper actually needs that the plain name doesn't carry:
    // which shop it's from, and whose item it is.

    @Test
    fun `notes the store when an item has one`() {
        val text = ShareList.format(listOf(item("Whole milk", "1 gal", "Dairy & Chilled", store = "Costco")))
        assertEquals("DAIRY & CHILLED\n- Whole milk (1 gal) [Costco]", text)
    }

    @Test
    fun `notes who an item is for when it is assigned`() {
        val text = ShareList.format(listOf(item("Swimsuits", "×4", "Clothes", assignee = "Kelly")))
        assertEquals("CLOTHES\n- Swimsuits (×4) [Kelly]", text)
    }

    @Test
    fun `lists store then person when an item has both`() {
        val text = ShareList.format(
            listOf(item("Whole milk", "1 gal", "Dairy & Chilled", store = "Costco", assignee = "Kelly")),
        )
        assertEquals("DAIRY & CHILLED\n- Whole milk (1 gal) [Costco · Kelly]", text)
    }

    /**
     * Brackets, not a dash: item names already carry em-dashed allergen warnings, so a
     * dash separator would read as more of the name.
     */
    @Test
    fun `stays unambiguous next to an allergen note already in the name`() {
        val text = ShareList.format(
            listOf(item("Shredded mozzarella — contains milk", null, "Dairy & Chilled", store = "Costco")),
        )
        assertEquals("DAIRY & CHILLED\n- Shredded mozzarella — contains milk [Costco]", text)
    }

    @Test
    fun `adds nothing when neither is set`() {
        assertEquals("PRODUCE\n- Bananas (1 bunch)", ShareList.format(listOf(item("Bananas", "1 bunch", "Produce"))))
    }

    @Test
    fun `ignores blank strings rather than emitting empty brackets`() {
        val text = ShareList.format(listOf(item("Bananas", null, "Produce", store = "  ", assignee = "")))
        assertEquals("PRODUCE\n- Bananas", text)
    }

    // ---- mapping a real list row ------------------------------------------------

    /**
     * Grocery rows carry `aisle`; custom-list rows carry `section`. One adapter so both
     * kinds of list share the formatter (and the ⋯ → Share action).
     */
    @Test
    fun `maps a grocery row by its aisle`() {
        val dto = row(
            """{"id":"1","name":"Milk","quantity":"1 gal","checked":false,"store":"Costco",
                "assignee":{"personId":"p1","name":"Kelly"},"aisle":"Dairy & Chilled"}""",
        )
        val mapped = ShareList.item(dto)
        assertEquals("Dairy & Chilled", mapped.group)
        assertEquals("Costco", mapped.store)
        assertEquals("Kelly", mapped.assignee)
    }

    @Test
    fun `falls back to section for a custom list row`() {
        val dto = row("""{"id":"2","name":"Sunscreen","checked":false,"section":"Toiletries"}""")
        val mapped = ShareList.item(dto)
        assertEquals("Toiletries", mapped.group)
        assertNull(mapped.assignee)
    }

    /**
     * When a row carries BOTH, they can disagree — and the shared text has to match the
     * board the sharer is looking at, which groups by `section`. Two ways they diverge:
     * "Move to section" updates `section` optimistically and leaves `aisle` stale, and
     * category "Other" makes the server send `section: "Other"` alongside an `aisle` it
     * guessed from the item's name. Handing someone a list that files tomatoes under a
     * heading their screen doesn't show is exactly the drift this port exists to avoid.
     */
    @Test
    fun `prefers section over aisle when they disagree`() {
        val dto = row(
            """{"id":"3","name":"Grape tomatoes","checked":false,"section":"Other","aisle":"Produce"}""",
        )
        assertEquals("Other", ShareList.item(dto).group)
    }

    @Test
    fun `an ungrouped row maps to an empty group, not a literal Other`() {
        val dto = row("""{"id":"4","name":"Cookies","checked":false}""")
        assertEquals("", ShareList.item(dto).group)
    }
}

/**
 * The Markdown variant — the same list as a checklist a notes app renders with real tick
 * boxes. Mirrors `formatShareListMarkdown` case for case, exactly as the plain-text suite
 * above mirrors `formatShareList`.
 */
class ShareListMarkdownTest {

    private fun item(
        name: String,
        quantity: String?,
        group: String,
        checked: Boolean = false,
        store: String? = null,
        assignee: String? = null,
    ) = ShareList.Item(name, quantity, checked, group, store, assignee)

    @Test
    fun `renders unchecked items as open task boxes under headers`() {
        val md = ShareList.formatMarkdown(
            listOf(
                item("Milk", "1 gal", "Dairy & Chilled"),
                item("Asparagus", "2 bunch", "Produce"),
                item("Tomatoes", "2", "Produce"),
            ),
        )
        assertEquals(
            listOf(
                "## Produce", "- [ ] Asparagus (2 bunch)", "- [ ] Tomatoes (2)", "",
                "## Dairy & Chilled", "- [ ] Milk (1 gal)",
            ).joinToString("\n"),
            md,
        )
    }

    @Test
    fun `omits the parens when an item has no quantity`() {
        assertEquals("## Bakery\n- [ ] Bread", ShareList.formatMarkdown(listOf(item("Bread", null, "Bakery"))))
    }

    /**
     * Same rule as the plain-text share: the export IS the shopping list, and a checked
     * item is already in the cart. Every emitted box is therefore unticked.
     */
    @Test
    fun `excludes checked items rather than emitting ticked boxes`() {
        val md = ShareList.formatMarkdown(
            listOf(
                item("Asparagus", "2 bunch", "Produce"),
                item("Butter", null, "Dairy & Chilled", checked = true),
            ),
        )
        assertEquals("## Produce\n- [ ] Asparagus (2 bunch)", md)
        assertFalse(md.contains("[x]"))
    }

    @Test
    fun `files group-less items under Other`() {
        val md = ShareList.formatMarkdown(
            listOf(item("Cookies", null, ""), item("Asparagus", "2 bunch", "Produce")),
        )
        assertEquals(
            listOf("## Produce", "- [ ] Asparagus (2 bunch)", "", "## Other", "- [ ] Cookies").joinToString("\n"),
            md,
        )
    }

    @Test
    fun `appends unknown aisles after the known board order`() {
        val md = ShareList.formatMarkdown(
            listOf(item("Charcoal", null, "Seasonal"), item("Asparagus", null, "Produce")),
        )
        assertEquals(
            listOf("## Produce", "- [ ] Asparagus", "", "## Seasonal", "- [ ] Charcoal").joinToString("\n"),
            md,
        )
    }

    @Test
    fun `returns an empty string when everything is checked`() {
        assertTrue(
            ShareList.formatMarkdown(listOf(item("Butter", null, "Dairy & Chilled", checked = true))).isEmpty(),
        )
    }

    @Test
    fun `omits headers entirely when nothing is grouped`() {
        val md = ShareList.formatMarkdown(
            listOf(
                item("Wood screws", "1 box", ""),
                item("Sandpaper", null, ""),
                item("Wood glue", null, ""),
            ),
        )
        assertEquals(
            listOf("- [ ] Wood screws (1 box)", "- [ ] Sandpaper", "- [ ] Wood glue").joinToString("\n"),
            md,
        )
    }

    @Test
    fun `keeps the header when the single group is a real section`() {
        assertEquals(
            "## Hardware\n- [ ] Wood screws",
            ShareList.formatMarkdown(listOf(item("Wood screws", null, "Hardware"))),
        )
    }

    @Test
    fun `carries store and assignee notes through unchanged`() {
        val md = ShareList.formatMarkdown(
            listOf(item("Whole milk", "1 gal", "Dairy & Chilled", store = "Costco", assignee = "Kelly")),
        )
        assertEquals("## Dairy & Chilled\n- [ ] Whole milk (1 gal) [Costco · Kelly]", md)
    }
}
