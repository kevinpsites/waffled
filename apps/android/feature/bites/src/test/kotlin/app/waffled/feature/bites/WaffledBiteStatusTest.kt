package app.waffled.feature.bites

import org.junit.Test
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Port of `WaffledBiteStatusTests.swift`, plus the person-page badge and countdown text. */
class WaffledBiteStatusTest {

    private val now = Instant.parse("2026-07-23T12:00:00Z")

    @Test
    fun `offline when never seen`() {
        assertFalse(WaffledBiteStatus.isOnline(lastSeenAt = null, now = now))
    }

    @Test
    fun `online when seen right now`() {
        assertTrue(WaffledBiteStatus.isOnline(now.toString(), now))
    }

    @Test
    fun `online just under threshold`() {
        val seen = now.minusSeconds(WaffledBiteStatus.OFFLINE_AFTER_SEC - 1)
        assertTrue(WaffledBiteStatus.isOnline(seen.toString(), now))
    }

    @Test
    fun `offline just over threshold`() {
        val seen = now.minusSeconds(WaffledBiteStatus.OFFLINE_AFTER_SEC + 1)
        assertFalse(WaffledBiteStatus.isOnline(seen.toString(), now))
    }

    @Test
    fun `offline on unparseable timestamp`() {
        assertFalse(WaffledBiteStatus.isOnline("not-a-date", now))
    }

    // ---- the person-page entry badge ----

    private fun device(
        quiet: Boolean = false,
        timer: Boolean = false,
        wake: String = "none",
    ) = WaffledBitesApi.Device(
        id = "d1",
        runtimeState = WaffledBitesApi.RuntimeState(
            quiet = WaffledBitesApi.Countdown(active = quiet, running = quiet),
            timer = WaffledBitesApi.Countdown(active = timer, running = timer),
            wakeLight = WaffledBitesApi.WakeLight(state = wake),
        ),
    )

    @Test
    fun `quiet time and timers outrank the wake light`() {
        assertEquals(WaffledBiteStatus.Badge.Quiet, WaffledBiteStatus.badge(device(quiet = true, timer = true, wake = "sleep")))
        assertEquals(WaffledBiteStatus.Badge.Timer, WaffledBiteStatus.badge(device(timer = true, wake = "wake")))
    }

    @Test
    fun `wake light states map to their badges`() {
        assertEquals(WaffledBiteStatus.Badge.Asleep, WaffledBiteStatus.badge(device(wake = "sleep")))
        assertEquals(WaffledBiteStatus.Badge.AlmostWake, WaffledBiteStatus.badge(device(wake = "warn")))
        assertEquals(WaffledBiteStatus.Badge.AwakeTime, WaffledBiteStatus.badge(device(wake = "wake")))
        assertNull(WaffledBiteStatus.badge(device(wake = "none")))
        assertNull(WaffledBiteStatus.badge(null))
    }

    @Test
    fun `badge labels match iOS`() {
        assertEquals("😴 Quiet time", WaffledBiteStatus.Badge.Quiet.label)
        assertEquals("⏱️ Timer", WaffledBiteStatus.Badge.Timer.label)
        assertEquals("🌙 Asleep", WaffledBiteStatus.Badge.Asleep.label)
        assertEquals("🟡 Almost wake", WaffledBiteStatus.Badge.AlmostWake.label)
        assertEquals("🟢 Awake time", WaffledBiteStatus.Badge.AwakeTime.label)
    }

    // ---- countdown + clock text ----

    @Test
    fun `countdowns show hours only past an hour`() {
        assertEquals("0:00", WaffledBiteFormat.hms(0))
        assertEquals("4:05", WaffledBiteFormat.hms(245))
        assertEquals("2:30:00", WaffledBiteFormat.hms(9000))
    }

    @Test
    fun `alarm time reads in twelve hour form`() {
        assertEquals("12:00 AM", WaffledBiteFormat.amPm(0))
        assertEquals("6:45 AM", WaffledBiteFormat.amPm(6 * 60 + 45))
        assertEquals("12:05 PM", WaffledBiteFormat.amPm(12 * 60 + 5))
        assertEquals("11:59 PM", WaffledBiteFormat.amPm(23 * 60 + 59))
    }

    @Test
    fun `hour and minute fields normalise on blur`() {
        assertEquals("0", HmEntry.normalized(""))
        assertEquals("7", HmEntry.normalized("007"))
        assertEquals("59", HmEntry.normalized("75", cap = 59))
        assertEquals("0", HmEntry.normalized("-3"))
        assertEquals(12, HmEntry.value(" 12 "))
        assertEquals(0, HmEntry.value("abc"))
    }

    @Test
    fun `last seen is never connected without a timestamp`() {
        assertEquals("never connected", WaffledBiteFormat.lastSeen(null, now))
        assertEquals("last seen 5 min ago", WaffledBiteFormat.lastSeen(now.minusSeconds(300).toString(), now))
        assertEquals("last seen 2 hr ago", WaffledBiteFormat.lastSeen(now.minusSeconds(7300).toString(), now))
        assertEquals("last seen 3 days ago", WaffledBiteFormat.lastSeen(now.minusSeconds(3 * 86400 + 5).toString(), now))
    }
}
