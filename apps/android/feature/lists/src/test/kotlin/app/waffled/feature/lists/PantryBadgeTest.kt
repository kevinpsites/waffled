package app.waffled.feature.lists

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The grocery board's "you already have this" badge — the port of
 * `apps/ios/Tests/PantryBadgeTests.swift`. Two separate things are locked down here.
 *
 * 1. DECODING. `pantry` is sent by the BOARD endpoint only — the plain
 *    `GET /api/lists/:id` rows have no such key, and neither does any server predating
 *    the field. iOS has already been bitten once by a strict decode failing on a key one
 *    endpoint didn't send: the throw surfaces as a bogus "couldn't reach server", so the
 *    whole list looks offline because of an optional badge.
 *
 * 2. THE DISPLAY RULE. Matching is fuzzy ("chicken" ↔ "boneless chicken breast"), so what
 *    the badge says is not interchangeable: when the pantry item's name differs from the
 *    row's, that NAME is the half that can change your mind and it leads. When the names
 *    are the same, the name adds nothing and only the amount is worth the width.
 */
class PantryBadgeTest {

    // ---- decoding ---------------------------------------------------------------

    /** A grocery-board row, verbatim: it carries `pantry`. */
    private val boardRow = """
        {"id":"1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8","name":"Eggs","quantity":"12","checked":false,
         "section":"Dairy & Chilled","aisle":"Dairy & Chilled","store":null,"priority":3,
         "sourceRecipeIds":[],"weekStart":"2026-08-16",
         "pantry":{"name":"Free-range eggs","amount":"6","unit":""}}
    """.trimIndent()

    /** The same row as the PLAIN list endpoint sends it — no `pantry` key at all. */
    private val plainRow = """
        {"id":"1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8","name":"Eggs","quantity":"12","checked":false,
         "section":"Dairy & Chilled","store":null}
    """.trimIndent()

    @Test
    fun `decodes the board's pantry hit`() {
        val r = row(boardRow)
        assertEquals("Free-range eggs", r.pantry?.name)
        assertEquals("6", r.pantry?.amount)
        assertEquals("", r.pantry?.unit)
    }

    /**
     * The regression that matters: a row without the key decodes, and simply makes no
     * pantry claim. Null here means "we don't know" — the pantry module may be off —
     * never "you have none".
     */
    @Test
    fun `decodes a row with no pantry key at all`() {
        val r = row(plainRow)
        assertEquals("Eggs", r.name)
        assertNull(r.pantry)
    }

    /** An explicit null (pantry module off) is the same "we don't know". */
    @Test
    fun `decodes an explicit null pantry`() {
        assertNull(row("""{"id":"a","name":"Eggs","checked":false,"pantry":null}""").pantry)
    }

    // ---- the display rule -------------------------------------------------------

    private fun label(row: String, name: String, amount: String, unit: String) =
        PantryBadge.label(row, ListItemDTO.PantryHit(name, amount, unit))

    /**
     * Exact match (modulo case/whitespace): the row already says the name, so only the
     * amount earns the width.
     */
    @Test
    fun `shows only the amount on an exact name match`() {
        assertEquals("6", label("Eggs", "eggs", "6", ""))
        assertEquals("2 bags", label(" Rice ", "Rice", "2", "bags"))
    }

    /**
     * Fuzzy match: the matched name leads, because "Chicken" matched by "Boneless chicken
     * breast" is a difference that can change your mind and "3 pack" wouldn't tell you.
     */
    @Test
    fun `leads with the matched name when it differs`() {
        assertEquals("Frozen peas · 2 bags", label("Peas", "Frozen peas", "2", "bags"))
    }

    /**
     * A fuzzy match with nothing to say about quantity still names what it found —
     * falling back to the generic "in pantry" there would throw away the only informative
     * half.
     */
    @Test
    fun `names the match even with no amount`() {
        assertEquals("Frozen peas", label("Peas", "Frozen peas", "", ""))
    }

    /**
     * Exact name, no amount, no unit: there is genuinely nothing to add, so the badge
     * falls back to the bare claim.
     */
    @Test
    fun `falls back to a bare label when there is nothing to say`() {
        assertEquals("in pantry", label("Eggs", "Eggs", "", ""))
        assertEquals("in pantry", label("Eggs", "Eggs", "  ", " "))
    }

    /** A unit with no number is still a unit worth showing ("a bag" beats "in pantry"). */
    @Test
    fun `shows a unit with no number`() {
        assertEquals("bag", label("Rice", "Rice", "", "bag"))
    }

    /** The server can omit amount/unit entirely; a null must read the same as a blank. */
    @Test
    fun `tolerates absent amount and unit`() {
        assertEquals("in pantry", PantryBadge.label("Eggs", ListItemDTO.PantryHit("Eggs")))
        assertEquals("Frozen peas", PantryBadge.label("Peas", ListItemDTO.PantryHit("Frozen peas")))
    }
}
