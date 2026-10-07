package app.waffled.feature.planning

import app.waffled.feature.planning.api.PlanningStepHandoff
import org.junit.Test
import kotlin.test.assertEquals

/**
 * Port of `PlanningHandoffWordsTests.swift`: the answer button must hand the composer the
 * CORRECTED words, not the stored note.
 */
class PlanningHandoffWordsTest {

    private fun note(id: String, text: String) = PlanningStepHandoff(id = id, note = text, byline = null)

    @Test fun `an unedited note carries its stored words`() {
        assertEquals("book the campsite", PlanningHandoffWords.of(note("n1", "book the campsite"), emptyMap()))
    }

    @Test fun `an edited note carries the edit`() {
        assertEquals(
            "book the campsite",
            PlanningHandoffWords.of(note("n1", "book the capmsite"), mapOf("n1" to "book the campsite")),
        )
    }

    @Test fun `one note's edit does not leak onto another`() {
        assertEquals(
            "ask about the school trip",
            PlanningHandoffWords.of(note("n2", "ask about the school trip"), mapOf("n1" to "something else")),
        )
    }
}
