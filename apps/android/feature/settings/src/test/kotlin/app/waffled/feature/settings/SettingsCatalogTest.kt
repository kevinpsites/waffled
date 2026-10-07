package app.waffled.feature.settings

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The Settings landing's rows, sections and gates — the order iOS `SettingsView.body`
 * declares. Account + System + About for everyone; Family only for admins.
 */
class SettingsCatalogTest {

    private val allOff: (String) -> Boolean = { false }

    private fun ids(rows: List<SettingsRow>) = rows.map { it.id }

    private fun extra(id: String, section: SettingsSection = SettingsSection.Family, title: String = id) =
        SettingsPanelEntry(id = id, title = title, icon = "🧪", section = section, subtitle = "sub") {}

    @Test
    fun `non-admin sees only account, system and about rows`() {
        val rows = SettingsCatalog.rows(isAdmin = false, isModuleOn = allOff, extras = emptyList())
        assertEquals(
            listOf(
                SettingsPanelId.HOUSEHOLDS, SettingsPanelId.NOTIFICATIONS,
                SettingsPanelId.APPEARANCE, SettingsPanelId.PERMISSIONS,
                SettingsPanelId.ABOUT,
            ),
            ids(rows),
        )
    }

    @Test
    fun `admin sees the family section in the modules order`() {
        val rows = SettingsCatalog.rows(isAdmin = true, isModuleOn = { true }, extras = emptyList())
        assertEquals(
            listOf(
                SettingsPanelId.HOUSEHOLDS, SettingsPanelId.NOTIFICATIONS,
                SettingsPanelId.FAMILY, SettingsPanelId.CALENDARS, SettingsPanelId.CHORES_REWARDS,
                SettingsPanelId.MEALS, SettingsPanelId.LISTS, SettingsPanelId.PANTRY,
                SettingsPanelId.FAMILY_NIGHT, SettingsPanelId.WEEKLY_PLANNING,
                SettingsPanelId.MODULES, SettingsPanelId.DISPLAY,
                SettingsPanelId.APPEARANCE, SettingsPanelId.AI, SettingsPanelId.PERMISSIONS,
                SettingsPanelId.ABOUT,
            ),
            ids(rows),
        )
    }

    @Test
    fun `module-gated rows follow their module`() {
        val onlyPantry: (String) -> Boolean = { it == "pantry" }
        val rows = ids(SettingsCatalog.rows(isAdmin = true, isModuleOn = onlyPantry, extras = emptyList()))
        assertTrue(SettingsPanelId.PANTRY in rows)
        assertFalse(SettingsPanelId.FAMILY_NIGHT in rows)
        assertFalse(SettingsPanelId.WEEKLY_PLANNING in rows)
    }

    @Test
    fun `sections are labelled the way iOS labels them`() {
        val rows = SettingsCatalog.rows(isAdmin = true, isModuleOn = { true }, extras = emptyList())
        val bySection = rows.groupBy { it.section }.mapValues { (_, r) -> r.first().id }
        assertEquals(SettingsPanelId.HOUSEHOLDS, bySection[SettingsSection.Account])
        assertEquals(SettingsPanelId.FAMILY, bySection[SettingsSection.Family])
        assertEquals(SettingsPanelId.APPEARANCE, bySection[SettingsSection.System])
        assertEquals(SettingsPanelId.ABOUT, bySection[SettingsSection.About])
        assertEquals("Account", SettingsSection.Account.label)
        assertEquals(null, SettingsSection.About.label)
    }

    @Test
    fun `built-in panels open their own screen`() {
        val rows = SettingsCatalog.rows(isAdmin = true, isModuleOn = { true }, extras = emptyList())
        val builtIn = rows.filter { it.target is SettingsRowTarget.BuiltIn }.map { it.id }
        assertEquals(
            listOf(
                SettingsPanelId.HOUSEHOLDS, SettingsPanelId.FAMILY, SettingsPanelId.CHORES_REWARDS,
                SettingsPanelId.MODULES, SettingsPanelId.APPEARANCE, SettingsPanelId.PERMISSIONS,
                SettingsPanelId.ABOUT,
            ),
            builtIn,
        )
    }

    @Test
    fun `a panel nobody supplied is shown as Soon, like the iOS Lists row`() {
        val rows = SettingsCatalog.rows(isAdmin = true, isModuleOn = { true }, extras = emptyList())
        assertIs<SettingsRowTarget.Soon>(rows.first { it.id == SettingsPanelId.CALENDARS }.target)
        assertIs<SettingsRowTarget.Soon>(rows.first { it.id == SettingsPanelId.LISTS }.target)
    }

    @Test
    fun `a supplied panel fills its catalog slot and keeps iOS position`() {
        val calendars = extra(SettingsPanelId.CALENDARS, title = "Calendars!")
        val rows = SettingsCatalog.rows(isAdmin = true, isModuleOn = { true }, extras = listOf(calendars))
        val row = rows.first { it.id == SettingsPanelId.CALENDARS }
        assertIs<SettingsRowTarget.Extra>(row.target)
        assertEquals("Calendars!", row.title)
        assertEquals(3, rows.indexOf(row))
    }

    @Test
    fun `a supplied panel is still gated like its catalog row`() {
        val ai = extra(SettingsPanelId.AI, section = SettingsSection.System)
        val rows = SettingsCatalog.rows(isAdmin = false, isModuleOn = allOff, extras = listOf(ai))
        assertFalse(rows.any { it.id == SettingsPanelId.AI })
    }

    @Test
    fun `an unknown supplied panel is appended to the end of its section`() {
        val extraFamily = extra("somethingNew", section = SettingsSection.Family)
        val rows = SettingsCatalog.rows(isAdmin = true, isModuleOn = { true }, extras = listOf(extraFamily))
        val family = rows.filter { it.section == SettingsSection.Family }.map { it.id }
        assertEquals("somethingNew", family.last())
    }

    @Test
    fun `unknown family panels stay admin-only`() {
        val extraFamily = extra("somethingNew", section = SettingsSection.Family)
        val rows = SettingsCatalog.rows(isAdmin = false, isModuleOn = allOff, extras = listOf(extraFamily))
        assertFalse(rows.any { it.id == "somethingNew" })
    }

    @Test
    fun `a supplied panel cannot replace a built-in one`() {
        val fake = extra(SettingsPanelId.ABOUT, section = SettingsSection.About)
        val rows = SettingsCatalog.rows(isAdmin = false, isModuleOn = allOff, extras = listOf(fake))
        assertIs<SettingsRowTarget.BuiltIn>(rows.first { it.id == SettingsPanelId.ABOUT }.target)
        assertEquals(1, rows.count { it.id == SettingsPanelId.ABOUT })
    }
}
