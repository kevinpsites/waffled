package app.waffled.feature.settingshousehold

import app.waffled.core.sync.SyncedEvent
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The reconcile half of the iOS `NotificationManager`: preferences persist, every change
 * re-runs against the last events, and only the event namespace is ever cancelled.
 */
class EventRemindersTest {

    private class MemoryStore(var saved: ReminderPrefs = ReminderPrefs()) : ReminderPrefsStore {
        override fun load() = saved
        override fun save(prefs: ReminderPrefs) { saved = prefs }
    }

    private class FakeAlarms : ReminderAlarms {
        val scheduled = linkedMapOf<String, PlannedReminder>()
        val other = mutableSetOf<String>()
        override fun scheduledIds(): Set<String> = scheduled.keys + other
        override fun schedule(reminder: PlannedReminder) { scheduled[reminder.id] = reminder }
        override fun cancel(id: String) { scheduled.remove(id); other.remove(id) }
    }

    private val now = Instant.parse("2026-09-14T12:00:00Z")
    private val zone = ZoneId.of("UTC")

    private fun event(id: String, at: String, personId: String? = null) =
        SyncedEvent(id = id, householdId = "h", title = id, startsAt = at, personId = personId)

    private fun reminders(
        store: MemoryStore = MemoryStore(ReminderPrefs(enabled = true, myEventsOnly = false)),
        alarms: FakeAlarms = FakeAlarms(),
        permitted: Boolean = true,
    ) = EventReminders(store, alarms, permitted = { permitted }, clock = { now })

    @Test
    fun reconcileSchedulesUpcomingAndCancelsStale() {
        val alarms = FakeAlarms()
        val r = reminders(alarms = alarms)
        r.reconcile(listOf(event("a", "2026-09-14T15:00:00Z"), event("b", "2026-09-14T16:00:00Z")), zone, null, emptyMap())
        assertEquals(setOf("waffled.evt.a", "waffled.evt.b"), alarms.scheduled.keys)

        r.reconcile(listOf(event("b", "2026-09-14T16:00:00Z")), zone, null, emptyMap())
        assertEquals(setOf("waffled.evt.b"), alarms.scheduled.keys)
    }

    @Test
    fun aSnoozeAndOtherFeaturesSurviveReconcile() {
        val alarms = FakeAlarms().apply { other += setOf("waffled.snz.a", "waffled.cook.timer-1") }
        reminders(alarms = alarms).reconcile(emptyList(), zone, null, emptyMap())
        assertEquals(setOf("waffled.snz.a", "waffled.cook.timer-1"), alarms.other)
    }

    @Test
    fun turningRemindersOffClearsOnlyEventReminders() {
        val alarms = FakeAlarms().apply { other += setOf("waffled.snz.a", "waffled.cook.timer-1") }
        val store = MemoryStore(ReminderPrefs(enabled = true, myEventsOnly = false))
        val r = reminders(store, alarms)
        r.reconcile(listOf(event("a", "2026-09-14T15:00:00Z")), zone, null, emptyMap())

        r.setEnabled(false)

        assertTrue(alarms.scheduled.isEmpty())
        assertEquals(setOf("waffled.cook.timer-1"), alarms.other)
        assertFalse(store.saved.enabled)
    }

    @Test
    fun aPreferenceChangeReplansAgainstTheLastEvents() {
        val alarms = FakeAlarms()
        val store = MemoryStore(ReminderPrefs(enabled = true, myEventsOnly = false))
        val r = reminders(store, alarms)
        r.reconcile(listOf(event("a", "2026-09-14T15:00:00Z")), zone, null, emptyMap())

        r.setLeadMinutes(60)

        assertEquals(Instant.parse("2026-09-14T14:00:00Z"), alarms.scheduled.getValue("waffled.evt.a").fireAt)
        assertEquals(60, store.saved.leadMinutes)
        assertEquals(60, r.prefs.value.leadMinutes)
    }

    @Test
    fun withoutPermissionNothingIsScheduled() {
        val alarms = FakeAlarms()
        reminders(alarms = alarms, permitted = false)
            .reconcile(listOf(event("a", "2026-09-14T15:00:00Z")), zone, null, emptyMap())
        assertTrue(alarms.scheduled.isEmpty())
    }

    @Test
    fun preferencesLoadFromTheStore() {
        val r = reminders(MemoryStore(ReminderPrefs(enabled = true, allDayHour = 6)))
        assertEquals(6, r.prefs.value.allDayHour)
    }
}
