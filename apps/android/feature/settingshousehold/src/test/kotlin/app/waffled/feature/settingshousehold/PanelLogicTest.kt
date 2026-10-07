package app.waffled.feature.settingshousehold

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The decisions each panel makes, lifted out of the composables so they can be pinned.
 * Mirrors the private helpers of the iOS Settings views one-for-one.
 */
class PanelLogicTest {

    // ---- AI & Capture ----

    private val capture = SettingsHouseholdApi.CaptureConfig(
        provider = "anthropic",
        model = "claude-x",
        available = mapOf("anthropic" to true, "openai" to false, "ollama" to true),
        defaultModels = mapOf("anthropic" to "claude-x", "ollama" to "llama3"),
    )

    @Test
    fun aiIsCleanUntilTheProviderOrModelChanges() {
        assertFalse(AiSettingsLogic.isDirty(capture, "anthropic", "claude-x"))
        assertFalse(AiSettingsLogic.isDirty(capture, "anthropic", "  claude-x "))
        assertTrue(AiSettingsLogic.isDirty(capture, "anthropic", "claude-y"))
        assertTrue(AiSettingsLogic.isDirty(capture, "ollama", "llama3"))
    }

    @Test
    fun aiBlankModelMeansTheServerDefault() {
        assertNull(AiSettingsLogic.modelForSave("anthropic", "   "))
        assertNull(AiSettingsLogic.modelForSave("heuristic", "anything"))
        assertEquals("m", AiSettingsLogic.modelForSave("openai", " m "))
        // The stored model is null, and a blank field still reads as clean.
        assertFalse(AiSettingsLogic.isDirty(capture.copy(model = null), "anthropic", ""))
    }

    @Test
    fun aiOnlyOffersProvidersWithServerKeys() {
        assertTrue(AiSettingsLogic.isEnabled("heuristic", capture))
        assertTrue(AiSettingsLogic.isEnabled("ollama", capture))
        assertFalse(AiSettingsLogic.isEnabled("openai", capture))
        assertEquals("llama3", AiSettingsLogic.modelOnPick("ollama", capture))
        assertEquals("", AiSettingsLogic.modelOnPick("heuristic", capture))
    }

    // ---- Calendars ----

    private fun cal(
        id: String,
        summary: String?,
        primary: Boolean = false,
        selected: Boolean = true,
        role: String? = "owner",
        writeTarget: Boolean = false,
        visibility: String = "family",
        lastSyncedAt: String? = null,
    ) = SettingsHouseholdApi.Cal(
        id = id, accountId = "a1", summary = summary, accessRole = role, isPrimary = primary,
        selected = selected, isWriteTarget = writeTarget, visibility = visibility,
        lastSyncedAt = lastSyncedAt,
    )

    @Test
    fun calendarsSortPrimaryFirstThenCaseInsensitively() {
        val out = CalendarsLogic.sorted(
            listOf(cal("1", "zeta"), cal("2", "Alpha"), cal("3", "beta", primary = true), cal("4", null)),
        )
        assertEquals(listOf("3", "4", "2", "1"), out.map { it.id })
    }

    @Test
    fun calendarsFilterBySyncedReadOnlyAndSearch() {
        val all = listOf(
            cal("synced", "Family"),
            cal("ro", "Holidays", selected = false, role = "reader"),
            cal("off", "Work", selected = false, role = "writer"),
        )
        assertEquals(listOf("synced", "off"), CalendarsLogic.filtered(all, syncedOnly = false, hideReadOnly = true, search = "").map { it.id })
        assertEquals(listOf("synced"), CalendarsLogic.filtered(all, syncedOnly = true, hideReadOnly = false, search = "").map { it.id })
        assertEquals(listOf("ro"), CalendarsLogic.filtered(all, syncedOnly = false, hideReadOnly = false, search = "HOLI").map { it.id })
    }

