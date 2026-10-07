package app.waffled.feature.settings

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The small rules the iOS settings views compute inline. */
class SettingsRulesTest {

    private fun member(
        type: String = "adult",
        isAdmin: Boolean = false,
        isOwner: Boolean = false,
    ) = SettingsApi.Member(id = "p1", name = "Ana", memberType = type, isAdmin = isAdmin, isOwner = isOwner)

    // ---- Family & People ----

    @Test
    fun `role line lists type then owner or admin`() {
        assertEquals("Kid", PeopleRules.roleLine(member(type = "kid")))
        assertEquals("Adult · Admin", PeopleRules.roleLine(member(isAdmin = true)))
        assertEquals("Adult · Owner", PeopleRules.roleLine(member(isAdmin = true, isOwner = true)))
    }

    @Test
    fun `time zone menu appends an unlisted current zone`() {
        assertEquals("Pacific", TimeZoneChoices.label("America/Los_Angeles"))
        assertEquals("Asia/Tokyo", TimeZoneChoices.label("Asia/Tokyo"))
        assertEquals(9, TimeZoneChoices.options("UTC").size)
        val withTokyo = TimeZoneChoices.options("Asia/Tokyo")
        assertEquals(10, withTokyo.size)
        assertEquals("Asia/Tokyo" to "Asia/Tokyo", withTokyo.last())
    }

    @Test
    fun `pin input keeps up to eight digits`() {
        assertEquals("1234", PeopleRules.sanitizePin("12a3-4"))
        assertEquals("12345678", PeopleRules.sanitizePin("1234567890"))
        assertFalse(PeopleRules.isValidPin("123"))
        assertTrue(PeopleRules.isValidPin("1234"))
        assertTrue(PeopleRules.isValidPin("12345678"))
    }

    @Test
    fun `login can be saved once the email looks like one`() {
        assertFalse(PeopleRules.canSaveLogin("ana"))
        assertFalse(PeopleRules.canSaveLogin("ana@home"))
        assertTrue(PeopleRules.canSaveLogin("  ana@home.org "))
    }

    @Test
    fun `login status copy follows login and password state`() {
        assertEquals("No login yet — add an email so this member can sign in.", PeopleRules.loginStatus(false, false))
        assertEquals("Can sign in with email & password.", PeopleRules.loginStatus(true, true))
        assertEquals("Invited via SSO (no password set).", PeopleRules.loginStatus(true, false))
    }

    @Test
    fun `sign-in errors map from status codes`() {
        assertEquals("That email is already in use.", PeopleRules.saveLoginError(409))
        assertEquals("Check the email, and use 8+ characters for a password.", PeopleRules.saveLoginError(400))
        assertEquals("Couldn’t save (error 500).", PeopleRules.saveLoginError(500))
        assertEquals("The household owner’s login can’t be removed.", PeopleRules.removeLoginError(400))
        assertEquals("Couldn’t remove the login.", PeopleRules.removeLoginError(500))
        assertEquals("A PIN must be 4–8 digits.", PeopleRules.savePinError(400))
        assertEquals("Couldn’t save the PIN (error 503).", PeopleRules.savePinError(503))
    }

    @Test
    fun `birthday round-trips as a date-only string`() {
        assertEquals("2015-03-09", PeopleRules.birthday("2015-03-09T00:00:00.000Z")?.toString())
        assertNull(PeopleRules.birthday(""))
        assertNull(PeopleRules.birthday(null))
        assertNull(PeopleRules.birthday("garbage"))
    }

    @Test
    fun `emoji and currency symbol inputs are capped`() {
        assertEquals("🙂🙂🙂", PeopleRules.capEmoji("🙂🙂🙂🙂"))
        assertEquals("⭐🥢", CurrencyRules.capSymbol("⭐🥢🍪"))
    }

    // ---- Account / households ----

    @Test
    fun `household switch is blocked while writes are queued`() {
        assertNull(AccountRules.switchBlockedMessage(0))
        assertEquals(
            "You have 1 change still syncing. Wait for sync to finish, then switch.",
            AccountRules.switchBlockedMessage(1),
        )
        assertEquals(
            "You have 2 changes still syncing. Wait for sync to finish, then switch.",
            AccountRules.switchBlockedMessage(2),
        )
    }

    @Test
    fun `household switch errors map from status`() {
        assertEquals("You're no longer a member of that household.", AccountRules.switchError(403))
        assertEquals("Couldn't switch households (error 500).", AccountRules.switchError(500))
        assertEquals("Couldn't reach the server to switch.", AccountRules.switchError(null))
    }

    @Test
    fun `membership role reads admin before type`() {
        assertEquals("Admin", AccountRules.roleText(isAdmin = true, memberType = "adult"))
        assertEquals("Teen", AccountRules.roleText(isAdmin = false, memberType = "teen"))
    }

    // ---- Chores & Rewards ----

    @Test
    fun `proof retention labels`() {
        assertEquals("…", ProofRetention.label(null))
        assertEquals("1 week", ProofRetention.label(7))
        assertEquals("Keep until I delete", ProofRetention.label(0))
        assertEquals("14 days", ProofRetention.label(14))
        assertEquals(listOf(1, 3, 7, 30, 0), ProofRetention.options.map { it.first })
    }

    private fun currency(key: String) = SettingsApi.Currency(key = key, label = key, symbol = "•")

    @Test
    fun `conversion pickers seed to two different currencies`() {
        val cur = listOf(currency("stars"), currency("sticks"))
        assertEquals("stars" to "sticks", CurrencyRules.seedPickers(cur, from = "", to = ""))
        assertEquals("sticks" to "stars", CurrencyRules.seedPickers(cur, from = "sticks", to = "gone"))
        assertEquals("stars" to "stars", CurrencyRules.seedPickers(listOf(currency("stars")), "", ""))
        assertEquals("" to "", CurrencyRules.seedPickers(emptyList(), "", ""))
    }

    @Test
    fun `deleting the default currency explains itself`() {
        assertEquals("Set another currency as default first.", CurrencyRules.deleteError("Cannot delete the default currency"))
        assertEquals("Couldn’t delete this currency.", CurrencyRules.deleteError("boom"))
    }

    @Test
    fun `swatch picker knows its presets`() {
        assertEquals(8, WaffledSwatch.all.size)
        assertTrue(WaffledSwatch.isPreset("#2f7fed"))
        assertFalse(WaffledSwatch.isPreset("#123456"))
    }
}
