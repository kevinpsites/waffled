package app.waffled.feature.settingshousehold

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import java.time.Instant

/** SharedPreferences-backed [ReminderPrefsStore]; keys match the iOS defaults' names. */
class SharedPrefsReminderStore(context: Context) : ReminderPrefsStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("waffled.notif", Context.MODE_PRIVATE)

    override fun load(): ReminderPrefs {
        val d = ReminderPrefs()
        return ReminderPrefs(
            enabled = prefs.getBoolean("enabled", d.enabled),
            leadMinutes = prefs.getInt("leadMinutes", d.leadMinutes),
            allDayHour = prefs.getInt("allDayHour", d.allDayHour),
            myEventsOnly = prefs.getBoolean("myEventsOnly", d.myEventsOnly),
        )
    }

    override fun save(prefs: ReminderPrefs) {
        this.prefs.edit()
            .putBoolean("enabled", prefs.enabled)
            .putInt("leadMinutes", prefs.leadMinutes)
            .putInt("allDayHour", prefs.allDayHour)
            .putBoolean("myEventsOnly", prefs.myEventsOnly)
            .apply()
    }
}

/**
 * [ReminderAlarms] over the framework `AlarmManager`. AlarmManager can't list what is
 * pending, so the ids we've set are remembered alongside.
 *
 * Inexact `setAndAllowWhileIdle`: exact alarms need the SCHEDULE_EXACT_ALARM special
 * access, which this module deliberately doesn't request. Doze may shift a reminder by
 * a few minutes.
 */
class AlarmManagerReminderAlarms(context: Context) : ReminderAlarms {
    private val ctx = context.applicationContext
    private val alarmManager = ctx.getSystemService(AlarmManager::class.java)
    private val store = ctx.getSharedPreferences("waffled.notif.alarms", Context.MODE_PRIVATE)

    @Synchronized
    override fun scheduledIds(): Set<String> = store.getStringSet(KEY, emptySet()).orEmpty().toSet()

    @Synchronized
    override fun schedule(reminder: PlannedReminder) {
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.fireAt.toEpochMilli(), pending(reminder))
        store.edit().putStringSet(KEY, scheduledIds() + reminder.id).apply()
    }

    @Synchronized
    override fun cancel(id: String) {
        alarmManager.cancel(pending(PlannedReminder(id, "", Instant.EPOCH, "", "")))
        forget(id)
    }

    @Synchronized
    internal fun forget(id: String) {
        store.edit().putStringSet(KEY, scheduledIds() - id).apply()
    }

    /** One PendingIntent per id: the data URI is what makes them distinct. */
    private fun pending(r: PlannedReminder): PendingIntent {
        val intent = Intent(ctx, EventReminderReceiver::class.java)
            .setAction(EventReminderReceiver.ACTION_FIRE)
            .setData(Uri.parse("waffled-reminder://${Uri.encode(r.id)}"))
            .putExtra(EventReminderReceiver.EXTRA_ID, r.id)
            .putExtra(EventReminderReceiver.EXTRA_EVENT_ID, r.eventId)
            .putExtra(EventReminderReceiver.EXTRA_TITLE, r.title)
            .putExtra(EventReminderReceiver.EXTRA_BODY, r.body)
        return PendingIntent.getBroadcast(
            ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private companion object {
        const val KEY = "ids"
    }
}

/** Posts a fired reminder, and handles its Snooze action. Registered by this module's manifest. */
class EventReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val eventId = intent.getStringExtra(EXTRA_EVENT_ID).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        val body = intent.getStringExtra(EXTRA_BODY).orEmpty()
        val alarms = AlarmManagerReminderAlarms(context)
        val notifications = context.getSystemService(NotificationManager::class.java)
        when (intent.action) {
            ACTION_FIRE -> {
                alarms.forget(id)
                ensureChannel(context)
                notifications.notify(eventId.hashCode(), build(context, eventId, title, body))
            }
            ACTION_SNOOZE -> {
                notifications.cancel(eventId.hashCode())
                val at = Instant.now().plusSeconds(EventReminderPlanner.SNOOZE_MINUTES * 60L)
                alarms.schedule(PlannedReminder(EventReminderPlanner.SNOOZE_PREFIX + eventId, eventId, at, title, body))
            }
        }
    }

    private fun build(context: Context, eventId: String, title: String, body: String): Notification {
        val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.putExtra(EXTRA_EVENT_ID, eventId)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val snooze = Intent(context, EventReminderReceiver::class.java)
            .setAction(ACTION_SNOOZE)
            .setData(Uri.parse("waffled-reminder-snooze://${Uri.encode(eventId)}"))
            .putExtra(EXTRA_ID, EventReminderPlanner.SNOOZE_PREFIX + eventId)
            .putExtra(EXTRA_EVENT_ID, eventId)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_BODY, body)
        return Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .apply { if (open != null) setContentIntent(PendingIntent.getActivity(context, eventId.hashCode(), open, flags)) }
            .addAction(
                Notification.Action.Builder(
                    null,
                    "Snooze ${EventReminderPlanner.SNOOZE_MINUTES} min",
                    PendingIntent.getBroadcast(context, eventId.hashCode(), snooze, flags),
                ).build(),
            )
            .build()
    }

    companion object {
        const val ACTION_FIRE = "app.waffled.reminders.FIRE"
        const val ACTION_SNOOZE = "app.waffled.reminders.SNOOZE"
        const val EXTRA_ID = "waffled.reminder.id"

        /** Set on the launch intent when a reminder is tapped; `app` deep-links on it. */
        const val EXTRA_EVENT_ID = "waffled.eventId"
        const val EXTRA_TITLE = "waffled.reminder.title"
        const val EXTRA_BODY = "waffled.reminder.body"

        /** High importance: the iOS reminders are `.timeSensitive`. */
        const val CHANNEL_ID = "event_reminders"

        fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Event reminders", NotificationManager.IMPORTANCE_HIGH),
                )
            }
        }
    }
}

/** The production wiring for [EventReminders]: SharedPreferences + AlarmManager + the OS permission. */
fun EventReminders.Companion.create(context: Context): EventReminders {
    val app = context.applicationContext
    return EventReminders(
        store = SharedPrefsReminderStore(app),
        alarms = AlarmManagerReminderAlarms(app),
        permitted = { notificationsAllowed(app) },
    )
}

/** POST_NOTIFICATIONS is a runtime permission from API 33; below it, only the app toggle matters. */
fun notificationsAllowed(context: Context): Boolean {
    val nm = context.getSystemService(NotificationManager::class.java)
    if (!nm.areNotificationsEnabled()) return false
    return Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
}
