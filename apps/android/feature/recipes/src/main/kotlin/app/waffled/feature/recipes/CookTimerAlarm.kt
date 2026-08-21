package app.waffled.feature.recipes

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings

/**
 * The out-of-app half of a cook timer: an exact wall-clock alarm, and the high-importance
 * notification it posts when that instant arrives.
 *
 * The iOS original schedules a *time-sensitive* `UNTimeIntervalNotificationTrigger`.
 * Android needs three separate pieces to get the same behaviour, and each has a way of
 * failing quietly:
 *
 *  1. **An exact alarm.** `setExactAndAllowWhileIdle` is the only scheduling that survives
 *     Doze at the minute a pan needs turning. On API 31+ it needs `SCHEDULE_EXACT_ALARM`,
 *     and on 33+ that is a **user grant** — so [canScheduleExact] is checked every time and
 *     the inexact call is used as a fallback rather than letting the exact one throw. An
 *     inexact alarm may be several minutes late in Doze; the in-app ticker is unaffected,
 *     so this degrades to "the notification is late" rather than "the timer is wrong".
 *  2. **A high-importance channel.** `IMPORTANCE_HIGH` + `CATEGORY_ALARM` is the Android
 *     twin of iOS's time-sensitive interruption level. A channel's importance is fixed at
 *     creation, so the id carries a version suffix — bumping it is the only way to raise
 *     the importance of an already-created channel.
 *  3. **`POST_NOTIFICATIONS`.** A runtime permission on API 33+, requested by Cook Mode
 *     itself (see `CookModeScreen`). Denied, everything else still works: the alarm still
 *     fires, the post is simply dropped by the OS.
 *
 * The content intent deliberately resolves the **launcher** activity by package rather than
 * naming a class: the app module belongs to the integrator, and a feature module must not depend
 * on its activity. The extras it carries are [CookTimerLink]'s payload, which
 * `CookSessionStore.openFromNotification` turns back into a dish + step.
 */
class CookTimerAlarm(private val context: Context) : CookAlarm {

