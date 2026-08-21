package app.waffled.feature.chores

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * Ordering rules for a day's chores — the Kotlin port of
 * `apps/ios/Tests/ChoreSortTests.swift`, case for case.
 *
 *   1. incomplete (`status == "pending"`) first — done/awaiting sink
 *   2. then due time ascending, with a set "HH:mm" before an unset (null) time
 *   3. then title A–Z (case-insensitive)
 */
class ChoreSortTest {

    private fun inst(
        title: String,
        status: String = "pending",
        dueTime: String? = null,
    ) = ChoresApi.ChoreInstance(
        id = "id-$title-$status-${dueTime ?: "nil"}",
        choreId = "c-$title",
        choreTitle = title,
        status = status,
        dueTime = dueTime,
    )

    private fun titles(xs: List<ChoresApi.ChoreInstance>) = xs.map { it.choreTitle }

    @Test
    fun `incomplete before completed and awaiting`() {
        val sorted = ChoreSort.sortChores(
            listOf(
                inst("Done thing", status = "done"),
                inst("Awaiting thing", status = "awaiting"),
                inst("Pending thing", status = "pending"),
            ),
        )
        assertEquals(listOf("Pending thing", "Awaiting thing", "Done thing"), titles(sorted))
    }

    @Test
    fun `due time ascending then untimed last`() {
        val sorted = ChoreSort.sortChores(
            listOf(
                inst("No time"),
                inst("Evening", dueTime = "18:00"),
                inst("Morning", dueTime = "07:30"),
            ),
        )
        assertEquals(listOf("Morning", "Evening", "No time"), titles(sorted))
    }

    @Test
    fun `title tiebreak is case-insensitive`() {
        val sorted = ChoreSort.sortChores(
            listOf(inst("banana"), inst("Apple"), inst("cherry")),
        )
        assertEquals(listOf("Apple", "banana", "cherry"), titles(sorted))
    }

    @Test
    fun `awaiting with an earlier time still sinks below pending`() {
        val sorted = ChoreSort.sortChores(
            listOf(
                inst("Early awaiting", status = "awaiting", dueTime = "06:00"),
                inst("Untimed pending"),
            ),
        )
        assertEquals(listOf("Untimed pending", "Early awaiting"), titles(sorted))
    }

    @Test
    fun `equal time and title are equivalent`() {
        val a = inst("Tidy up", dueTime = "08:00")
        val b = inst("Tidy up", dueTime = "08:00")
        assertFalse(ChoreSort.sortsBefore(a, b))
        assertFalse(ChoreSort.sortsBefore(b, a))
    }

    @Test
    fun `full ordering across all rules`() {
        val sorted = ChoreSort.sortChores(
            listOf(
                inst("Zebra done", status = "done"),
                inst("Alpha done", status = "done", dueTime = "06:00"),
                inst("Untimed pending"),
                inst("Nine pending", dueTime = "09:00"),
                inst("Eight pending", dueTime = "08:00"),
                inst("Also eight", dueTime = "08:00"),
            ),
        )
        assertEquals(
            listOf(
                "Also eight", "Eight pending", "Nine pending", "Untimed pending",
                "Alpha done", "Zebra done",
            ),
            titles(sorted),
        )
    }
}
