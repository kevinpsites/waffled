package app.waffled.feature.lists

/**
 * "Share list" — turns a list's UNCHECKED items into phone-friendly plain text, grouped
 * in the board's walking order:
 *
 *     PRODUCE
 *     - Asparagus (2 bunch)
 *
 *     DAIRY & CHILLED
 *     - Milk (1 gal)
 *
 * A direct port of the web formatter (`apps/web/src/kiosk/components/share-list.ts`) via
 * the iOS one, kept behaviour-identical so the same list shares the same text from any
 * platform — the tests mirror that suite case for case. Change one, change all three.
 *
 * On a phone the text goes to the system share sheet rather than a QR code: the web QR
 * exists to get the list *onto* a phone, and here the app already is one.
 */
object ShareList {

    /** The canonical aisle walking order — mirrors the web's `AISLE_ORDER`. */
    val aisleOrder = listOf("Produce", "Dairy & Chilled", "Meat & Seafood", "Pantry", "Bakery", "Frozen", "Other")

    private const val OTHER = "Other"

    /** The slice of a list row the formatter needs. */
    data class Item(
        val name: String,
        val quantity: String? = null,
        val checked: Boolean = false,
        /** Aisle (grocery) or section (custom list); "" when the row isn't grouped. */
        val group: String = "",
        /** Where to buy it, when the household has assigned a store. */
        val store: String? = null,
        /** Who it's for, when it's assigned to someone. */
        val assignee: String? = null,
    )

    /**
     * Adapt a real list row.
     *
     * `section` first, because that is what the board on screen groups by
     * ([ListGrouping.sections]) and the shared text must not contradict it. The two
     * disagree in practice: "Move to section" updates `section` optimistically and leaves
     * `aisle` stale, and a row categorised "Other" comes back with `section: "Other"`
     * beside an `aisle` the server guessed from the name. Grocery rows still group by
     * aisle — the board load backfills `section` from `aisle` when the row has none of its
     * own — so `aisle` is the fallback for rows that arrive before that backfill.
     */
    fun item(from: ListItemDTO): Item = Item(
        name = from.name,
        quantity = from.quantity,
        checked = from.checked,
        group = from.section ?: from.aisle ?: "",
        store = from.store,
        assignee = from.assignee?.name,
    )

    /**
     * Store and assignee are the two things a shopper needs that the name doesn't carry.
     * Both are usually unset, so a row only gains a trailing note when the household
     * actually filled one in.
     *
     * Bracketed, NOT dash-separated: item names already use an em dash for allergen
     * warnings ("Shredded mozzarella — contains milk"), so a dash here would read as more
     * of the name.
     */
    private fun itemText(i: Item): String {
        val notes = listOfNotNull(i.store, i.assignee).map { it.trim() }.filter { it.isNotEmpty() }
        val qty = i.quantity?.takeIf { it.isNotEmpty() }?.let { " ($it)" } ?: ""
        val note = if (notes.isEmpty()) "" else " [${notes.joinToString(" · ")}]"
        return "${i.name}$qty$note"
    }

    /**
     * Unchecked items → grouped plain text ("" when nothing is left to get).
     *
     * Known aisles lead in walking order, then any unrecognised groups, then the OTHER
     * catch-all last (it's a fallback, so it should never push a real section down the
     * page).
     *
     * A list with NO grouping at all comes out flat with no headers: a lone "OTHER" over
     * every line is noise, and custom lists frequently have no sections.
     */
    fun format(items: List<Item>): String =
        render(items, line = { "- ${itemText(it)}" }, header = { it.uppercase() })

    /**
     * The same list as a Markdown checklist ("" when nothing is left to get) — for pasting
     * into a notes app that renders `- [ ]` as a real, tickable box.
     *
     * Only UNCHECKED items are emitted, exactly as in the plain-text share: the export is
     * the shopping list, and an item already in the cart is not part of it. Every box
     * ships unticked and `- [x]` never appears.
     *
     * Headers keep their natural casing rather than the plain-text SHOUT — `##` already
     * renders as a heading, so uppercasing only adds noise.
     */
    fun formatMarkdown(items: List<Item>): String =
        render(items, line = { "- [ ] ${itemText(it)}" }, header = { "## $it" })

    /**
     * Shared skeleton for both output formats: same items, same grouping, same order —
     * only the per-line and per-header syntax differ. One code path is what keeps the
     * plain-text and Markdown shares from drifting apart.
     */
    private fun render(
        items: List<Item>,
        line: (Item) -> String,
        header: (String) -> String,
    ): String {
        val byGroup = LinkedHashMap<String, MutableList<Item>>()
        val order = mutableListOf<String>() // first-seen order, for unknown groups
        var anyGrouped = false
        for (i in items) {
            if (i.checked) continue
            if (i.group.isNotEmpty()) anyGrouped = true
            val group = i.group.ifEmpty { OTHER }
            if (byGroup[group] == null) order.add(group)
            byGroup.getOrPut(group) { mutableListOf() }.add(i)
        }

        val known = aisleOrder.filter { it != OTHER && byGroup.containsKey(it) }
        val unknown = order.filter { it != OTHER && it !in aisleOrder }
        val ordered = known + unknown + (if (byGroup.containsKey(OTHER)) listOf(OTHER) else emptyList())

        val all = ordered.flatMap { byGroup[it].orEmpty() }
        if (all.isEmpty()) return ""
        // Nothing carried a section — headers would add nothing to read.
        if (!anyGrouped) return all.joinToString("\n", transform = line)

        return ordered.joinToString("\n\n") { g ->
            header(g) + "\n" + byGroup[g].orEmpty().joinToString("\n", transform = line)
        }
    }

    /** Convenience: format straight from list rows. */
    fun formatRows(rows: List<ListItemDTO>): String = format(rows.map(::item))

    /** Convenience: Markdown straight from list rows. */
    fun formatMarkdownRows(rows: List<ListItemDTO>): String = formatMarkdown(rows.map(::item))
}
