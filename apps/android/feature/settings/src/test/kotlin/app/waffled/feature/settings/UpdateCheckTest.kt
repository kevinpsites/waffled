package app.waffled.feature.settings

import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** `VersionCompare` (AppUpdateCheck.swift) plus the ServerUpdateModal's open/retry rules. */
class UpdateCheckTest {

    @Test
    fun `newer semver compares numerically, not lexically`() {
        assertTrue(VersionCompare.isNewer("0.16.0", than = "0.15.3"))
        assertTrue(VersionCompare.isNewer("0.15.10", than = "0.15.9"))
        assertTrue(VersionCompare.isNewer("1.0", than = "0.99.99"))
        assertFalse(VersionCompare.isNewer("0.15.3", than = "0.15.3"))
        assertFalse(VersionCompare.isNewer("0.15.2", than = "0.15.3"))
    }

    @Test
    fun `leading v and pre-release suffixes are tolerated`() {
        assertTrue(VersionCompare.isNewer("v0.16.0", than = "0.15.3"))
        assertFalse(VersionCompare.isNewer("v0.15.3-beta", than = "0.15.3"))
        assertTrue(VersionCompare.isNewer("0.16.0-rc1", than = "0.15.3"))
    }

    @Test
    fun `an unparseable or zero version is never newer`() {
        assertFalse(VersionCompare.isNewer("nightly", than = "0.15.3"))
        assertFalse(VersionCompare.isNewer("0.0.0", than = "0.0.0"))
        assertFalse(VersionCompare.isNewer("", than = "0.1.0"))
    }

    private fun info(enabled: Boolean = true, available: Boolean? = true, tag: String? = "v0.16.0") =
        SettingsApi.UpdateInfo(
            enabled = enabled,
            current = SettingsApi.UpdateInfo.Current(version = "0.15.3"),
            latest = tag?.let { SettingsApi.UpdateInfo.Release(tag = it, url = "https://example.com/$it") },
            updateAvailable = available,
        )

    @Test
    fun `modal opens once per release tag`() {
        assertTrue(ServerUpdateGate.shouldOpen(info(), dismissedTag = null))
        assertFalse(ServerUpdateGate.shouldOpen(info(), dismissedTag = "v0.16.0"))
        assertTrue(ServerUpdateGate.shouldOpen(info(tag = "v0.17.0"), dismissedTag = "v0.16.0"))
    }

    @Test
    fun `remind me later keeps the modal shut across an activity recreation`() {
        assertFalse(ServerUpdateGate.shouldOpen(info(), dismissedTag = null, snoozedTag = "v0.16.0"))
        assertTrue(ServerUpdateGate.shouldOpen(info(tag = "v0.17.0"), dismissedTag = null, snoozedTag = "v0.16.0"))
    }

    @Test
    fun `modal stays shut when checking is off or nothing is newer`() {
        assertFalse(ServerUpdateGate.shouldOpen(info(enabled = false), null))
        assertFalse(ServerUpdateGate.shouldOpen(info(available = false), null))
        assertFalse(ServerUpdateGate.shouldOpen(info(available = null), null))
        assertFalse(ServerUpdateGate.shouldOpen(info(tag = null), null))
    }

    @Test
    fun `display tag drops a leading v`() {
        assertEquals("0.16.0", ServerUpdateGate.displayTag("v0.16.0"))
        assertEquals("0.16.0", ServerUpdateGate.displayTag("V0.16.0"))
        assertEquals("0.16.0", ServerUpdateGate.displayTag("0.16.0"))
    }

    @Test
    fun `fetch retries transient failures then answers`() = runTest {
        var calls = 0
        val result = ServerUpdateGate.fetchWithRetry(attempts = 5, delayMillis = 0) {
            calls++
            if (calls < 3) error("booting") else info()
        }
        assertEquals(3, calls)
        assertEquals("0.15.3", result?.current?.version)
    }

    @Test
    fun `fetch stops at once on 401 or 403 - not an admin`() = runTest {
        var calls = 0
        val result = ServerUpdateGate.fetchWithRetry(attempts = 5, delayMillis = 0) {
            calls++
            throw WaffledApiException(403, "Forbidden")
        }
        assertEquals(1, calls)
        assertNull(result)
    }

    @Test
    fun `fetch gives up after the attempt budget`() = runTest {
        var calls = 0
        val result = ServerUpdateGate.fetchWithRetry(attempts = 4, delayMillis = 0) {
            calls++
            error("down")
        }
        assertEquals(4, calls)
        assertNull(result)
    }
}
