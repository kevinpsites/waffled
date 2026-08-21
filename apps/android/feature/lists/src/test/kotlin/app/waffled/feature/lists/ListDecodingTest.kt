package app.waffled.feature.lists

import app.waffled.core.network.WaffledJson
import kotlinx.serialization.Serializable
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The row stores a quantity for READING ("1½ lb") and the server sends a second one for
 * TYPING ("1 1/2 lb"), because ½ has no key. The edit field is seeded from the typable
 * one, so anything deciding "did this change?" has to compare against the same form —
 * against `quantity` it never matches, and merely focusing a row and tapping away saves.
 *
 * Port of `apps/ios/Tests/ListItemEditSeedTests.swift`.
 */
class ListItemEditSeedTest {

    @Test
    fun `seeds from the typable quantity`() {
        val i = row("""{"id":"1","name":"Flour","quantity":"1½ lb","quantityInput":"1 1/2 lb","checked":false}""")
        assertEquals("1 1/2 lb", i.editableQuantity)
    }

    @Test
    fun `submitting the seed unchanged is not an edit`() {
        // The exact tap-away path: seed the box, submit it untouched, expect "no change".
        val i = row("""{"id":"1","name":"Flour","quantity":"1½ lb","quantityInput":"1 1/2 lb","checked":false}""")
        val typed = i.editableQuantity
        assertEquals(typed, i.editableQuantity)
        // …and the old comparison is exactly what made this look like a change.
        assert(typed != (i.quantity ?: ""))
    }

    @Test
    fun `falls back for a server that does not send one`() {
        assertEquals("2 gal", row("""{"id":"1","name":"Milk","quantity":"2 gal","checked":false}""").editableQuantity)
        assertEquals("", row("""{"id":"1","name":"Bread","checked":false}""").editableQuantity)
    }
}

/**
 * `ListSummary` must decode BOTH server shapes for a list — the port of
 * `apps/ios/Tests/ListSummaryDecodingTests.swift`.
 *
 *  1. The index endpoints (`GET /api/lists`, `GET /api/lists/templates`) attach a live
 *     `itemCount` to each row.
 *  2. Every mutate endpoint (POST /api/lists, apply-template, save-as-/unmark-template,
 *     PATCH /api/lists/:id) returns bare `presentList(...)` JSON — **no `itemCount`**.
 *
 * A required `itemCount` made shape 2 throw, which silently turned "create a list → open
 * it" into a no-op, and likewise broke save-as-template / use-template / capture's
 * create-list return.
 */
class ListSummaryDecodingTest {

    @Serializable
    private data class CreateEnvelope(val list: ListSummary)

    /** Verbatim shape of a POST /api/lists reply body. */
    private val createResponse = """
        {"list":{"id":"3f6f0c1a-6f0e-4c2d-9d5a-b0a1c2d3e4f5","name":"Camping gear","emoji":"⛺",
         "listType":"custom","isAutoBuilt":false,"sortMode":null}}
    """.trimIndent()

    /** One row of the GET /api/lists index reply (has `itemCount`). */
    private val indexRow = """
        {"id":"3f6f0c1a-6f0e-4c2d-9d5a-b0a1c2d3e4f5","name":"Camping gear","emoji":null,
         "listType":"custom","isAutoBuilt":false,"sortMode":null,"itemCount":7}
    """.trimIndent()

    @Test
    fun `decodes a create response without itemCount`() {
        val created = WaffledJson.decodeFromString<CreateEnvelope>(createResponse).list
        assertEquals("3f6f0c1a-6f0e-4c2d-9d5a-b0a1c2d3e4f5", created.id)
        assertEquals("Camping gear", created.name)
        assertEquals("custom", created.listType)
        assertEquals(0, created.itemCount) // a brand-new list has no items yet
    }

    @Test
    fun `keeps itemCount from index rows`() {
        val r = WaffledJson.decodeFromString<ListSummary>(indexRow)
        assertEquals(7, r.itemCount)
        assertNull(r.emoji)
    }

    @Test
    fun `recognises the grocery and template list types case-insensitively`() {
        assertEquals(true, WaffledJson.decodeFromString<ListSummary>(
            """{"id":"g","name":"Groceries","listType":"Grocery"}""",
        ).isGrocery)
        assertEquals(true, WaffledJson.decodeFromString<ListSummary>(
            """{"id":"t","name":"Packing","listType":"TEMPLATE"}""",
        ).isTemplate)
    }
}

/**
 * The row's `source` — the field the client's only obligation is to carry, never to act
 * on. The wipe/promote rules are the server's (`lists.service.ts`); what matters here is
 * that the value survives a decode so nothing downstream mistakes an authored row for a
 * derived one.
 */
class ListItemSourceDecodingTest {

    @Test
    fun `carries the derived and authored sources through`() {
        assertEquals("auto", row("""{"id":"1","name":"Onions","checked":false,"source":"auto"}""").source)
        assertEquals("recipe", row("""{"id":"2","name":"Limes","checked":false,"source":"recipe"}""").source)
        assertEquals("manual", row("""{"id":"3","name":"Foil","checked":false,"source":"manual"}""").source)
    }

    /** A server predating the field, or a route that doesn't send it, must still decode. */
    @Test
    fun `a row with no source at all decodes`() {
        assertNull(row("""{"id":"4","name":"Foil","checked":false}""").source)
    }
}
