package app.waffled.feature.settings

import app.waffled.core.network.ServerUrl
import app.waffled.core.network.ServerUrlVerdict

/** What happened when the user saved a new server address. */
sealed interface ServerChange {
    data class Updated(val url: String) : ServerChange
    data class Rejected(val verdict: ServerUrlVerdict) : ServerChange
    data class PendingUploads(val count: Int) : ServerChange
    data object TransitionInProgress : ServerChange
    data object TeardownFailed : ServerChange
}

/**
 * The connection the About panel edits. Implemented by `app`, which owns the stored
 * address and whatever must be torn down (sync, local data) when it changes.
 */
interface ServerConnection {
    fun currentUrl(): String
    val defaultUrl: String
    suspend fun change(input: String): ServerChange
}

data class SaveMessage(val error: String? = null, val note: String? = null)

object ServerAddressForm {

    const val INVALID_ADDRESS = "Enter a full server address beginning with http:// or https://."

    /**
     * A warning shown while typing when the address is a public host over plain http —
     * plan §7.5. Saving it is refused, so say why before the user hits Save.
     */
    fun liveWarning(input: String): String? {
        if (input.isBlank()) return null
        val verdict = ServerUrl.validate(input)
        return (verdict as? ServerUrlVerdict.InsecurePublic)?.let { insecureCopy(it.host) }
    }

    fun message(change: ServerChange): SaveMessage = when (change) {
        is ServerChange.Updated -> SaveMessage(note = "Saved. The app is now using this server.")
        is ServerChange.Rejected -> when (val v = change.verdict) {
            is ServerUrlVerdict.InsecurePublic -> SaveMessage(error = insecureCopy(v.host))
            else -> SaveMessage(error = INVALID_ADDRESS)
        }
        is ServerChange.PendingUploads -> SaveMessage(
            error = "Wait for ${change.count} pending change${if (change.count == 1) "" else "s"} to sync before changing servers.",
        )
        ServerChange.TransitionInProgress -> SaveMessage(error = "A connection change is already in progress.")
        ServerChange.TeardownFailed -> SaveMessage(
            error = "Couldn’t safely clear the previous connection. Try again before changing servers.",
        )
    }

    /**
     * The URL the Test button probes, or null when the input is not one we would save —
     * a public http host is refused by the release network policy anyway.
     */
    fun probeUrl(input: String): String? = (ServerUrl.validate(input) as? ServerUrlVerdict.Ok)?.url

    private fun insecureCopy(host: String) =
        "$host is on the public internet, so plain http:// would send your password unencrypted. " +
            "Use https:// for it — http:// only works on your home network."
}
