package app.waffled.feature.settingshousehold

import app.waffled.core.sync.SyncManager
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

/** Where reminder preferences persist (per device, like iOS UserDefaults). */
interface ReminderPrefsStore {
    fun load(): ReminderPrefs
    fun save(prefs: ReminderPrefs)
}

/** The platform alarm seam: the ids it reports are every pending one it knows of. */
interface ReminderAlarms {
    fun scheduledIds(): Set<String>
    fun schedule(reminder: PlannedReminder)
    fun cancel(id: String)
}

/**
 * Local event reminders scheduled on-device from the synced events — no server, no push.
 * The Android twin of the iOS `NotificationManager`, minus its 64-pending rolling horizon
 * (Android has no such cap; [EventReminderPlanner.DEFAULT_CAP] only keeps us well under
 * the per-app alarm limit).
 *
 * Every preference change re-runs the plan against the last events it was given.
 */
class EventReminders(
    private val store: ReminderPrefsStore,
    private val alarms: ReminderAlarms,
    private val permitted: () -> Boolean,
    private val clock: () -> Instant = Instant::now,
) {
    private val _prefs = MutableStateFlow(store.load())
    val prefs: StateFlow<ReminderPrefs> = _prefs.asStateFlow()

    /** How many upcoming reminders the cap dropped last pass — never silent. */
    private val _droppedToCap = MutableStateFlow(0)
    val droppedToCap: StateFlow<Int> = _droppedToCap.asStateFlow()

    private var lastEvents: List<SyncedEvent> = emptyList()
    private var lastZone: ZoneId = ZoneId.systemDefault()
    private var lastMyPersonId: String? = null
    private var lastNames: Map<String, String> = emptyMap()

    fun setEnabled(on: Boolean) = update { it.copy(enabled = on) }
    fun setLeadMinutes(minutes: Int) = update { it.copy(leadMinutes = minutes) }
    fun setAllDayHour(hour: Int) = update { it.copy(allDayHour = hour) }
    fun setMyEventsOnly(mine: Boolean) = update { it.copy(myEventsOnly = mine) }

    /** Re-run after the OS permission changes (e.g. the user just granted it). */
    fun refresh() = apply()

    @Synchronized
    fun reconcile(events: List<SyncedEvent>, zone: ZoneId, myPersonId: String?, names: Map<String, String>) {
        lastEvents = events; lastZone = zone; lastMyPersonId = myPersonId; lastNames = names
        apply()
    }

    /** Keep reminders in step with sync for as long as [scope] lives. Call once from `app`. */
    fun bind(scope: CoroutineScope, sync: SyncManager) {
        scope.launch {
            combine(sync.visibleEvents, sync.householdZone, sync.currentPersonId, sync.members) { events, zone, me, members ->
                Snapshot(events, zone, me, members.associate { it.id to it.name })
            }.collect { s -> reconcile(s.events, s.zone, s.me, s.names) }
        }
    }

    /** Drop every event reminder (sign-out). Snoozes go too; other features' alarms stay. */
    @Synchronized
    fun clearEventReminders() {
        alarms.scheduledIds().filter(EventReminderPlanner::isEventReminderIdentifier).forEach(alarms::cancel)
    }

    /** Home for the platform factory, `EventReminders.create(context)`. */
    companion object {}

    private data class Snapshot(
        val events: List<SyncedEvent>,
        val zone: ZoneId,
        val me: String?,
        val names: Map<String, String>,
    )

    private fun update(change: (ReminderPrefs) -> ReminderPrefs) {
        val next = change(_prefs.value)
        _prefs.value = next
        store.save(next)
        apply()
    }

    @Synchronized
    private fun apply() {
        val p = _prefs.value
        if (!p.enabled || !permitted()) {
            clearEventReminders()
            _droppedToCap.value = 0
            return
        }
        val plan = EventReminderPlanner.plan(lastEvents, p, lastZone, lastMyPersonId, lastNames, clock())
        _droppedToCap.value = plan.droppedToCap
        val desired = plan.keep.map { it.id }.toSet()
        // Only the auto-scheduled namespace is reconciled; a snooze lives under its own prefix.
        alarms.scheduledIds()
            .filter { it.startsWith(EventReminderPlanner.ID_PREFIX) && it !in desired }
            .forEach(alarms::cancel)
        // Re-setting an id replaces it: idempotent, and it re-arms anything the OS dropped (a reboot).
        plan.keep.forEach(alarms::schedule)
    }
}
