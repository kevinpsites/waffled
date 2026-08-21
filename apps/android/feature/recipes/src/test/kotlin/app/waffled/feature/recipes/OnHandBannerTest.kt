package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The recipe screen's "N of M on hand" line — the Kotlin port of
 * `apps/ios/Tests/OnHandBannerTests.swift`.
 *
 * The bug this locks down: the count used to come from `ingredients.isStaple`, which never
 * touches the pantry. A staple is something you're assumed to keep around, not something
 * you currently have — so a household with a completely empty pantry was told it had 4 of
 * 9 ingredients. The counts must come from the server's real pantry matching, and when the
 * pantry module is off the banner must make NO on-hand claim rather than falling back to
 * the staple proxy or to a misleading "0 of 9".
 */
class OnHandBannerTest {

    private val ninePantryless = listOf(
        "penne", "basil", "garlic", "cream", "parmesan", "parmesan rind", "chilli",
        "olive oil", "salt",
    )

    @Test
    fun claimsTheServersRealCountWhenThePantryIsOn() {
        val c = OnHandBanner.copy(OnHandCount(4, 9), 2, listOf("basil", "cream"), ninePantryless)
        assertEquals("4 of 9", c.lead)
        assertEquals(" on hand — need basil, cream", c.tail)
        assertTrue(c.showsAddButton)
    }

    @Test
    fun celebratesWhenNothingIsLeftToBuy() {
        val c = OnHandBanner.copy(OnHandCount(9, 9), 0, emptyList(), emptyList())
        assertEquals("9 of 9", c.lead)
        assertEquals(" on hand — you’ve got everything", c.tail)
        assertFalse(c.showsAddButton)
    }

    /**
     * The pantry module is off. "N to buy" still works (it isn't pantry-derived), but there
     * must be no on-hand number anywhere in the line.
     */
    @Test
    fun makesNoOnHandClaimWithThePantryOff() {
        val c = OnHandBanner.copy(null, 2, listOf("basil", "cream"), ninePantryless)
        assertNull(c.lead)
        assertEquals("Need basil, cream", c.tail)
        assertFalse(c.tail.contains("on hand"))
        assertFalse(c.tail.contains("0 of"))
        assertTrue(c.showsAddButton)
    }

    @Test
    fun pantryOffWithNothingToBuySaysWhyWithoutClaimingOnHand() {
        val c = OnHandBanner.copy(null, 0, emptyList(), emptyList())
        assertNull(c.lead)
        assertEquals("Nothing to buy — it’s all pantry staples", c.tail)
        assertFalse(c.tail.contains("on hand"))
        assertFalse(c.showsAddButton)
    }

    @Test
    fun namesOnlyTheFirstThreeAndCountsTheRest() {
        val c = OnHandBanner.copy(OnHandCount(1, 6), 5, listOf("a", "b", "c", "d", "e"), emptyList())
        assertEquals(" on hand — need a, b, c +2 more", c.tail)
    }

    /**
     * A server too old to send counts. Fall back to the ingredient split for the shopping
     * list — but still make no on-hand claim, since we genuinely can't say.
     */
    @Test
    fun fallsBackWithoutClaimingOnHandOnAnOlderServer() {
        val c = OnHandBanner.copy(null, null, emptyList(), listOf("basil", "cream"))
        assertNull(c.lead)
        assertEquals("Need basil, cream", c.tail)
        assertTrue(c.showsAddButton)
    }

    /**
     * The specific regression: an empty pantry with everything flagged a staple must NOT
     * report those staples as on hand.
     */
    @Test
    fun anEmptyPantryDoesNotCountStaplesAsOnHand() {
        val c = OnHandBanner.copy(OnHandCount(0, 9), 9, ninePantryless, emptyList())
        assertEquals("0 of 9", c.lead)
        assertTrue(c.tail.startsWith(" on hand — need penne"))
    }
}
