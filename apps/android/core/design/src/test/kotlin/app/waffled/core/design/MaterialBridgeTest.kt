package app.waffled.core.design

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Material3 components draw their own container from `MaterialTheme.colorScheme`, so if
 * that scheme isn't ours, a menu or sheet ignores the theme entirely.
 *
 * It did: in dark mode the goal-chart view picker opened as a near-white panel with
 * unreadable text. Every test passed and it compiled cleanly — it was only visible on a
 * device. These assertions lock the surfaces that were wrong.
 */
class MaterialBridgeTest {

    @Test
    fun menusAndSheetsUseOurSurfacesNotMaterialDefaults() {
        // `surfaceContainer` is what DropdownMenu, ModalBottomSheet and AlertDialog paint.
        assertEquals(DarkColors.card, DarkColors.toMaterialScheme().surfaceContainer)
        assertEquals(LightColors.card, LightColors.toMaterialScheme().surfaceContainer)
    }

    @Test
    fun theDarkSchemeIsActuallyDark() {
        // The specific failure: a light container under dark text, or vice versa.
        val dark = DarkColors.toMaterialScheme()
        assertTrue(
            dark.surfaceContainer.luminance() < 0.2f,
            "a menu surface must be dark in dark mode",
        )
        assertTrue(
            dark.onSurface.luminance() > 0.5f,
            "text on that surface must be light",
        )
    }

    @Test
    fun theLightSchemeIsActuallyLight() {
        val light = LightColors.toMaterialScheme()
        assertTrue(light.surfaceContainer.luminance() > 0.8f)
        assertTrue(light.onSurface.luminance() < 0.3f)
    }

    @Test
    fun brandAndStatusColoursComeFromTheTokens() {
        val s = LightColors.toMaterialScheme()
        assertEquals(LightColors.primary, s.primary)
        assertEquals(LightColors.ai, s.secondary)
        assertEquals(LightColors.danger, s.error)
        assertEquals(LightColors.canvas, s.background)
        assertEquals(LightColors.ink, s.onSurface)
    }

    @Test
    fun thereIsNoSecondPaletteToKeepInSync() {
        // Every mapped value must BE a token, not a lookalike — otherwise the bridge
        // becomes a shadow palette that drifts.
        val tokens = setOf(
            DarkColors.canvas, DarkColors.card, DarkColors.card2, DarkColors.panel,
            DarkColors.rail, DarkColors.ink, DarkColors.ink2, DarkColors.primary,
            DarkColors.ai, DarkColors.gold, DarkColors.danger, DarkColors.line,
            DarkColors.hair, DarkColors.onInk, DarkColors.scrim,
            DarkColors.primaryT, DarkColors.aiT, DarkColors.dangerT,
            androidx.compose.ui.graphics.Color.White,
        )
        val s = DarkColors.toMaterialScheme()
        listOf(
            s.primary, s.secondary, s.tertiary, s.background, s.surface,
            s.surfaceVariant, s.surfaceContainer, s.surfaceContainerHigh,
            s.surfaceContainerLow, s.surfaceContainerLowest, s.surfaceContainerHighest,
            s.error, s.outline, s.outlineVariant, s.onSurface, s.onBackground,
        ).forEach { assertTrue(it in tokens, "$it is not a WF token") }
    }
}

private fun androidx.compose.ui.graphics.Color.luminance(): Float =
    0.2126f * red + 0.7152f * green + 0.0722f * blue
