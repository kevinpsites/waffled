package app.waffled.feature.settings

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Which panel the Settings shell shows for a route — including one handed in by a deep
 * link before the household (and so the viewer's admin flag) has loaded.
 */
class SettingsRoutingTest {

    private val nonAdmin = SettingsCatalog.rows(isAdmin = false, isModuleOn = { false }, extras = emptyList())
    private val admin = SettingsCatalog.rows(isAdmin = true, isModuleOn = { true }, extras = emptyList())

    @Test
    fun `no route is the landing`() {
        val r = SettingsRouting.resolve(null, admin, householdLoaded = true)
        assertNull(r.open)
        assertFalse(r.dropRoute)
    }

    @Test
    fun `a visible built-in route opens its panel`() {
        val r = SettingsRouting.resolve(SettingsPanelId.MODULES, admin, householdLoaded = true)
        assertEquals(SettingsPanelId.MODULES, r.open?.id)
        assertFalse(r.dropRoute)
    }

    @Test
    fun `an admin-only deep link survives the frames before the household loads`() {
        // Before the household answers, the viewer reads as a non-admin and Modules is hidden.
        val r = SettingsRouting.resolve(SettingsPanelId.MODULES, nonAdmin, householdLoaded = false)
        assertNull(r.open)
        assertFalse(r.dropRoute)

        val loaded = SettingsRouting.resolve(SettingsPanelId.MODULES, admin, householdLoaded = true)
        assertEquals(SettingsPanelId.MODULES, loaded.open?.id)
    }

    @Test
    fun `a route whose row is gone once loaded falls back to the landing`() {
        val r = SettingsRouting.resolve(SettingsPanelId.MODULES, nonAdmin, householdLoaded = true)
        assertNull(r.open)
        assertTrue(r.dropRoute)
    }

    @Test
    fun `a Soon row never opens`() {
        val r = SettingsRouting.resolve(SettingsPanelId.CALENDARS, admin, householdLoaded = true)
        assertNull(r.open)
        assertTrue(r.dropRoute)
    }
}
