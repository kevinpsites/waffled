package app.waffled.core.sync

import android.content.Context
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledModule
import com.powersync.DatabaseDriverFactory
import com.powersync.PowerSyncDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
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
 * 1. **Derived state is precomputed, never computed per read.** See [DerivedEventState] —
 *    date math inside a sort or filter, recomputed per keystroke, janks hard.
 * 2. **Per-viewer filtering happens on the client.** PowerSync streams the whole
 *    household; the server does not filter per person.
 *
 * Only five tables sync. Everything else is REST — see
 * [app.waffled.core.network.RefreshBus] for how those screens learn to re-fetch.
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

    /** The signed-in person, or null on an unclaimed shared device. */
    private val _currentPersonId = MutableStateFlow<String?>(null)
    val currentPersonId: StateFlow<String?> = _currentPersonId.asStateFlow()

    private val _modules = MutableStateFlow(ModuleGate(loaded = false))
    val modules: StateFlow<ModuleGate> = _modules.asStateFlow()

    /**
     * Events + viewer + zone, combined so that ALL THREE retrigger the derivation. A
     * kiosk person claim changes nothing about the event list, so filtering keyed only on
     * events would silently leave someone else's personal event on screen.
     */
    private val derived = DerivedEventState()

    /** Events the current viewer may see, already filtered. */
    val visibleEvents: StateFlow<List<SyncedEvent>> = derived.visible

    /** Visible events bucketed by local day — precomputed, O(1) to read. */
    val eventsByDay: StateFlow<Map<LocalDate, List<SyncedEvent>>> = derived.byDay

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

        watchEvents(db)
        watchHousehold(db)
    }

    /**
     * Stream the calendar into [derived].
     *
     * Two queries, combined: non-recurring `events`, plus the materialised
     * `event_occurrences` of the recurring masters. The masters themselves are excluded
     * (`rrule IS NULL`) because their occurrences render instead — including both would
     * double-render every repeat. There is no client-side RRULE expansion; a server
     * worker keeps the occurrences in step.
     */
    private fun watchEvents(db: PowerSyncDatabase) {
        scope.launch {
            combine(
                db.watch(EventRowMapper.EVENTS_SQL, mapper = EventRowMapper::map),
                db.watch(EventRowMapper.OCCURRENCES_SQL, mapper = EventRowMapper::map),
            ) { events, occurrences -> events + occurrences }
                .catch { /* one malformed row must not tear the whole stream down */ }
                .collect { derived.setEvents(it) }
        }
    }

    /**
     * The household's timezone drives day bucketing, and it arrives AFTER events may
     * already have — which is why [DerivedEventState] treats it as its own input.
     */
    private fun watchHousehold(db: PowerSyncDatabase) {
        scope.launch {
            // The mapper must return a non-null row type, so absent reads as "".
            db.watch<String>("SELECT timezone FROM households LIMIT 1") { cursor ->
                cursor.columnNames["timezone"]?.let { cursor.getString(it) }.orEmpty()
            }
                .catch { }
                .collect { rows ->
                    val tz = rows.firstOrNull().orEmpty()
                    if (tz.isEmpty()) return@collect
                    runCatching { ZoneId.of(tz) }.getOrNull()?.let { derived.setZone(it) }
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
            delay(200L * (attempt + 1))
        }
        return null
    }

    /** Called on sign-in, and whenever a shared device is claimed by a person. */
    fun setCurrentPerson(personId: String?) {
        _currentPersonId.value = personId
        derived.setViewer(personId)
    }

    /** The household's timezone, which arrives from the server after events may have. */
    fun setHouseholdZone(zone: ZoneId) {
        derived.setZone(zone)
    }

    fun setModules(gate: ModuleGate) {
        _modules.value = gate
    }

    /** Convenience gate, so screens don't reach into [modules] themselves. */
    fun isOn(module: WaffledModule): Boolean = _modules.value.isOn(module)

    suspend fun stop() {
        runCatching { database?.disconnect() }
        _state.value = SyncState.Idle
    }

    private companion object {
        const val DB_FILE = "waffled.db"
    }
}
