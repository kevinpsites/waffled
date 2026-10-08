package app.waffled.feature.pantry

import org.junit.Test
import kotlin.test.assertEquals

/**
 * Section-name rules.
 *
 * The server matches an existing section case-insensitively, so creating "garage shelf"
 * when the household already has "Garage shelf" is a no-op that returns the list
 * unchanged. The item list, though, buckets by an **exact** string, so saving the typed
 * casing files the item under a section nothing recognises — it lands in the "Other"
 * catch-all with nothing to explain why.
 */
class PantrySectionsTest {

    private val locations = listOf("Freezer", "Fridge", "Garage shelf")

    @Test
    fun `a differently-cased name resolves to the household's own spelling`() {
        assertEquals("Garage shelf", PantrySections.canonical("garage shelf", locations))
        assertEquals("Fridge", PantrySections.canonical("FRIDGE", locations))
    }

    @Test
    fun `an exact match is returned as-is`() {
        assertEquals("Freezer", PantrySections.canonical("Freezer", locations))
    }

    @Test
    fun `a genuinely new section keeps the typed spelling`() {
        assertEquals("Under the stairs", PantrySections.canonical("Under the stairs", locations))
    }

    @Test
    fun `with no configured sections the typed name stands`() {
        assertEquals("Pantry", PantrySections.canonical("Pantry", emptyList()))
    }
}
