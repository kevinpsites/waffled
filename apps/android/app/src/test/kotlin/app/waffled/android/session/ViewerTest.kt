package app.waffled.android.session

import app.waffled.core.model.Person
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The synced `persons` row has no `is_admin` / `capabilities` (see `PersonRowMapper`), so
 * every `can()` gate reads false off it. The viewer handed to features is the synced row
 * (live name/avatar edits) carrying the REST session's grants.
 */
class ViewerTest {

    private val synced = Person(id = "p1", name = "Jerry (synced)", avatarEmoji = "🥣")
    private val rest = Person(
        id = "p1", name = "Jerry", isAdmin = false, capabilities = listOf("reward.manage"),
    )

    @Test
    fun syncedRowGainsTheRestGrants() {
        val v = Viewer.merge(synced, rest)!!
        assertEquals("Jerry (synced)", v.name)
        assertEquals("🥣", v.avatarEmoji)
        assertTrue(v.can("reward.manage"))
    }

    @Test
    fun restAloneWhenSyncHasNotDeliveredTheRoster() {
        assertEquals(rest, Viewer.merge(null, rest))
    }

    @Test
    fun syncedAloneBeforeTheRestReadReturns() {
        assertEquals(synced, Viewer.merge(synced, null))
    }

    @Test
    fun aDifferentSyncedPersonNeverInheritsSomeoneElsesGrants() {
        val other = synced.copy(id = "p2")
        assertEquals(rest, Viewer.merge(other, rest))
    }

    @Test
    fun nobody() {
        assertNull(Viewer.merge(null, null))
    }
}
