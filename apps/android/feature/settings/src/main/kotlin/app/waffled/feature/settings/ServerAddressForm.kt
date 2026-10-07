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
        if ('@' in input) return CREDENTIALS
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
    fun probeUrl(input: String): String? =
        if (shapeError(input) != null) null else (ServerUrl.validate(input) as? ServerUrlVerdict.Ok)?.url

    /**
     * Only a bare origin is a server address — no credentials, path, query or fragment
     * (iOS `AppConfig.normalizedApiBaseURL`). `ServerUrl.hostOf` reads the host as the
     * text before the first colon, so `http://localhost:80@evil.com` would otherwise pass
     * the home-network cleartext check while actually talking to evil.com.
     */
    fun shapeError(input: String): String? {
        val raw = input.trim().trimEnd('/')
        val scheme = raw.substringBefore("://", missingDelimiterValue = "")
        if (raw.contains("://") && !scheme.equals("http", true) && !scheme.equals("https", true)) return INVALID_ADDRESS
        val authority = raw.substringAfter("://")
        if (authority.isEmpty() || authority.any { it in "/?#@" || it.isWhitespace() }) return INVALID_ADDRESS
        return null
    }

    private const val CREDENTIALS = "Leave out any user name or password — enter just the server address."

    private fun insecureCopy(host: String) =
        "$host is on the public internet, so plain http:// would send your password unencrypted. " +
            "Use https:// for it — http:// only works on your home network."
}
