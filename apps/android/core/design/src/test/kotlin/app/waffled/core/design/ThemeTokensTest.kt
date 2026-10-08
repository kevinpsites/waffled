package app.waffled.core.design

import androidx.compose.ui.graphics.Color
import kotlin.math.roundToInt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Parity lock for the Waffled palette.
 *
 * ⚠️ This is the Android twin of `apps/ios/Tests/ThemeTests.swift`, assertion for
 * assertion. The source of truth for every value is the web CSS
 * (`apps/web/src/styles/waffled.css` `:root` + `[data-theme="dark"]`). If you change a
 * token here, change it in all three places — see docs/product/android-port-plan.md §2.2.
 */
class ThemeTokensTest {

    private fun rgb(c: Color): Triple<Int, Int, Int> =
        Triple(
            (c.red * 255).roundToInt(),
            (c.green * 255).roundToInt(),
            (c.blue * 255).roundToInt(),
        )

    private fun rgbOf(vararg v: Int) = Triple(v[0], v[1], v[2])

    // ---- surfaces + ink mirror the source of truth ----

    @Test
    fun surfaceTokensMatchSourceOfTruth() {
        assertEquals(rgbOf(0xFA, 0xF7, 0xF2), rgb(LightColors.canvas))
        assertEquals(rgbOf(0x14, 0x11, 0x0C), rgb(DarkColors.canvas))
        assertEquals(rgbOf(0xFF, 0xFF, 0xFF), rgb(LightColors.card))
        assertEquals(rgbOf(0x23, 0x20, 0x19), rgb(DarkColors.card))
        assertEquals(rgbOf(0x1D, 0x1D, 0x1F), rgb(LightColors.ink))
        assertEquals(rgbOf(0xF3, 0xEE, 0xE4), rgb(DarkColors.ink))
    }

    @Test
    fun elevationInvertsCardIsLighterThanCanvasInDark() {
        // A raised surface catches light: in dark, card must be lighter than canvas.
        val card = rgb(DarkColors.card)
        val canvas = rgb(DarkColors.canvas)
        assertTrue(card.first > canvas.first)
        assertTrue(card.second > canvas.second)
        assertTrue(card.third > canvas.third)
        // In light it is the reverse — canvas is warm-white, card pure white above it.
        assertTrue(rgb(LightColors.card).first >= rgb(LightColors.canvas).first)
    }

    // ---- status tokens flip ----

    @Test
    fun statusTokensExistAndFlip() {
        assertEquals(rgbOf(0x25, 0xA3, 0x68), rgb(LightColors.success))
        assertEquals(rgbOf(0x34, 0xB8, 0x7A), rgb(DarkColors.success))
        assertEquals(rgbOf(0xC0, 0x39, 0x2B), rgb(LightColors.danger))
        assertEquals(rgbOf(0xE1, 0x5B, 0x4C), rgb(DarkColors.danger))
        assertEquals(rgbOf(0xC7, 0x7A, 0x1A), rgb(LightColors.warn))
        assertEquals(rgbOf(0x4C, 0x9B, 0xFF), rgb(DarkColors.info))
    }

    // ---- brand fixedness — the lights-off invariant ----

    @Test
    fun brandHuesAreFixedAcrossThemes() {
        assertEquals(rgb(LightColors.primary), rgb(DarkColors.primary))
        assertEquals(rgb(LightColors.gold), rgb(DarkColors.gold))
    }

    @Test
    fun aiAccentIsLighterInLightRicherInDark() {
        // waffled.css: --ai is #8C74E8 (light) / #6E56CF (dark). An older table had this
        // backwards ("AI purple backwards"); lock the corrected direction.
        assertEquals(rgbOf(0x8C, 0x74, 0xE8), rgb(LightColors.ai))
        assertEquals(rgbOf(0x6E, 0x56, 0xCF), rgb(DarkColors.ai))
    }

    // ---- the onInk rule ----

