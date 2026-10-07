package app.waffled.feature.settings

import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.delay

/**
 * Lenient semver comparison for update nudges. A leading "v", a pre-release suffix, or a
 * non-numeric tag never counts as newer, so an odd release name can't nag anyone.
 */
object VersionCompare {
    fun isNewer(candidate: String, than: String): Boolean {
        val a = parts(candidate)
        val b = parts(than)
        if (a.all { it == 0 }) return false
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private fun parts(s: String): List<Int> {
        val core = s.trim().trimStart('v', 'V', ' ').substringBefore('-')
        if (core.isEmpty()) return listOf(0)
        return core.split('.').map { it.toIntOrNull() ?: 0 }
    }
}

/**
 * When the admin-only "newer server available" modal opens. It pops once per release:
 * × remembers the tag so it stays shut until an even newer one ships.
 */
object ServerUpdateGate {

    const val DISMISSED_KEY = "waffled.update.dismissed"
    const val UPGRADE_GUIDE_URL = "https://docs.waffled.app/operations/upgrading/"
    const val UPGRADE_COMMAND = "./waffled upgrade"

    fun shouldOpen(info: SettingsApi.UpdateInfo, dismissedTag: String?): Boolean {
        val tag = info.latest?.tag ?: return false
        return info.enabled && info.updateAvailable == true && tag != dismissedTag
    }

    fun displayTag(tag: String): String =
        if (tag.startsWith("v") || tag.startsWith("V")) tag.drop(1) else tag

    /**
     * Retry transient failures (the check runs while the app is still booting). A 401/403
     * is a definitive "not an admin", so stop at once.
     */
    suspend fun fetchWithRetry(
        attempts: Int,
        delayMillis: Long,
        fetch: suspend () -> SettingsApi.UpdateInfo,
    ): SettingsApi.UpdateInfo? {
        repeat(attempts) {
            try {
                return fetch()
            } catch (e: WaffledApiException) {
                if (e.status == 401 || e.status == 403) return null
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                // transient — fall through to the retry delay
            }
            delay(delayMillis)
        }
        return null
    }
}
