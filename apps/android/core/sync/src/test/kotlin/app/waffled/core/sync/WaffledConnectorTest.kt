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
 * might succeed later (offline, 5xx, an expired token, rate limiting, a 4xx the api
 * itself did not send) stays queued. Same rule as iOS and web.
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
        val backend = Backend { if (it == "bad") WaffledApiException(404, "Goal not found", errorCode = "NotFound") else null }
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

    /** A proxy or stale route answering 404 with a page is not the api's verdict. */
    @Test
    fun a4xxTheApiDidNotSendKeepsTheTransactionQueued() = runTest {
        val connector = WaffledConnector(Backend { WaffledApiException(404, "Not found", errorCode = null) })
        val queue = Queue("a")

        assertFailsWith<WaffledApiException> { connector.drain(queue::next) }

        assertTrue(queue.all.none { it.completed })
        assertNull(connector.lastRejection.value)
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
    fun aForbiddenWriteIsDroppedRatherThanWedgingTheQueue() = runTest {
        // A permission denial, or NoHousehold (the household is gone and the session ends):
        // neither can succeed on retry, and a queue stuck behind it would refuse every
        // later sign-in on the device.
        val connector = WaffledConnector(Backend { WaffledApiException(403, "NoHousehold", errorCode = "NoHousehold") })
        val queue = Queue("e1")

        connector.drain(queue::next)

        assertTrue(queue.all.all { it.completed })
        assertEquals(403, connector.lastRejection.value?.status)
    }

    @Test
    fun authAndThrottlingStatusesAreRetriedNotDropped() = runTest {
        for (status in listOf(401, 408, 429)) {
            val connector = WaffledConnector(Backend { WaffledApiException(status, "later", errorCode = "Later") })
            val queue = Queue("e1")
            assertFailsWith<WaffledApiException> { connector.drain(queue::next) }
            assertTrue(queue.all.none { it.completed }, "status $status must stay queued")
        }
    }
}