    @Test
    fun calendarStatusLineNamesEveryFact() {
        val line = CalendarsLogic.calendarStatusLine(
            cal("1", "x", writeTarget = true, visibility = "personal", lastSyncedAt = "t"),
        ) { "Jun 19, 2:48 PM" }
        assertEquals("Synced Jun 19, 2:48 PM · owner · 🔒 Private (only you) · ★ new events go here", line)
        assertEquals("Sync off · reader", CalendarsLogic.calendarStatusLine(cal("2", "x", selected = false, role = "reader")) { it })
        assertEquals("Will sync · owner · 👪 Family viewable", CalendarsLogic.calendarStatusLine(cal("3", "x")) { it })
    }

    @Test
    fun aFailingFeedLeadsWithWhy() {
        val failing = SettingsHouseholdApi.Feed(
            id = "f", url = "https://x", visibility = "personal", personName = "Elaine",
            lastError = "404", createdAt = "c",
        )
        assertEquals("⚠️ 404 · 👤 Elaine · 🔒 Private", CalendarsLogic.feedStatusLine(failing) { it })
        val fresh = failing.copy(lastError = null, personName = null, visibility = "family")
        assertEquals("Will sync shortly · 👪 Whole family", CalendarsLogic.feedStatusLine(fresh) { it })
    }

    @Test
    fun syncSummaryReportsErrorsFirst() {
        val ok = SettingsHouseholdApi.CalendarSyncResult(imported = 3, updated = 1, deleted = 0)
        assertEquals("Imported 3, updated 1, removed 0.", CalendarsLogic.syncSummary(ok))
        val bad = ok.copy(calendars = listOf(SettingsHouseholdApi.CalendarSyncResult.Line("A", "boom")))
        assertEquals("Synced with 1 error(s): boom", CalendarsLogic.syncSummary(bad))
    }

    @Test
    fun bulkSyncSaysHowFarItGot() {
        assertEquals(
            "Updated 2 of 5 calendars. The rest weren’t changed; try again.",
            CalendarsLogic.setAllMessage(updated = 2, total = 5, refreshed = true),
        )
        assertEquals(
            "The calendars were updated, but the latest status couldn’t be loaded.",
            CalendarsLogic.setAllMessage(updated = 5, total = 5, refreshed = false),
        )
        assertNull(CalendarsLogic.setAllMessage(updated = 5, total = 5, refreshed = true))
    }

    // ---- Meals ----

    @Test
    fun participantsCollapseBackToWholeFamily() {
        val all = listOf("a", "b", "c")
        assertEquals(listOf("a", "c"), MealsSettingsLogic.toggleParticipant(null, "b", all))
        assertNull(MealsSettingsLogic.toggleParticipant(listOf("a", "c"), "b", all))
        assertEquals(listOf("a"), MealsSettingsLogic.toggleParticipant(listOf("a", "c"), "c", all))
    }

    @Test
    fun mealsBodyClearsPersonAndInviteesExplicitly() {
        val s = SettingsHouseholdApi.MealCalendarSettings(
            addToCalendar = true, pushToGoogle = false, calendarPersonId = null, participantIds = null,
            times = mapOf("dinner" to "18:00"), durationMinutes = 60, prepReminder = true,
            prepReminderTime = "08:00", prepReminderMealTypes = listOf("dinner"),
        )
        val body = MealsSettingsLogic.body(s)
        assertEquals(JsonNull, body["calendarPersonId"])
        assertEquals(JsonNull, body["participantIds"])
        assertEquals(JsonPrimitive("18:00"), body["times"]!!.jsonObject["dinner"])
        assertEquals(JsonArray(listOf(JsonPrimitive("dinner"))), body["prepReminderMealTypes"])
        assertEquals(JsonPrimitive(60), body["durationMinutes"])

        val picked = MealsSettingsLogic.body(s.copy(calendarPersonId = "p1", participantIds = listOf("p1")))
        assertEquals(JsonPrimitive("p1"), picked["calendarPersonId"])
        assertEquals(JsonArray(listOf(JsonPrimitive("p1"))), picked["participantIds"])
    }

