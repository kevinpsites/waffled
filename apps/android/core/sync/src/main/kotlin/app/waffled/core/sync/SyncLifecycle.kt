package app.waffled.core.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The start / stop / clear state machine behind [SyncManager] — the port of the iOS
 * `performStart` + `stopSync` pair. Generic over the database so the lifecycle is
 * JVM-testable without PowerSync, the same reason [DerivedEventState] was extracted.
 *
 * Rules carried over from iOS:
 *  - the database is opened ONCE and reused; a second open on the same file is the
 *    SQLITE_BUSY race [SyncManager] already retries around,
 *  - watchers are cancelled BEFORE disconnecting, or a live query races teardown,
 *  - a stop always leaves the session restartable, even when the clear failed.
 *
 * One [Mutex] serialises every transition, so a sign-out during a cold-start retry
 * cannot interleave with it.
 */
internal class SyncLifecycle<D : Any>(
    private val open: suspend () -> D?,
    private val connect: suspend (D) -> Unit,
    private val disconnect: suspend (D) -> Unit,
    /** Disconnect AND wipe the local mirror (PowerSync `disconnectAndClear`). */
    private val clear: suspend (D) -> Unit,
    /** Depth of the CRUD upload queue. */
    private val countPending: suspend (D) -> Int,
    private val launchWatchers: (D) -> List<Job>,
    private val onState: (SyncState) -> Unit,
    /** Drop derived state; the flag says whether the mirror was wiped too. */
    private val onReset: (clearedLocal: Boolean) -> Unit,
) {
    private val lock = Mutex()
    private var db: D? = null
    private var started = false
    private var watchers: List<Job> = emptyList()

    suspend fun start() = lock.withLock { startLocked() }

    /** Returns false only when a requested clear failed; the session is still restartable. */
    suspend fun stop(clearLocal: Boolean = false): Boolean = lock.withLock { stopLocked(clearLocal) }

    /**
     * Stop (clearing when asked), run [adopt] — the moment to swap the server or token —
     * then start again. Nothing is adopted when the clear failed: a new scope must never
     * inherit the previous one's rows. Sync restarts even when [adopt] throws or is
     * cancelled — under whatever credentials are then installed — and the failure rethrows.
     */
    suspend fun rescope(clearLocal: Boolean, adopt: suspend () -> Unit): Boolean = lock.withLock {
        if (!stopLocked(clearLocal)) return@withLock false
        try {
            adopt()
        } finally {
            withContext(NonCancellable) { startLocked() }
        }
        true
    }

    suspend fun pendingUploadCount(): Int {
        val current = db ?: return 0
        return try {
            countPending(current)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            0
        }
    }

    private suspend fun startLocked() {
        if (started) return
        onState(SyncState.Connecting)
        val current = db ?: open()?.also { db = it }
        if (current == null) {
            onState(SyncState.Offline)
            return
        }
        started = true
        watchers = launchWatchers(current)
        try {
            connect(current)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            onState(SyncState.Offline)
        }
    }

    private suspend fun stopLocked(clearLocal: Boolean): Boolean {
        watchers.forEach { it.cancel() }
        watchers = emptyList()
        val current = db
        val stopped = when {
            current == null -> true
            // The wipe deletes ps_crud too: never clear while an offline write is queued
            // (iOS gates every clearing caller on pending == 0). Read fresh, not the flow.
            clearLocal && pendingOrUnknown(current) -> {
                runCatchingNonCancel { disconnect(current) }
                false
            }
            clearLocal -> runCatchingNonCancel { clear(current) }
            else -> {
                runCatchingNonCancel { disconnect(current) }
                true
            }
        }
        started = false
        onReset(clearLocal && stopped)
        onState(if (stopped) SyncState.Idle else SyncState.Offline)
        return stopped
    }

    /** True when uploads are queued — or when the count can't be read, which is no proof of none. */
    private suspend fun pendingOrUnknown(current: D): Boolean = try {
        countPending(current) > 0
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        true
    }

    private suspend fun runCatchingNonCancel(block: suspend () -> Unit): Boolean = try {
        block()
        true
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }
}
