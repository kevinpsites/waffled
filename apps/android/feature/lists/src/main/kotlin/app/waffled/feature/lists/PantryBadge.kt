package app.waffled.feature.lists

/**
 * The grocery board's "you already have this" badge — the pantry speaking on a surface
 * that isn't the pantry. Mirrors the web's `PantryBadge` in `GroceryBoard.tsx`.
 *
 * The rule lives here rather than in the composable because it is the part that can be
 * quietly wrong: matching is fuzzy ("Peas" matches "Frozen peas"), so *what* the badge
 * says is not interchangeable. See [label].
 *
 * What the badge deliberately does NOT do: hide the row, check it off, or claim you have
 * enough. The server's match is presence-only and never compares quantities, so "you have
 * eggs" can be true while you have one egg and the recipe wants twelve. Filtering on that
 * would be a worse bug than the confusion this fixes — so the row stays on the list,
 * stays checkable, and this is a "check the shelf" nudge.
 */
object PantryBadge {

    /**
     * What the badge reads.
     *
     *  - Fuzzy match (the pantry item's name differs from the row's): the NAME leads. A
     *    row reading "Chicken" matched by "Boneless chicken breast" is a difference that
     *    can change your mind, and "3 pack" wouldn't tell you that.
     *  - Exact match: the row already says the name, so only the amount adds anything —
     *    and on a narrow phone row, width spent on a repeat of the name is width lost.
     *  - Nothing to say at all: the bare claim, "in pantry".
     */
    fun label(rowName: String, hit: ListItemDTO.PantryHit): String {
        val amount = listOfNotNull(hit.amount, hit.unit)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" ")
        val differs = hit.name.trim().lowercase() != rowName.trim().lowercase()
        // A fuzzy match with no amount still names what it found — falling back to the
        // generic "in pantry" there would throw away the only informative half.
        val detail = if (differs) {
            listOf(hit.name, amount).filter { it.isNotEmpty() }.joinToString(" · ")
        } else {
            amount
        }
        return detail.ifEmpty { "in pantry" }
    }

    /** The spoken form, for TalkBack — the badge's own text is a fragment. */
    fun accessibilityLabel(rowName: String, hit: ListItemDTO.PantryHit): String =
        "In your pantry: ${label(rowName, hit)}. Still on the list — we can’t tell whether it’s enough."
}
