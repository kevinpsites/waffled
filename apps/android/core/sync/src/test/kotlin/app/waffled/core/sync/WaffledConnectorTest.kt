package app.waffled.core.sync

import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.test.runTest
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The upload drain. A transaction the server will never accept (a 400/404 on a deleted
 * goal, say) must not wedge `ps_crud` forever — every later write, and every server or
 * household change gated on an empty queue, would be stuck behind it. Everything that
 * might succeed later (offline, 5xx, an expired token, rate limiting) stays queued.
 *
 * iOS and web rethrow every non-2xx, so they share the wedge; Android deviates here.
 */
class WaffledConnectorTest {

    private class FakeTx(val id: String) : CrudBatch {
        var completed = false
        override val ops = listOf(CrudOpDto("PUT", "events", id, null))
        override suspend fun complete() { completed = true }
    }

    private class Queue(vararg ids: String) {
        val all = ids.map { FakeTx(it) }
        suspend fun next(): CrudBatch? = all.firstOrNull { !it.completed }
    }

    private class Backend(val fail: (String) -> Throwable?) : SyncBackend {
        val uploaded = mutableListOf<String>()
        override suspend fun fetchPowerSyncToken(): PowerSyncTokenResponse? = null
        override suspend fun uploadCrud(ops: List<CrudOpDto>) {
            val id = ops.single().id
            fail(id)?.let { throw it }
            uploaded += id
        }
    }

    @Test
    fun aPermanentRejectionIsDroppedAndTheQueueKeepsDraining() = runTest {
        val backend = Backend { if (it == "bad") WaffledApiException(404, "Goal not found") else null }
        val connector = WaffledConnector(backend)
        val queue = Queue("bad", "good")

        connector.drain(queue::next)

        assertTrue(queue.all.all { it.completed })
        assertEquals(listOf("good"), backend.uploaded)
        val rejection = connector.lastRejection.value
        assertEquals(404, rejection?.status)
        assertEquals("Goal not found", rejection?.message)
        assertEquals("bad", rejection?.ops?.single()?.id)
    }

    @Test
    fun aServerErrorKeepsTheTransactionQueued() = runTest {
        val connector = WaffledConnector(Backend { WaffledApiException(500, "boom") })
        val queue = Queue("e1")

        assertFailsWith<WaffledApiException> { connector.drain(queue::next) }
        assertTrue(queue.all.none { it.completed })
        assertNull(connector.lastRejection.value)
    }

    @Test
    fun aNetworkErrorKeepsTheTransactionQueued() = runTest {
        val connector = WaffledConnector(Backend { IOException("offline") })
        val queue = Queue("e1")

        assertFailsWith<IOException> { connector.drain(queue::next) }
        assertTrue(queue.all.none { it.completed })
    }

    @Test
    fun authAndThrottlingStatusesAreRetriedNotDropped() = runTest {
        for (status in listOf(401, 403, 408, 429)) {
            val connector = WaffledConnector(Backend { WaffledApiException(status, "later") })
            val queue = Queue("e1")
            assertFailsWith<WaffledApiException> { connector.drain(queue::next) }
            assertTrue(queue.all.none { it.completed }, "status $status must stay queued")
        }
    }
}
