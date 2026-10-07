package app.waffled.feature.settingshousehold

import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.SyncedEvent
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Per-device reminder preferences. Defaults match iOS: off, 15 min, 8 AM, my events. */
data class ReminderPrefs(
    val enabled: Boolean = false,
    val leadMinutes: Int = 15,
    val allDayHour: Int = 8,
    val myEventsOnly: Boolean = true,
)

data class PlannedReminder(
    /** Namespaced so a reconcile only ever touches its own alarms. */
    val id: String,
    val eventId: String,
    val fireAt: Instant,
    val title: String,
    val body: String,
)

/**
 * Which local event reminders should exist right now — the pure half of the iOS
 * `NotificationManager.apply()`. The platform half ([EventReminderScheduler]) diffs this
 * against what it scheduled last time.
 */
object EventReminderPlanner {
    const val ID_PREFIX = "waffled.evt."
    const val SNOOZE_PREFIX = "waffled.snz."
    const val SNOOZE_MINUTES = 10

    /** Well under Android's per-app pending-alarm limit (500), soonest-first. */
    const val DEFAULT_CAP = 120

    data class Plan(val keep: List<PlannedReminder>, val droppedToCap: Int)

    /** Other features (cook timers) own their own `waffled.` namespaces; never touch those. */
    fun isEventReminderIdentifier(id: String): Boolean =
        id.startsWith(ID_PREFIX) || id.startsWith(SNOOZE_PREFIX)

    fun plan(
        events: List<SyncedEvent>,
        prefs: ReminderPrefs,
        zone: ZoneId,
        myPersonId: String?,
        names: Map<String, String>,
        now: Instant,
        cap: Int = DEFAULT_CAP,
        locale: Locale = Locale.getDefault(),
    ): Plan {
        if (!prefs.enabled) return Plan(emptyList(), 0)
        val planned = events.mapNotNull { e ->
            // Android's events mirror has no participant list, so "mine" is the owner.
            if (prefs.myEventsOnly && myPersonId != null && e.personId != myPersonId) return@mapNotNull null
            val fire = fireAt(e, prefs, zone)?.takeIf { it.isAfter(now) } ?: return@mapNotNull null
            PlannedReminder(ID_PREFIX + e.id, e.id, fire, e.title, body(e, prefs, zone, names, locale))
        }.sortedBy { it.fireAt }
        val keep = planned.take(cap)
        return Plan(keep, planned.size - keep.size)
    }

    fun fireAt(e: SyncedEvent, prefs: ReminderPrefs, zone: ZoneId): Instant? {
        val start = WaffledDates.parseInstant(e.startsAt, zone) ?: return null
        if (e.allDay) {
            val day = WaffledDates.localDay(start, zone)
            return day.atTime(LocalTime.of(prefs.allDayHour, 0)).atZone(zone).toInstant()
        }
        return start.minusSeconds(prefs.leadMinutes * 60L)
    }

    fun body(
        e: SyncedEvent,
        prefs: ReminderPrefs,
        zone: ZoneId,
        names: Map<String, String>,
        locale: Locale = Locale.getDefault(),
    ): String {
        val bits = mutableListOf<String>()
        if (e.allDay) {
            bits += "All day"
        } else {
            WaffledDates.parseInstant(e.startsAt, zone)?.let { bits += WaffledDates.format(it, "h:mm a", zone, locale) }
        }
        e.location?.trim()?.takeIf { it.isNotEmpty() }?.let { bits += it }
        if (!prefs.myEventsOnly) e.personId?.let { names[it] }?.let { bits += it }
        return bits.joinToString(" · ")
    }

    fun hourLabel(hour: Int, locale: Locale = Locale.getDefault()): String =
        DateTimeFormatter.ofPattern("h a", locale).format(LocalTime.of(hour, 0))
}
