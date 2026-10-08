package app.waffled.feature.settingshousehold

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * A calendar service the household can connect an account to. Google and Outlook each
 * need their own server-side OAuth client, so a household may have neither, either or both.
 */
enum class CalendarProvider(val raw: String) {
    Google("google"),
    Microsoft("microsoft"),
    ;

    /** "Outlook", not "Microsoft" — it's the name on the calendar people connect. */
    val label: String
        get() = when (this) {
            Google -> "Google"
            Microsoft -> "Outlook"
        }

    /** Connect is per-provider; status and patch stay under the legacy google path. */
    val connectPath: String get() = "/api/calendar/$raw/connect"

    val connectTitle: String get() = "Connect $label Calendar"

    companion object {
        /** Google first: it shipped first and is the common case. */
        fun offered(googleConfigured: Boolean, microsoftConfigured: Boolean): List<CalendarProvider> =
            buildList {
                if (googleConfigured) add(Google)
                if (microsoftConfigured) add(Microsoft)
            }

        /**
         * A null provider is a pre-multi-provider server, where every account was Google.
         * An unknown one (a newer server) still gets a row.
         */
        fun accountLabel(provider: String?): String {
            if (provider == null) return "Google account"
            val known = entries.firstOrNull { it.raw == provider } ?: return "Calendar account"
            return "${known.label} account"
        }
    }
}

/**
 * The one rule the ICS feed form enforces: "Private" means only the feed's owner sees
 * it, so a private feed owned by nobody is invisible to everyone. The API refuses that
 * combination; the form makes it unaskable and repairs a feed already stranded in it.
 */
object IcsFeedForm {
    fun offersPrivate(personId: String?): Boolean = personId != null

    fun isPrivate(wanted: Boolean, personId: String?): Boolean = if (personId == null) false else wanted

    /** An edit body that clears name/person explicitly rather than leaving them alone. */
    fun updateBody(url: String, name: String, personId: String?, personal: Boolean): JsonObject {
        val trimmedName = name.trim()
        return buildJsonObject {
            put("url", url.trim())
            put("name", if (trimmedName.isEmpty()) JsonNull else JsonPrimitive(trimmedName))
            put("personId", personId?.let(::JsonPrimitive) ?: JsonNull)
            put("visibility", if (isPrivate(personal, personId)) "personal" else "family")
        }
    }
}
