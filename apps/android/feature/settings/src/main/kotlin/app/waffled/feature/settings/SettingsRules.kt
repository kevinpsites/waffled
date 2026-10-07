package app.waffled.feature.settings

import java.text.BreakIterator
import java.time.LocalDate

/** The household colour palette shared by the person + currency editors (web swatches). */
object WaffledSwatch {
    val all = listOf("#2F7FED", "#EC6049", "#25A368", "#8B5CF6", "#E0A500", "#EC4899", "#14B8A6", "#6B7280")

    fun isPreset(hex: String): Boolean = all.any { it.equals(hex, ignoreCase = true) }
}

/** Keep the first [count] user-perceived characters — an emoji flag or ZWJ family is one. */
internal fun String.takeGraphemes(count: Int): String {
    val breaks = BreakIterator.getCharacterInstance().also { it.setText(this) }
    var end = 0
    repeat(count) {
        val next = breaks.next()
        if (next == BreakIterator.DONE) return this
        end = next
    }
    return substring(0, end)
}

/** Family & People rules (iOS `FamilyPeopleSettingsView` / `PersonEditorSheet`). */
object PeopleRules {
    val memberTypes = listOf("adult", "teen", "kid")

    fun roleLine(m: SettingsApi.Member): String {
        val parts = mutableListOf(m.memberType.capitalized())
        if (m.isOwner) parts += "Owner"
        if (m.isAdmin && !m.isOwner) parts += "Admin"
        return parts.joinToString(" · ")
    }

    fun sanitizePin(raw: String): String = raw.filter { it.isDigit() }.take(8)

    fun isValidPin(pin: String): Boolean = pin.length in 4..8 && pin.all { it.isDigit() }

    fun canSaveLogin(email: String): Boolean = email.trim().let { "@" in it && "." in it }

    fun loginStatus(hasLogin: Boolean, hasPassword: Boolean): String = when {
        !hasLogin -> "No login yet — add an email so this member can sign in."
        hasPassword -> "Can sign in with email & password."
        else -> "Invited via SSO (no password set)."
    }

    fun saveLoginError(status: Int): String = when (status) {
        409 -> "That email is already in use."
        400 -> "Check the email, and use 8+ characters for a password."
        else -> "Couldn’t save (error $status)."
    }

    fun removeLoginError(status: Int): String =
        if (status == 400) "The household owner’s login can’t be removed." else "Couldn’t remove the login."

    fun savePinError(status: Int): String =
        if (status == 400) "A PIN must be 4–8 digits." else "Couldn’t save the PIN (error $status)."

    /** Dates arrive as `yyyy-MM-dd` or a full ISO timestamp; only the day matters. */
    fun birthday(raw: String?): LocalDate? {
        if (raw.isNullOrEmpty()) return null
        return runCatching { LocalDate.parse(raw.take(10)) }.getOrNull()
    }

    fun capEmoji(raw: String): String = raw.takeGraphemes(3)
}

/** The household time-zone menu: a short US-centric list plus whatever is stored. */
object TimeZoneChoices {
    private val zones = listOf(
        "America/New_York" to "Eastern", "America/Chicago" to "Central",
        "America/Denver" to "Mountain", "America/Phoenix" to "Arizona",
        "America/Los_Angeles" to "Pacific", "America/Anchorage" to "Alaska",
        "Pacific/Honolulu" to "Hawaii", "Europe/London" to "London", "UTC" to "UTC",
    )

    fun options(current: String): List<Pair<String, String>> =
        if (zones.any { it.first == current }) zones else zones + (current to current)

    fun label(tz: String): String = zones.firstOrNull { it.first == tz }?.second ?: tz
}

/** Households panel rules (iOS `AccountSettingsView`). */
object AccountRules {
    /** Clearing the mirror would strand queued writes from the previous household. */
    fun switchBlockedMessage(pendingUploads: Int): String? =
        if (pendingUploads <= 0) null
        else "You have $pendingUploads change${if (pendingUploads == 1) "" else "s"} still syncing. Wait for sync to finish, then switch."

    /** [status] null = never reached the server. */
    fun switchError(status: Int?): String = when (status) {
        null -> "Couldn't reach the server to switch."
        403 -> "You're no longer a member of that household."
        else -> "Couldn't switch households (error $status)."
    }

    fun roleText(isAdmin: Boolean, memberType: String): String =
        if (isAdmin) "Admin" else memberType.capitalized()
}

/** Chore photo-proof retention choices. */
object ProofRetention {
    val options = listOf(1 to "1 day", 3 to "3 days", 7 to "1 week", 30 to "30 days", 0 to "Keep until I delete")

    fun label(days: Int?): String {
        days ?: return "…"
        return options.firstOrNull { it.first == days }?.second ?: "$days days"
    }
}

object CurrencyRules {
    fun capSymbol(raw: String): String = raw.takeGraphemes(2)

    /** Keep valid picks; otherwise seed from = first, to = the first that differs. */
    fun seedPickers(currencies: List<SettingsApi.Currency>, from: String, to: String): Pair<String, String> {
        val keys = currencies.map { it.key }
        val f = if (from.isNotEmpty() && from in keys) from else keys.firstOrNull().orEmpty()
        val t = if (to.isNotEmpty() && to in keys) to else keys.firstOrNull { it != f } ?: keys.firstOrNull().orEmpty()
        return f to t
    }

    fun deleteError(serverMessage: String?): String =
        if (serverMessage?.contains("default", ignoreCase = true) == true) "Set another currency as default first."
        else "Couldn’t delete this currency."
}

internal fun String.capitalized(): String =
    lowercase().replaceFirstChar { it.uppercase() }
