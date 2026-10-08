package app.waffled.feature.pantry

import org.junit.Test
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pantry amounts are free text that the server ALSO parses numerically (for the scan
 * count-up and the cook decrement).
 *
 * Two rules fall out of that and both are tested here: anything numeric must leave the
 * device dot-decimal, because a comma-decimal keyboard types "0,5" which reads as NaN on
 * the far side and quietly becomes 1; and anything that is genuinely not a number ("a
 * pinch") must pass through exactly as typed.
 */
class PantryAmountTest {

    private val german = Locale.GERMANY

    // ---- formatting ---------------------------------------------------------------

    @Test
    fun `a whole number formats without a trailing decimal`() {
        assertEquals("2", PantryAmount.format(2.0))
        assertEquals("0", PantryAmount.format(0.0))
    }

    @Test
    fun `a fraction keeps two decimal places at most`() {
        assertEquals("1.5", PantryAmount.format(1.5))
        assertEquals("0.25", PantryAmount.format(0.25))
        assertEquals("0.33", PantryAmount.format(1.0 / 3.0))
    }

    @Test
    fun `formatting is always dot-decimal, whatever the device locale`() {
        assertEquals("1.5", PantryAmount.format(1.5))
    }

    // ---- parsing -------------------------------------------------------------------

    @Test
    fun `plain numbers parse`() {
        assertEquals(2.0, PantryAmount.parse("2"))
        assertEquals(2.5, PantryAmount.parse("2.5"))
        assertEquals(0.5, PantryAmount.parse(".5"))
        assertEquals(1.0, PantryAmount.parse("  1 "))
    }

    @Test
    fun `a comma-decimal keyboard still parses in a comma-decimal locale`() {
        assertEquals(0.5, PantryAmount.parse("0,5", german))
    }

    @Test
    fun `free text is not a number`() {
        assertNull(PantryAmount.parse("a pinch"))
        assertNull(PantryAmount.parse(""))
    }

    @Test
    fun `value treats anything unparseable as zero`() {
        assertEquals(0.0, PantryAmount.value("a pinch"))
        assertEquals(2.5, PantryAmount.value("2.5"))
    }

    // ---- canonicalising for the wire ---------------------------------------------------

    @Test
    fun `a comma decimal goes out dot-decimal — the server would read 0,5 as NaN`() {
        assertEquals("0.5", PantryAmount.canonical("0,5", german))
    }

    @Test
    fun `real free text survives untouched`() {
        assertEquals("a pinch", PantryAmount.canonical("a pinch"))
        assertEquals("", PantryAmount.canonical("   "))
    }

    @Test
    fun `a tidy number stays tidy`() {
        assertEquals("2", PantryAmount.canonical("2.0"))
        assertEquals("1.5", PantryAmount.canonical(" 1.5 "))
    }

    // ---- stepping ------------------------------------------------------------------------

    @Test
    fun `stepping keeps a fraction on its own grid`() {
        assertEquals("1.5", PantryAmount.stepped("0.5", 1.0))
        assertEquals("0.5", PantryAmount.stepped("1.5", -1.0))
    }

    @Test
    fun `stepping never goes negative`() {
        assertEquals("0", PantryAmount.stepped("0", -1.0))
        assertEquals("0", PantryAmount.stepped("a pinch", -1.0))
    }

    @Test
    fun `stepping free text upward starts from zero`() {
        assertEquals("1", PantryAmount.stepped("a pinch", 1.0))
    }
}
