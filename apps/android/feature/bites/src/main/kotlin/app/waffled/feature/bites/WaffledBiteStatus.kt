package app.waffled.feature.bites

import app.waffled.core.model.WaffledDates
import java.time.Duration
import java.time.Instant
import java.util.Locale

/**
 * Whether a paired device has checked in recently enough to call it online, and what the
 * person-page entry card says it is doing.
 *
 * The 10-minute cutoff matches `apps/web/src/lib/waffledBiteStatus.ts`: wider than the
 * firmware's ~4-minute token refresh, so one missed refresh (a WiFi blip) doesn't flash
 * "Offline" — two misses in a row is a genuine signal.
 */
object WaffledBiteStatus {
    const val OFFLINE_AFTER_SEC: Long = 10 * 60

    fun isOnline(lastSeenAt: String?, now: Instant): Boolean {
        val seen = WaffledDates.parseInstant(lastSeenAt) ?: return false
        return Duration.between(seen, now).seconds <= OFFLINE_AFTER_SEC
    }

    enum class Badge(val label: String) {
        Quiet("😴 Quiet time"),
        Timer("⏱️ Timer"),
        Asleep("🌙 Asleep"),
        AlmostWake("🟡 Almost wake"),
        AwakeTime("🟢 Awake time"),
    }

    /**
     * Quiet time and an active timer outrank the wake light: they are a parent-started
     * action in progress. A snapshot as of the last load; this card doesn't tick.
     */
    fun badge(device: WaffledBitesApi.Device?): Badge? {
        val rt = device?.runtimeState ?: return null
        if (rt.quiet.active) return Badge.Quiet
        if (rt.timer.active) return Badge.Timer
        return when (rt.wakeLight.state) {
            "sleep" -> Badge.Asleep
            "warn" -> Badge.AlmostWake
            "wake" -> Badge.AwakeTime
            else -> null
        }
    }
}

object WaffledBiteFormat {

    /**
     * "H:MM:SS" past an hour, else "M:SS" — the firmware's `formatCountdown`, so the
     * phone and the device show the same shape for a countdown of up to 3h.
     */
    fun hms(sec: Int): String {
        val h = sec / 3600
        val m = (sec % 3600) / 60
        val s = sec % 60
        return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, s) else String.format(Locale.ROOT, "%d:%02d", m, s)
    }

    fun amPm(totalMin: Int): String {
        val h = totalMin / 60
        val m = totalMin % 60
        val h12 = (h % 12).let { if (it == 0) 12 else it }
        return String.format(Locale.ROOT, "%d:%02d %s", h12, m, if (h < 12) "AM" else "PM")
    }

    fun lastSeen(iso: String?, now: Instant): String {
        val seen = WaffledDates.parseInstant(iso) ?: return "never connected"
        val sec = Duration.between(seen, now).seconds.coerceAtLeast(0)
        val ago = when {
            sec < 60 -> "$sec sec ago"
            sec < 3600 -> "${sec / 60} min ago"
            sec < 86_400 -> "${sec / 3600} hr ago"
            else -> (sec / 86_400).let { d -> if (d == 1L) "1 day ago" else "$d days ago" }
        }
        return "last seen $ago"
    }
}

/**
 * The hours/minutes text fields: text-backed so a cleared field stays empty while
 * editing, normalised when focus leaves. Mirrors the iOS `DurationEntry`.
 */
object HmEntry {
    fun value(text: String, cap: Int? = null): Int {
        val floored = (text.trim().toIntOrNull() ?: 0).coerceAtLeast(0)
        return if (cap == null) floored else minOf(cap, floored)
    }

    fun normalized(text: String, cap: Int? = null): String = value(text, cap).toString()
}