    override fun schedule(timer: CookTimer, link: CookTimerLink) {
        ensureChannel(context)
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val pending = alarmIntent(context, timer, link)

        // Re-adding under the same request code replaces, so calling this on start, on
        // resume and on +1:00 is idempotent — which is what the store relies on.
        if (canScheduleExact(context)) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, timer.fireAtMillis, pending)
        } else {
            // Not granted (or revoked mid-cook). Late is worse than exact but far better
            // than throwing SecurityException and losing the alert entirely.
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, timer.fireAtMillis, pending)
        }
    }

    override fun cancel(timerId: String) {
        context.getSystemService(AlarmManager::class.java)
            ?.cancel(cancelIntent(context, timerId))
        notificationManager(context)?.cancel(timerId, NOTIFICATION_ID)
    }

    override fun stop() {
        // Anything still showing belongs to a session that is over.
        notificationManager(context)?.cancelAll()
    }

    companion object {
        /**
         * Bump the suffix to raise the channel's importance: a channel's importance is
         * fixed once created, and the user's own override always wins after that.
         */
        const val CHANNEL_ID = "waffled.cook.timers.v1"

        /** One id for every cook notification; the per-timer identity is the tag. */
        const val NOTIFICATION_ID = 4201

        internal const val EXTRA_NAME = "cookTimerName"
        internal const val ACTION_FIRE = "app.waffled.feature.recipes.COOK_TIMER"

        /**
         * Is an exact alarm allowed right now?
         *
         * True below API 31 (no gate), and on 31+ only when the permission is granted —
         * which the user can revoke at any point, including mid-cook.
         */
        fun canScheduleExact(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
            return context.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() == true
        }

        /**
         * Where to send someone to grant exact alarms, or null when there is nothing to
         * grant. Offer it once, next to the timer — never as a blocking gate, because
         * inexact alarms still work.
         */
        fun exactAlarmSettings(context: Context): Intent? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || canScheduleExact(context)) return null
            return Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                .setData(android.net.Uri.parse("package:${context.packageName}"))
        }

        internal fun notificationManager(context: Context): NotificationManager? =
            context.getSystemService(NotificationManager::class.java)

        /**
         * The channel a ringing timer posts on.
         *
         * `IMPORTANCE_HIGH` is what makes it heads-up and audible — the Android answer to
         * iOS's time-sensitive interruption level. Creating an existing channel is a no-op,
         * so this is safe to call on every schedule.
         */
        internal fun ensureChannel(context: Context) {
            val manager = notificationManager(context) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Cook timers", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Rings when a step's timer is up while you're cooking."
                    enableVibration(true)
                    setShowBadge(false)
                },
            )
        }

        /** A stable request code per timer, so re-scheduling replaces rather than piles up. */
        private fun requestCode(timerId: String): Int = timerId.hashCode()

        private fun alarmIntent(context: Context, timer: CookTimer, link: CookTimerLink): PendingIntent {
            val intent = Intent(context, CookTimerReceiver::class.java)
                .setAction(ACTION_FIRE)
                .putExtra(EXTRA_NAME, timer.displayName)
            link.writeTo(intent, timer.id)
            return PendingIntent.getBroadcast(
                context,
                requestCode(timer.id),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        /**
         * A PendingIntent equal to the scheduled one for cancellation purposes.
         *
         * Equality ignores extras, so the action + request code are enough — which is why
         * cancelling doesn't need the timer's name or link back.
         */
        private fun cancelIntent(context: Context, timerId: String): PendingIntent =
            PendingIntent.getBroadcast(
                context,
                requestCode(timerId),
                Intent(context, CookTimerReceiver::class.java).setAction(ACTION_FIRE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        /**
         * The tap target: the app's own launcher activity, resolved by package.
         *
         * Named by class nowhere on purpose — the app module is the integrator’s, and a feature
         * module that imported `MainActivity` would invert the dependency.
         */
        internal fun openAppIntent(context: Context, source: Intent): PendingIntent? {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
                ?: return null
            launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            source.extras?.let { launch.putExtras(it) }
            return PendingIntent.getActivity(
                context,
                source.getStringExtra(CookTimerLink.KEY_TIMER).hashCode(),
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}

/**
 * Posts the notification when a scheduled cook timer comes due.
 *
 * Declared in this module's own manifest — a feature module owns its own components, and
 * the merge carries it into the app.
 */
class CookTimerReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != CookTimerAlarm.ACTION_FIRE) return
        val name = intent.getStringExtra(CookTimerAlarm.EXTRA_NAME) ?: "Timer"
        val tag = intent.getStringExtra(CookTimerLink.KEY_TIMER) ?: name

        CookTimerAlarm.ensureChannel(context)
        val manager = CookTimerAlarm.notificationManager(context) ?: return

        val builder = Notification.Builder(context, CookTimerAlarm.CHANNEL_ID)
            .setContentTitle("Timer’s up")
            // The dish, the step and the duration — several timers can ring at once, so
            // this has to say WHICH pan.
            .setContentText(name)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setCategory(Notification.CATEGORY_ALARM)
            .setAutoCancel(true)
        CookTimerAlarm.openAppIntent(context, intent)?.let(builder::setContentIntent)

        // POST_NOTIFICATIONS may be denied on API 33+. The alarm still fired and the
        // in-app ticker is unaffected — the OS simply drops the post, so this must not be
        // allowed to crash the receiver.
        runCatching { manager.notify(tag, CookTimerAlarm.NOTIFICATION_ID, builder.build()) }
    }
}

/** Write this link into intent extras — the [Intent] side of [CookTimerLink.payload]. */
fun CookTimerLink.writeTo(intent: Intent, timerId: String) {
    for ((key, value) in payload(timerId)) {
        when (value) {
            is String -> intent.putExtra(key, value)
            is Int -> intent.putExtra(key, value)
            else -> Unit
        }
    }
}

/**
 * Read a cook-timer link back off a tapped notification's intent.
 *
 * null ⇒ this intent is not one of ours (a normal launch, an OIDC return), so the caller
 * falls through to its other handlers rather than treating it as a cook deep-link.
 */
fun cookTimerLinkFrom(intent: Intent?): CookTimerLink? {
    val extras = intent?.extras ?: return null
    val payload = buildMap<String, Any?> {
        extras.getString(CookTimerLink.KEY_DISH)?.let { put(CookTimerLink.KEY_DISH, it) }
        extras.getString(CookTimerLink.KEY_RECIPE)?.let { put(CookTimerLink.KEY_RECIPE, it) }
        extras.getString(CookTimerLink.KEY_PLATE)?.let { put(CookTimerLink.KEY_PLATE, it) }
        put(CookTimerLink.KEY_STEP, extras.getInt(CookTimerLink.KEY_STEP, 0))
    }
    return CookTimerLink.from(payload)
}
