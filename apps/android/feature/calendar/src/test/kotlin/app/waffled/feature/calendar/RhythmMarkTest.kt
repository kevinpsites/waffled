package app.waffled.feature.calendar

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * The 🔁 marker on a calendar event that belongs to a rhythm — the label half of
 * `apps/ios/Tests/RhythmMarkTests.swift`. The schema and query halves live in `core:sync`.
 */
class RhythmMarkTest {

    @Test
    fun prefixesTheGlyphForAChipTitle() {
        assertEquals("🔁 Temple visit", RhythmMark.prefixed("Temple visit", isRhythm = true))
    }

    @Test
    fun leavesAnOrdinaryTitleAlone() {
        assertEquals("Dentist", RhythmMark.prefixed("Dentist", isRhythm = false))
    }

    @Test
    fun spellsTheMarkerOutForAccessibility() {
        // The bare emoji reads as "repeat", the recurrence meaning this specifically isn't.
        assertEquals("Temple visit, part of a rhythm", RhythmMark.accessibilityLabel("Temple visit", isRhythm = true))
        assertEquals("Dentist", RhythmMark.accessibilityLabel("Dentist", isRhythm = false))
    }

    @Test
    fun matchesTheWebsEventDetailLine() {
        assertEquals("This slot keeps a rhythm", RhythmMark.DETAIL_LINE)
    }

    @Test
    fun neverUsesFollowThroughLanguage() {
        // A rhythm is satisfied by the slot existing; any of these would make it a goal.
        for (word in listOf("done", "complete", "streak", "on track", "missed", "kept up")) {
            assertFalse(RhythmMark.DETAIL_LINE.lowercase().contains(word), word)
            assertFalse(RhythmMark.MEANING.lowercase().contains(word), word)
        }
    }
}