    // ---- Pantry ----

    @Test
    fun locationsDropBlanksAndCaseInsensitiveDuplicates() {
        // Order kept; the first spelling of a duplicate wins.
        assertEquals(listOf("Fridge", "pantry"), PantrySettingsLogic.cleanLocations(listOf(" Fridge ", "", "pantry", "fridge", "Pantry")))
    }

    @Test
    fun iconsArePrunedToSurvivingLocations() {
        val icons = PantrySettingsLogic.prunedIcons(mapOf("Fridge" to "🧊", "Gone" to "x", "Pantry" to ""), listOf("Fridge", "Pantry"))
        assertEquals(mapOf("Fridge" to "🧊"), icons)
    }

    @Test
    fun thresholdsParseOrRevert() {
        assertEquals(0.5, PantrySettingsLogic.parseLow(" 0.5 "))
        assertNull(PantrySettingsLogic.parseLow("-1"))
        assertNull(PantrySettingsLogic.parseLow("lots"))
        assertEquals(60, PantrySettingsLogic.parseStale("99"))
        assertEquals(1, PantrySettingsLogic.parseStale("0"))
        assertEquals(3, PantrySettingsLogic.parseStale("2.6"))
        assertNull(PantrySettingsLogic.parseStale("x"))
        assertEquals("1", PantrySettingsLogic.formatAmount(1.0))
        assertEquals("0.5", PantrySettingsLogic.formatAmount(0.5))
    }

    @Test
    fun locationIconsStayShort() {
        assertEquals("🥫🥫", PantrySettingsLogic.clampIcon("🥫🥫"))
        assertEquals("abcd", PantrySettingsLogic.clampIcon("abcdef"))
    }

    // ---- Landing rows ----

    @Test
    fun landingRowsMatchIosGates() {
        val p = HouseholdSettingsPanels
        assertEquals(listOf("notifications", "calendars", "meals", "pantry", "display", "ai"), p.all.map { it.id })
        assertFalse(p.notifications.adminOnly)
        assertTrue(p.all.filter { it.id != "notifications" }.all { it.adminOnly })
        assertEquals(app.waffled.core.model.WaffledModule.Pantry, p.pantry.module)
        assertEquals("System", p.ai.section)
    }

    // ---- Display & Kiosk ----

    @Test
    fun displayLabelsReadNaturally() {
        assertEquals("1 min", DisplayKioskLogic.minutesLabel(1))
        assertEquals("15 min", DisplayKioskLogic.minutesLabel(15))
        assertEquals("Never", DisplayKioskLogic.idleLabel(0))
        assertEquals("3 min", DisplayKioskLogic.idleLabel(3))
        assertEquals("8 seconds", DisplayKioskLogic.secondsLabel(8))
        assertEquals("1 second", DisplayKioskLogic.secondsLabel(1))
    }

    @Test
    fun albumChoicesAreUniqueSortedAndNonBlank() {
        assertEquals(listOf("Beach", "Zoo"), DisplayKioskLogic.albumChoices(listOf("Zoo", null, "", "Beach", "Zoo")))
    }

    @Test
    fun displayConfigDefaultsTheSlideshowFieldsAnOlderServerOmits() {
        val cfg = app.waffled.core.network.WaffledJson.decodeFromString(
            SettingsHouseholdApi.DisplayConfig.serializer(),
            """{"screensaverMinutes":5,"content":"clock","returnToPicker":false,"resetHomeMinutes":3,
               "nightDim":{"enabled":true,"start":"22:00","end":"06:30"}}""",
        )
        assertEquals("all", cfg.photoSource)
        assertNull(cfg.photoAlbum)
        assertEquals(8, cfg.photoInterval)
        assertTrue(cfg.photoShuffle)
    }
}
