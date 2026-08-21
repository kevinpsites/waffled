package app.waffled.feature.pantry

import org.junit.Test
import kotlin.test.assertEquals

/**
 * The name → emoji fallback, used whenever an item has no product photo.
 *
 * The rule list is **order-dependent** and two of the orderings are load-bearing bug
 * fixes carried over from iOS, so they are locked here rather than left to chance.
 */
class PantryFoodTest {

    @Test
    fun `common foods map to their emoji`() {
        assertEquals("🥛", PantryFood.emoji("Whole milk"))
        assertEquals("🧀", PantryFood.emoji("Cheddar cheese"))
        assertEquals("🍅", PantryFood.emoji("Tinned tomatoes"))
        assertEquals("🍗", PantryFood.emoji("Chicken thighs"))
    }

    @Test
    fun `matching is case-insensitive`() {
        assertEquals("🥚", PantryFood.emoji("EGGS"))
    }

    @Test
    fun `shampoo is not bacon — bare 'ham' is deliberately not a needle`() {
        // The web `foodEmoji` has this bug; the iOS port fixed it and so does this one.
        assertEquals("🧴", PantryFood.emoji("Shampoo"))
        // No rule claims a cracker, so it falls through to the box — the point is only
        // that it is not silently filed as cured pork.
        assertEquals("📦", PantryFood.emoji("Graham crackers"))
        // Cured pork is still covered by the needles that are safe as substrings.
        assertEquals("🥓", PantryFood.emoji("Streaky bacon"))
    }

    @Test
    fun `paper goods are matched before bread, so kitchen roll is not a loaf`() {
        assertEquals("🧻", PantryFood.emoji("Kitchen roll"))
        assertEquals("🧻", PantryFood.emoji("Toilet paper"))
        // …and a real bread roll still lands on bread.
        assertEquals("🍞", PantryFood.emoji("Brioche rolls"))
    }

    @Test
    fun `non-food a pantry actually holds gets a sensible glyph, not a food can`() {
        assertEquals("🧼", PantryFood.emoji("Laundry detergent"))
        assertEquals("🪥", PantryFood.emoji("Toothpaste"))
        assertEquals("🐾", PantryFood.emoji("Dog food"))
        assertEquals("🔋", PantryFood.emoji("AA batteries"))
    }

    @Test
    fun `anything unrecognised falls back to a box`() {
        assertEquals("📦", PantryFood.emoji("Xyzzy"))
        assertEquals("📦", PantryFood.emoji(""))
    }
}
