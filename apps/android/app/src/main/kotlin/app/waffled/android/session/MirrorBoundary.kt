package app.waffled.android.session

import app.waffled.core.auth.KeyValueStore
import app.waffled.core.network.WaffledJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.util.Base64

sealed interface SignInAdoption {
    data object Adopted : SignInAdoption
    data object TeardownFailed : SignInAdoption
}

/**
 * Who the local PowerSync mirror and its queued writes belong to. Sign-out wipes both: the
 * account no longer has authority here, so its unsent writes are discarded rather than
 * uploaded (same rule as iOS and web). A sign-in as a DIFFERENT principal wipes whatever a
 * failed sign-out wipe left behind.
 *
 * Kiosk person claims inside one household deliberately share the mirror; they only
 * [record] the new owner.
 */
class MirrorBoundary(
    private val store: KeyValueStore,
    private val stopAndClear: suspend () -> Boolean,
    private val rescope: suspend (clearLocal: Boolean, adopt: suspend () -> Unit) -> Boolean,
) {
    fun owner(): String? = store.getString(KEY)

    fun record(principal: String?) {
        if (principal == null) store.remove(KEY) else store.putString(KEY, principal)
    }

    /** Stop sync and wipe the mirror. A failed wipe keeps the owner, so the next account still clears. */
    suspend fun signOut(): Boolean {
        if (!stopAndClear()) return false
        record(null)
        return true
    }

    suspend fun adopt(principal: String?, install: suspend () -> Unit): SignInAdoption {
        if (principal != null && owner() == principal) {
            install()
            return SignInAdoption.Adopted
        }
        if (!rescope(true, install)) return SignInAdoption.TeardownFailed
        record(principal)
        return SignInAdoption.Adopted
    }

    companion object {
        private const val KEY = "waffled.mirror.owner"

        /**
         * `server|sub|household` from the access token's (unverified) claims. The household
         * claim name is configurable server-side (`HOUSEHOLD_CLAIM`), so match its suffix.
         */
        fun principalOf(server: String, accessToken: String): String? {
            val claims = runCatching {
                val payload = accessToken.split('.')[1]
                WaffledJson.parseToJsonElement(String(Base64.getUrlDecoder().decode(payload))).jsonObject
            }.getOrNull() ?: return null
            val sub = claims.string("sub") ?: return null
            val household = claims.entries.firstOrNull { it.key.endsWith("household_id") }
                ?.let { (it.value as? JsonPrimitive)?.content }
            return "$server|$sub|${household.orEmpty()}"
        }

        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.content
    }
}
