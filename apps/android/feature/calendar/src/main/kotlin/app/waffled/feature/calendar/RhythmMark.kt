package app.waffled.feature.calendar

/**
 * The 🔁 marker on a calendar event that belongs to a rhythm (`events.rhythm_id`) — the
 * port of iOS `RhythmMark`, itself mirroring the web's `RhythmMark`.
 *
 * Deliberately NOT follow-through language: getting the slot onto the calendar IS the
 * outcome, and nothing asks whether it happened. That is the line between a rhythm and a goal.
 */
object RhythmMark {
    const val GLYPH: String = "🔁"

    /** What the glyph means, spelled out for accessibility. */
    const val MEANING: String = "part of a rhythm"

    /** The event detail's line, word-for-word the web's. */
    const val DETAIL_LINE: String = "This slot keeps a rhythm"

    fun prefixed(title: String, isRhythm: Boolean): String = if (isRhythm) "$GLYPH $title" else title

    fun accessibilityLabel(title: String, isRhythm: Boolean): String =
        if (isRhythm) "$title, $MEANING" else title
}
