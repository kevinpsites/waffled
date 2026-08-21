package app.waffled.core.sync

import android.content.Context
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledModule
import com.powersync.DatabaseDriverFactory
import com.powersync.PowerSyncDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId

/** What the sync engine is doing, mirrored from the iOS status enum. */
enum class SyncState { Idle, Connecting, Connected, Offline }

/**
 * Owns the PowerSync database and the derived state every screen reads.
 *
 * Two rules carried over from the iOS SyncManager, both of which exist for a reason:
 *
 * 1. **Derived state is precomputed, never computed per read.** [eventsByDay] and the
 *    visible-event list are rebuilt when data changes, not while rendering — date math
 *    inside a sort or filter, recomputed per keystroke, janks hard.
 * 2. **Per-viewer filtering happens on the client.** PowerSync streams the whole
 *    household; the server does not filter per person.
 *
 * Only five tables sync. Everything else is REST — see [app.waffled.core.network.RefreshBus]
 * for how those screens learn to re-fetch.
 */
class SyncManager(
    private val context: Context,
    private val connector: WaffledConnector,
    private val scope: CoroutineScope,
) {
    private var database: PowerSyncDatabase? = null

    private val _state = MutableStateFlow(SyncState.Idle)
    val state: StateFlow<SyncState> = _state.asStateFlow()

    private val _members = MutableStateFlow<List<Person>>(emptyList())
    val members: StateFlow<List<Person>> = _members.asStateFlow()

    private val _events = MutableStateFlow<List<SyncedEvent>>(emptyList())

    /** The signed-in person, or null on an unclaimed shared device. */
    private val _currentPersonId = MutableStateFlow<String?>(null)
    val currentPersonId: StateFlow<String?> = _currentPersonId.asStateFlow()

    private val _zone = MutableStateFlow<ZoneId>(ZoneId.systemDefault())

    private val _modules = MutableStateFlow(ModuleGate(loaded = false))
    val modules: StateFlow<ModuleGate> = _modules.asStateFlow()

    /**
     * Events this viewer may see, already filtered. Recomputed only when the underlying
     * data, the viewer, or the timezone changes.
     */
    val visibleEvents: StateFlow<List<SyncedEvent>> = MutableStateFlow<List<SyncedEvent>>(emptyList())
        .also { out ->
            scope.launch {
                _events.collect { all ->
                    out.value = EventVisibility.visible(all, _currentPersonId.value)
                }
            }
        }.asStateFlow()

    /** Visible events bucketed by local day — precomputed, O(1) to read. */
    val eventsByDay: StateFlow<Map<LocalDate, List<SyncedEvent>>> =
        MutableStateFlow<Map<LocalDate, List<SyncedEvent>>>(emptyMap())
            .also { out ->
                scope.launch {
                    visibleEvents.collect { visible ->
                        out.value = EventBucketing.byDay(visible, _zone.value)
                    }
                }
            }.asStateFlow()

    /**
     * Open the local database and start syncing.
     *
     * Opening can transiently fail with SQLITE_BUSY on a cold start, so it is retried —
     * the same guard the iOS client needs.
     */
    suspend fun start() {
        if (database != null) return
        _state.value = SyncState.Connecting

        val db = openWithRetry() ?: run {
            _state.value = SyncState.Offline
            return
        }
        database = db

        runCatching { db.connect(connector) }
            .onFailure { _state.value = SyncState.Offline }

        scope.launch {
            db.currentStatus.asFlow().map { it.connected }.collect { connected ->
                _state.value = if (connected) SyncState.Connected else SyncState.Offline
            }
        }
    }

    private suspend fun openWithRetry(attempts: Int = 3): PowerSyncDatabase? {
        repeat(attempts) { attempt ->
            val db = runCatching {
                PowerSyncDatabase(
                    factory = DatabaseDriverFactory(context),
                    schema = WaffledSyncSchema.schema,
                    dbFilename = DB_FILE,
                )
            }.getOrNull()
            if (db != null) return db
            kotlinx.coroutines.delay(200L * (attempt + 1))
        }
        return null
    }

    fun setCurrentPerson(personId: String?) {
        _currentPersonId.value = personId
    }

    fun setHouseholdZone(zone: ZoneId) {
        _zone.value = zone
    }

    fun setModules(gate: ModuleGate) {
        _modules.value = gate
    }

    /** Convenience gates, so screens don't reach into [modules] themselves. */
    fun isOn(module: WaffledModule): Boolean = _modules.value.isOn(module)

    suspend fun stop() {
        runCatching { database?.disconnect() }
        _state.value = SyncState.Idle
    }

    private companion object {
        const val DB_FILE = "waffled.db"
    }
}
