package app.waffled.android.session

import app.waffled.core.auth.KeyValueStore
import app.waffled.core.network.WaffledJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.util.Base64

sealed interface SignInAdoption {
    data object Adopted : SignInAdoption
    data class PendingUploads(val count: Int) : SignInAdoption
    data object TeardownFailed : SignInAdoption
}

/**
 * Who the local PowerSync mirror and its queued writes belong to. Sign-out keeps the
 * mirror (as iOS does), so a sign-in as a DIFFERENT principal wipes it first — and is
 * refused while the previous one's writes are still queued, since the wipe would delete
 * them and uploading them under the new token would misattribute them.
 *
 * Kiosk person claims inside one household deliberately share the mirror; they only
 * [record] the new owner.
 */
class MirrorBoundary(
    private val store: KeyValueStore,
    private val pendingUploads: suspend () -> Int,
    private val rescope: suspend (clearLocal: Boolean, adopt: suspend () -> Unit) -> Boolean,
) {
    fun owner(): String? = store.getString(KEY)

    fun record(principal: String?) {
        if (principal == null) store.remove(KEY) else store.putString(KEY, principal)
    }

    suspend fun adopt(principal: String?, install: suspend () -> Unit): SignInAdoption {
        val owner = owner()
        if (principal != null && owner == principal) {
            install()
            return SignInAdoption.Adopted
        }
        val pending = pendingUploads()
        if (pending > 0) {
            // An install that predates this record: there is no telling whose queue it
            // is, and refusing would leave no way back in.
            if (owner != null) return SignInAdoption.PendingUploads(pending)
            install()
            record(principal)
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
