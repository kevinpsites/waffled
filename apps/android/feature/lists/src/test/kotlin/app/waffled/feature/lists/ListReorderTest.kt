package app.waffled.feature.lists

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The port of `apps/ios/Tests/ListReorderTests.swift`: after a move over the flattened
 * header+item rows, the moved item adopts the section of the header it landed under.
 *
 * These lock the pure position→section rule. On iOS the move comes from `.onMove`; here
 * there is no reorder gesture (Compose has no equivalent), and the rule is what the
 * "Move to section" control writes — see [ListReorder].
 */
class ListReorderTest {

    // CLOTHES: rain, cooler   |   GEAR: sun
    private val rows = listOf(
        ListReorder.Row.Header("Clothes"),
        ListReorder.Row.Item("rain", "Clothes"),
        ListReorder.Row.Item("cooler", "Clothes"),
        ListReorder.Row.Header("Gear"),
        ListReorder.Row.Item("sun", "Gear"),
    )

    @Test
    fun `dragging an item under another section header moves it`() {
        // "cooler" (idx 2) to the end (idx 5) → lands after GEAR's items.
        val out = ListReorder.targetSection(rows, setOf(2), 5)
        assertEquals("cooler", out?.id)
        assertEquals("Gear", out?.section)
    }

    @Test
    fun `dropping right after the target header joins that section`() {
        val out = ListReorder.targetSection(rows, setOf(2), 4)
        assertEquals("Gear", out?.section)
    }

    @Test
    fun `reordering within the same section is a no-op`() {
        // "rain" (idx 1) below "cooler" but still inside CLOTHES (idx 3).
        assertNull(ListReorder.targetSection(rows, setOf(1), 3))
    }

    @Test
    fun `dragging up into an earlier section`() {
        // "sun" (idx 4) up under the CLOTHES header (idx 1) → becomes Clothes.
        val out = ListReorder.targetSection(rows, setOf(4), 1)
        assertEquals("sun", out?.id)
        assertEquals("Clothes", out?.section)
    }

    @Test
    fun `dropping above the first header is ignored`() {
        // No section owns the space above the first header.
        assertNull(ListReorder.targetSection(rows, setOf(4), 0))
    }

    @Test
    fun `moving into the untitled group yields a null section`() {
        val mixed = listOf(
            ListReorder.Row.Header("Gear"),
            ListReorder.Row.Item("sun", "Gear"),
            ListReorder.Row.Header(null),
            ListReorder.Row.Item("misc", null),
        )
        val out = ListReorder.targetSection(mixed, setOf(1), 4)
        assertEquals("sun", out?.id)
        assertNull(out?.section)
    }

    @Test
    fun `a header row as the source is rejected`() {
        assertNull(ListReorder.targetSection(rows, setOf(0), 4))
    }

    /** An out-of-range source can't be resolved, so it must not throw — it's a no-op. */
    @Test
    fun `an out-of-range source is a no-op`() {
        assertNull(ListReorder.targetSection(rows, setOf(99), 1))
        assertNull(ListReorder.targetSection(rows, emptySet(), 1))
    }

    /** An empty section title normalises to null, matching what `setSection` persists. */
    @Test
    fun `an empty header title normalises to a null section`() {
        val mixed = listOf(
            ListReorder.Row.Header("Gear"),
            ListReorder.Row.Item("sun", "Gear"),
            ListReorder.Row.Header(""),
            ListReorder.Row.Item("misc", ""),
        )
        val out = ListReorder.targetSection(mixed, setOf(1), 4)
        assertEquals("sun", out?.id)
        assertNull(out?.section)
    }
}
