package app.waffled.feature.lists

/**
 * Pure logic behind moving a list item between sections.
 *
 * On iOS the list renders as one flat run of rows — a header for each section, then that
 * section's items — so SwiftUI's native `.onMove` can drag an item *across* a header; the
 * item then adopts the section of the header it landed under.
 *
 * **Compose has no `.onMove`.** There is no androidx reorder-by-drag API for
 * `LazyColumn`, and the brief's reuse rule (plus the iOS history of a hand-rolled swipe
 * that had to be reworked) rules out inventing one. So the *gesture* is not ported; the
 * *rule* is, and it is what the row's "Move to section" menu writes — see
 * [ListDetailModel.moveToSection]. Keeping the flat-row resolution here means the day a
 * reorder API lands, the behaviour it needs already exists and is locked, case for case,
 * by the iOS suite.
 */
object ListReorder {

    /**
     * A flattened display row: a section header (its title, null for the untitled group),
     * or an item tagged with the section it currently sits in.
     */
    sealed interface Row {
        data class Header(val title: String?) : Row
        data class Item(val id: String, val section: String?) : Row
    }

    /** The resolved write: which item moves, and the section it adopts. */
    data class Move(val id: String, val section: String?)

    /**
     * The section an item should adopt after a move of [from] to index [to] over the flat
     * [rows]: the header nearest at or above where it landed.
     *
     * Returns null for a no-op — the item didn't change section, landed above the first
     * header, or the move can't be resolved — so the caller skips the write. Section
     * titles are compared exactly, with an empty string normalising to null.
     */
    fun targetSection(rows: List<Row>, from: Set<Int>, to: Int): Move? {
        val src = from.minOrNull() ?: return null
        if (src !in rows.indices) return null
        val moved = rows[src] as? Row.Item ?: return null

        // Replay the move on a copy, so this stays pure and testable rather than
        // depending on any list widget's own reorder helper.
        val ordered = from.sorted()
        val moving = ordered.map { rows[it] }
        val arr = rows.toMutableList()
        for (i in ordered.reversed()) arr.removeAt(i)
        val removedBefore = ordered.count { it < to }
        val insertAt = (to - removedBefore).coerceIn(0, arr.size)
        arr.addAll(insertAt, moving)

        val newIdx = arr.indexOfFirst { it is Row.Item && it.id == moved.id }
        if (newIdx < 0) return null

        // Walk up to the nearest header — that section owns the landing spot.
        var section: String? = null
        var foundHeader = false
        var k = newIdx - 1
        while (k >= 0) {
            val r = arr[k]
            if (r is Row.Header) {
                section = r.title
                foundHeader = true
                break
            }
            k--
        }
        if (!foundHeader) return null // dropped above the first header → ignore

        val normalizedOld = moved.section?.takeIf { it.isNotEmpty() }
        val normalizedNew = section?.takeIf { it.isNotEmpty() }
        if (normalizedNew == normalizedOld) return null
        return Move(moved.id, normalizedNew)
    }
}
