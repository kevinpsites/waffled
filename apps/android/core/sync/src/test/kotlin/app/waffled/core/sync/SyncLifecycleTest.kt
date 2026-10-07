package app.waffled.core.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Port of the iOS SyncManager teardown contract: a stopped session must start again, a
 * clear must wipe the mirror and the derived state, and the CRUD queue depth is readable.
 * Driven through [SyncLifecycle] so no PowerSync database is needed.
 */
class SyncLifecycleTest {

    private class FakeDb {
        var connects = 0
        var disconnects = 0
        var clears = 0
        var pending = 0
        var failClear = false
    }

    private class Rig(scope: CoroutineScope) {
        val db = FakeDb()
        var opens = 0
        val states = mutableListOf<SyncState>()
        val resets = mutableListOf<Boolean>()
        val watchers = mutableListOf<Job>()

        val lifecycle = SyncLifecycle(
            open = { opens++; db },
            connect = { it.connects++ },
            disconnect = { it.disconnects++ },
            clear = { if (it.failClear) error("locked") else it.clears++ },
            countPending = { it.pending },
            launchWatchers = { _ ->
                listOf(scope.launch { awaitCancellation() }).also { watchers += it }
            },
            onState = { states += it },
            onReset = { cleared -> resets += cleared },
        )
    }

    private fun TestScope.rig() = Rig(backgroundScope)

    @Test
    fun startingAfterAStopReconnects() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        assertTrue(rig.lifecycle.stop())
        rig.lifecycle.start()

        assertEquals(2, rig.db.connects)
        assertEquals(1, rig.db.disconnects)
        // The same database is reused — a second open on one file is the SQLITE_BUSY trap.
        assertEquals(1, rig.opens)
    }

    @Test
    fun startingTwiceWithoutAStopIsANoOp() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        rig.lifecycle.start()
        assertEquals(1, rig.db.connects)
        assertEquals(1, rig.watchers.size)
    }

    @Test
    fun stopCancelsTheWatchersBeforeARestartLaunchesNewOnes() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        val first = rig.watchers.single()
        rig.lifecycle.stop()
        runCurrent()
        assertTrue(first.isCancelled)

        rig.lifecycle.start()
        assertEquals(1, rig.watchers.count { it.isActive })
    }

    @Test
    fun stopAndClearWipesTheMirrorAndResetsDerivedState() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        assertTrue(rig.lifecycle.stop(clearLocal = true))

        assertEquals(1, rig.db.clears)
        assertEquals(0, rig.db.disconnects)
        assertEquals(listOf(true), rig.resets)
        assertEquals(SyncState.Idle, rig.states.last())
    }

    @Test
    fun aPlainStopResetsWithoutClearing() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        rig.lifecycle.stop()
        assertEquals(0, rig.db.clears)
        assertEquals(listOf(false), rig.resets)
    }

    @Test
    fun aFailedClearReportsFalseAndCanStillRestart() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        rig.db.failClear = true

        assertFalse(rig.lifecycle.stop(clearLocal = true))
        assertEquals(SyncState.Offline, rig.states.last())

        rig.lifecycle.start()
        assertEquals(2, rig.db.connects)
    }

    @Test
    fun stoppingBeforeAnyStartSucceeds() = runTest {
        val rig = rig()
        assertTrue(rig.lifecycle.stop(clearLocal = true))
        assertEquals(0, rig.opens)
    }

    @Test
    fun rescopeStopsAdoptsThenStartsAgain() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        val order = mutableListOf<String>()

        val ok = rig.lifecycle.rescope(clearLocal = true) {
            order += "adopt:${rig.db.clears}:${rig.db.connects}"
        }

        assertTrue(ok)
        assertEquals(listOf("adopt:1:1"), order)
        assertEquals(2, rig.db.connects)
    }

    @Test
    fun aRescopeWhoseClearFailsDoesNotAdopt() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        rig.db.failClear = true
        var adopted = false

        assertFalse(rig.lifecycle.rescope(clearLocal = true) { adopted = true })
        assertFalse(adopted)
    }

    @Test
    fun aClearNeverWipesQueuedUploads() = runTest {
        val rig = rig()
        rig.lifecycle.start()
        rig.db.pending = 2

        assertFalse(rig.lifecycle.stop(clearLocal = true))
        assertEquals(0, rig.db.clears)
        assertFalse(rig.lifecycle.rescope(clearLocal = true) {})

        // A plain stop has nothing to lose and still goes through.
        rig.lifecycle.start()
        assertTrue(rig.lifecycle.stop())
    }

    @Test
    fun pendingUploadsReadTheCrudQueue() = runTest {
        val rig = rig()
        assertEquals(0, rig.lifecycle.pendingUploadCount())
        rig.lifecycle.start()
        rig.db.pending = 3
        assertEquals(3, rig.lifecycle.pendingUploadCount())
    }

    @Test
    fun aRescopeWhoseAdoptThrowsStillRestartsSync() = runTest {
        val rig = rig()
        rig.lifecycle.start()

        assertFailsWith<IllegalStateException> {
            rig.lifecycle.rescope(clearLocal = false) { error("keystore write failed") }
        }

        // The old session's credentials are still installed; leaving sync stopped would
        // strand the device offline until a relaunch.
        assertEquals(2, rig.db.connects)
    }

    @Test
    fun aRescopeCancelledDuringAdoptStillRestartsSync() = runTest {
        val rig = rig()
        rig.lifecycle.start()

        assertFailsWith<CancellationException> {
            rig.lifecycle.rescope(clearLocal = false) { throw CancellationException("left") }
        }

        assertEquals(2, rig.db.connects)
    }
}