    @Test
    fun onInkTracksCanvasSoTextOnInkIsNeverInvisible() {
        // Text on a solid `ink` fill must use `onInk`, never literal white — `ink` flips
        // to warm off-white in dark, which would make white invisible.
        assertEquals(rgb(LightColors.canvas), rgb(LightColors.onInk))
        assertEquals(rgb(DarkColors.canvas), rgb(DarkColors.onInk))
    }

    // ---- per-person slots ----

    @Test
    fun personSlotsSolidHuesAreFixed() {
        // `solid` is a single fixed Color per slot, so it cannot vary by theme —
        // assert the actual identity hues instead.
        assertEquals(rgbOf(0x2F, 0x7F, 0xED), rgb(FamilyColor.Person1.solid))
        assertEquals(rgbOf(0xE0, 0x54, 0x8B), rgb(FamilyColor.Person2.solid))
        assertEquals(rgbOf(0x25, 0xA3, 0x68), rgb(FamilyColor.Person3.solid))
        assertEquals(rgbOf(0x8A, 0x5C, 0xF0), rgb(FamilyColor.Person4.solid))
    }

    @Test
    fun personTintBecomesWashInDark() {
        // Light: a pale solid (alpha ~1). Dark: the base hue at ~18–22% alpha.
        assertTrue(FamilyColor.Person1.tint(isDark = false).alpha > 0.9f)
        assertTrue(FamilyColor.Person1.tint(isDark = true).alpha < 0.5f)
    }

    @Test
    fun tintTokensAreSolidInLightAndWashesInDark() {
        assertTrue(LightColors.primaryT.alpha > 0.9f)
        assertTrue(DarkColors.primaryT.alpha < 0.5f)
        assertTrue(LightColors.aiT.alpha > 0.9f)
        assertTrue(DarkColors.aiT.alpha < 0.5f)
    }

    @Test
    fun familyColorSlotAssignmentWrapsAndHandlesNegatives() {
        assertEquals(FamilyColor.Person1, FamilyColor.forIndex(0))
        assertEquals(FamilyColor.Person1, FamilyColor.forIndex(4))
        assertEquals(FamilyColor.Person4, FamilyColor.forIndex(3))
        assertEquals(FamilyColor.Person4, FamilyColor.forIndex(-1))
    }
}

/**
 * Twin of the `ThemeStore` cases in `ThemeTests.swift`. The persisted key is
 * `waffled.theme`, matching iOS UserDefaults; the web uses localStorage `waffled:theme`.
 */
class ThemeStoreTest {

    private class FakePrefs(private val map: MutableMap<String, String> = mutableMapOf()) :
        ThemePrefsStore {
        override fun getString(key: String): String? = map[key]
        override fun putString(key: String, value: String) {
            map[key] = value
        }
    }

    @Test
    fun themeStoreDefaultsToSystem() {
        val store = ThemeStore(FakePrefs())
        assertEquals(ThemePref.System, store.pref)
        // "System" means: follow the device, i.e. no forced dark/light.
        assertEquals(null, store.pref.forcedDark)
    }

    @Test
    fun themeStorePersistsAndMapsColorScheme() {
        val prefs = FakePrefs()
        val store = ThemeStore(prefs)

        store.pref = ThemePref.Dark
        assertEquals(true, store.pref.forcedDark)
        assertEquals("dark", prefs.getString("waffled.theme"))

        store.pref = ThemePref.Light
        assertEquals(false, store.pref.forcedDark)
        assertEquals("light", prefs.getString("waffled.theme"))

        // A fresh store reads the persisted value back.
        assertEquals(ThemePref.Light, ThemeStore(prefs).pref)
    }

    @Test
    fun unknownPersistedValueFallsBackToSystem() {
        val prefs = FakePrefs()
        prefs.putString("waffled.theme", "chartreuse")
        assertEquals(ThemePref.System, ThemeStore(prefs).pref)
    }
}
