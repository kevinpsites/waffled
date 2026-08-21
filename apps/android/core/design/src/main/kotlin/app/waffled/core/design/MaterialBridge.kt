package app.waffled.core.design

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

/**
 * Maps the Waffled palette onto Material3's colour scheme.
 *
 * **Why this exists.** Material3 components — `DropdownMenu`, `ModalBottomSheet`,
 * `AlertDialog`, `DatePickerDialog`, `TextField` — draw their own container, and they take
 * its colour from `MaterialTheme.colorScheme`, not from ours. Leaving that at the default
 * meant a menu opened over a dark screen with a near-white surface and near-invisible
 * text: found by composing the goal charts on a device, having compiled cleanly and
 * passed every test.
 *
 * It also explains a run of hand-rolled components across the feature modules, each
 * commented "M3 draws its own container from the M3 colour scheme, which this app doesn't
 * populate". It does now.
 *
 * `WF.*` remains the source of truth. This is a bridge, not a second palette — every
 * value below comes from a token, so there is nothing here to keep in sync by hand.
 */
internal fun WaffledColors.toMaterialScheme(): ColorScheme {
    val base = if (isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        // Brand. White on a saturated fill is the documented legal case.
        primary = primary,
        onPrimary = Color.White,
        primaryContainer = primaryT,
        onPrimaryContainer = ink,

        // AI is our secondary accent.
        secondary = ai,
        onSecondary = Color.White,
        secondaryContainer = aiT,
        onSecondaryContainer = ink,

        tertiary = gold,
        onTertiary = Color.White,

        // Surfaces. Note elevation INVERTS in dark: card sits above canvas.
        background = canvas,
        onBackground = ink,
        surface = card,
        onSurface = ink,
        surfaceVariant = panel,
        onSurfaceVariant = ink2,
        surfaceTint = primary,

        // The containers menus, sheets and dialogs actually draw with — the ones that
        // were defaulting to a light surface in dark mode.
        surfaceContainerLowest = canvas,
        surfaceContainerLow = card2,
        surfaceContainer = card,
        surfaceContainerHigh = panel,
        surfaceContainerHighest = rail,

        inverseSurface = ink,
        inverseOnSurface = onInk,

        error = danger,
        onError = Color.White,
        errorContainer = dangerT,
        onErrorContainer = ink,

        outline = line,
        outlineVariant = hair,
        scrim = scrim,
    )
}
