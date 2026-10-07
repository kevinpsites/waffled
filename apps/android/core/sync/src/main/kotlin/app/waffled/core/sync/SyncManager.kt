package app.waffled.core.sync

import android.content.Context
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledModule
import com.powersync.DatabaseDriverFactory
import com.powersync.PowerSyncDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
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

    private val _pendingUploads = MutableStateFlow(0)

    /**
     * Writes still queued for upload (`ps_crud`), refreshed on every sync-status tick.
     * Readable synchronously for gates like "switch household"; [pendingUploadCount]
     * re-reads it on demand.
     */
    val pendingUploads: StateFlow<Int> = _pendingUploads.asStateFlow()

    private val lifecycle = SyncLifecycle(
        open = { openWithRetry() },
        connect = { db -> db.connect(connector) },
        disconnect = { db -> db.disconnect() },
        clear = { db -> db.disconnectAndClear() },
        countPending = { db -> db.get("SELECT count(*) AS n FROM ps_crud") { it.getLong(0) ?: 0L }.toInt() },
        launchWatchers = { db ->
            listOf(watchStatus(db), watchEvents(db), watchHousehold(db), watchMembers(db))
        },
        onState = { _state.value = it },
        onReset = ::resetDerivedState,
    )

    /**
     * Open the local database and start syncing. A no-op while already started; after a
     * [stop] it reconnects (reusing the open database) — which is how a new server,
     * household or session is picked up.
     *
     * Opening can transiently fail with SQLITE_BUSY on a cold start, so it is retried —
     * the same guard the iOS client needs.
     */
    suspend fun start() = lifecycle.start()

    private fun watchStatus(db: PowerSyncDatabase): Job = scope.launch {
        db.currentStatus.asFlow().collect { status ->
            _state.value = if (status.connected) SyncState.Connected else SyncState.Offline
            _pendingUploads.value = lifecycle.pendingUploadCount()
        }
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
    private fun watchEvents(db: PowerSyncDatabase): Job =
        scope.launch {
            combine(
                db.watch(EventRowMapper.EVENTS_SQL, mapper = EventRowMapper::map),
                db.watch(EventRowMapper.OCCURRENCES_SQL, mapper = EventRowMapper::map),
            ) { events, occurrences -> events + occurrences }
                .catch { /* one malformed row must not tear the whole stream down */ }
                .collect { derived.setEvents(it) }
        }

    /**
     * The household's timezone drives day bucketing, and it arrives AFTER events may
     * already have — which is why [DerivedEventState] treats it as its own input.
     */
    private fun watchHousehold(db: PowerSyncDatabase): Job =
        scope.launch {
            // Read BOTH household settings the clients need. week_start was missing
            // here even though it is in the synced schema, which forced the meals
            // planner to take it as a screen parameter.
            db.watch<Pair<String, String>>(
                "SELECT timezone, week_start FROM households LIMIT 1",
            ) { cursor ->
                val cols = cursor.columnNames
                val tz = cols["timezone"]?.let { cursor.getString(it) }.orEmpty()
                val ws = cols["week_start"]?.let { cursor.getString(it) }.orEmpty()
                tz to ws
            }
                .catch { }
                .collect { rows ->
                    val (tz, weekStart) = rows.firstOrNull() ?: return@collect
                    if (tz.isNotEmpty()) {
                        runCatching { ZoneId.of(tz) }.getOrNull()?.let { setHouseholdZone(it) }
                    }
                    if (weekStart.isNotEmpty()) _householdWeekStart.value = weekStart
                }
        }

    /**
     * The household roster, straight from the synced `persons` table.
     *
     * `members` was previously declared and never populated, which forced features to
     * fetch the roster over REST even though it is one of the five synced tables.
     */
    private fun watchMembers(db: PowerSyncDatabase): Job =
        scope.launch {
            db.watch(PersonRowMapper.PERSONS_SQL, mapper = PersonRowMapper::map)
                .catch { }
                .collect { people -> _members.value = people }
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

    private val _householdWeekStart = MutableStateFlow<String?>(null)

    /**
     * The household's first day of week, straight from the synced `households` row.
     *
     * ⚠️ The **server owns this boundary** — a client-computed week start caused the
     * PlanMonth grocery-rebuild bug, where the rebuild covered only week 1 and silently
     * stranded rows. Never derive one locally.
     *
     * `null` means "not known yet", which callers must treat as *unknown*, not as a
     * default: guessing Sunday for a Monday household leaves a week of shopping unbuilt,
     * whereas handling unknown explicitly stays correct.
     */
    val householdWeekStart: StateFlow<String?> = _householdWeekStart.asStateFlow()

    private val _householdZone = MutableStateFlow(ZoneId.systemDefault())

    /**
     * The household's clock. Readable, not just settable — every screen that formats a
     * date needs it, and three features had to take it as a parameter because it was
     * write-only.
     */
    val householdZone: StateFlow<ZoneId> = _householdZone.asStateFlow()

    /** Set from the synced `households` row; may arrive after events already have. */
    fun setHouseholdZone(zone: ZoneId) {
        _householdZone.value = zone
        derived.setZone(zone)
    }

    fun setModules(gate: ModuleGate) {
        _modules.value = gate
    }

    /** Convenience gate, so screens don't reach into [modules] themselves. */
    fun isOn(module: WaffledModule): Boolean = _modules.value.isOn(module)

    /**
     * The person using this device, resolved from [members] and [currentPersonId].
     *
     * Provided here because otherwise every feature re-derives
     * `members.first { it.id == currentPersonId }` — three of them already had.
     * Null on an unclaimed shared device.
     */
    val currentPerson: StateFlow<Person?> =
        combine(_members, _currentPersonId) { people, id ->
            id?.let { people.firstOrNull { p -> p.id == it } }
        }.stateIn(scope, SharingStarted.Eagerly, null)

    /**
     * Whether the current viewer holds [capability]. Admins hold everything; nobody holds
     * anything on an unclaimed device. The SERVER enforces this independently — this only
     * decides what to show.
     */
    fun can(capability: String): Boolean = currentPerson.value?.can(capability) == true

    /** Replace the household roster (from the synced `persons` table or the API). */
    fun setMembers(people: List<Person>) {
        _members.value = people
    }

    /**
     * Stop syncing: cancel the live queries, disconnect, and drop the synced roster and
     * events so nothing from this session lingers on screen. [start] afterwards reconnects.
     *
     * `clearLocal` also wipes the local mirror (PowerSync `disconnectAndClear`) and the
     * household-scoped state — what a server or household change needs, since the local
     * SQLite is one shared file. Returns false only when that wipe failed; the caller must
     * then refuse the change rather than adopt a new scope over the old rows.
     */
    suspend fun stop(clearLocal: Boolean = false): Boolean = lifecycle.stop(clearLocal)

    /** [stop] with the local mirror wiped — sign-out to a different principal, server or household. */
    suspend fun stopAndClear(): Boolean = lifecycle.stop(clearLocal = true)

    /**
     * Re-scope atomically: stop (wiping when [clearLocal]), run [adopt] — install the new
     * server or tokens there — then start again. Returns false, with nothing adopted, when
     * the wipe failed. Port of iOS `updateConnection` / `reauthenticate`.
     */
    suspend fun rescope(clearLocal: Boolean, adopt: suspend () -> Unit = {}): Boolean =
        lifecycle.rescope(clearLocal, adopt)

    /** Re-read the CRUD queue depth now (also updates [pendingUploads]). 0 before the first start. */
    suspend fun pendingUploadCount(): Int =
        lifecycle.pendingUploadCount().also { _pendingUploads.value = it }

    private fun resetDerivedState(clearedLocal: Boolean) {
        _members.value = emptyList()
        derived.setEvents(emptyList())
        _pendingUploads.value = 0
        if (clearedLocal) {
            // Household-scoped: the next scope's rows and identity supply them afresh.
            _householdWeekStart.value = null
            _modules.value = ModuleGate(loaded = false)
            setCurrentPerson(null)
        }
    }

    private companion object {
        const val DB_FILE = "waffled.db"
    }
}
