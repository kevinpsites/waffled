package app.waffled.core.design

import androidx.compose.ui.graphics.Color
import kotlin.math.roundToInt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * `persons.color_hex` is real synced data, so it is one of the two documented places a
 * literal colour is correct (the other being fixed identity palettes). It arrives from
 * the server as user-entered text, so parsing must be forgiving and must never throw.
 */
class ColorHexTest {

    private fun rgb(c: Color) = Triple(
        (c.red * 255).roundToInt(),
        (c.green * 255).roundToInt(),
        (c.blue * 255).roundToInt(),
    )

    @Test
    fun parsesSixDigitHexWithHash() {
        assertEquals(Triple(0x2F, 0x7F, 0xED), rgb(colorFromHex("#2F7FED")!!))
    }

    @Test
    fun parsesWithoutHash() {
        assertEquals(Triple(0xEC, 0x60, 0x49), rgb(colorFromHex("EC6049")!!))
    }

    @Test
    fun isCaseInsensitive() {
        assertEquals(rgb(colorFromHex("#ec6049")!!), rgb(colorFromHex("#EC6049")!!))
    }

    @Test
    fun toleratesSurroundingWhitespace() {
        assertEquals(Triple(0x25, 0xA3, 0x68), rgb(colorFromHex("  #25A368 ")!!))
    }

    @Test
    fun expandsThreeDigitShorthand() {
        // #F0A -> #FF00AA
        assertEquals(Triple(0xFF, 0x00, 0xAA), rgb(colorFromHex("#F0A")!!))
    }

    @Test
    fun parsesEightDigitHexAsRrggbbaa() {
        val c = colorFromHex("#2F7FED80")!!
        assertEquals(Triple(0x2F, 0x7F, 0xED), rgb(c))
        assertEquals(0x80, (c.alpha * 255).roundToInt())
    }

    @Test
    fun returnsNullForJunkRatherThanThrowing() {
        assertNull(colorFromHex(null))
        assertNull(colorFromHex(""))
        assertNull(colorFromHex("   "))
        assertNull(colorFromHex("not-a-colour"))
        assertNull(colorFromHex("#12345"))
        assertNull(colorFromHex("#GGGGGG"))
    }
}
