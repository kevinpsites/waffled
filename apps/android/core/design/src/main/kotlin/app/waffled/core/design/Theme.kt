package app.waffled.core.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The Waffled palette — the Android mirror of `apps/ios/.../DesignSystem/Theme.swift`.
 *
 * ⚠️ FROZEN. The **web CSS (`apps/web/src/styles/waffled.css`) is the source of truth**;
 * iOS mirrors it and Android is the third mirror. Never invent a platform-only colour,
 * and never hardcode a hex at a call site — always a token from here.
 *
 * Two documented exceptions where a literal colour is correct:
 *  1. `Color(hexString:)` applied to real `persons.color_hex` data.
 *  2. Identity palettes that must stay distinct regardless of theme — allergen badges,
 *     per-person/per-category coding, reward confetti.
 *
 * Locked by `ThemeTokensTest`, which is checked against `apps/ios/Tests/ThemeTests.swift`.
 */
@Immutable
data class WaffledColors(
    // Surfaces — note elevation INVERTS in dark: `card` is lighter than `canvas`.
    val canvas: Color,
    val rail: Color,
    val panel: Color,
    val card: Color,
    val card2: Color,
    // Ink
    val ink: Color,
    val ink2: Color,
    val ink3: Color,
    /** Text/icons on a solid [ink] fill. NEVER use literal white — see the onInk rule. */
    val onInk: Color,
    // Hairlines
    val hair: Color,
    val hair2: Color,
    val line: Color,
    // Brand — deliberately FIXED across themes; that fixedness is the brand identity.
    val primary: Color,
    val primaryD: Color,
    val gold: Color,
    // AI
    val ai: Color,
    val ai2: Color,
    val aiD: Color,
    // Status
    val success: Color,
    val danger: Color,
    val warn: Color,
    val info: Color,
    // Tints — solid pastels in light, low-opacity washes of the same hue in dark.
    val primaryT: Color,
    val aiT: Color,
    val successT: Color,
    val dangerT: Color,
    val warnT: Color,
    val infoT: Color,
    val isDark: Boolean,
)

private fun hex(value: Long): Color = Color(0xFF000000L or value)

private fun hex(value: Long, alpha: Float): Color =
    Color(0xFF000000L or value).copy(alpha = alpha)

internal val LightColors = WaffledColors(
    canvas = hex(0xFAF7F2),
    rail = hex(0xF1ECE3),
    panel = hex(0xF4EFE7),
    card = hex(0xFFFFFF),
    card2 = hex(0xFCFAF6),
    ink = hex(0x1D1D1F),
    ink2 = hex(0x6B6B70),
    ink3 = hex(0xA6A29B),
    onInk = hex(0xFAF7F2),
    hair = hex(0x282118, 0.08f),
    hair2 = hex(0x282118, 0.045f),
    line = hex(0x282118, 0.18f),
    primary = hex(0xEC6049),
    primaryD = hex(0xD84A33),
    gold = hex(0xF3A93B),
    ai = hex(0x8C74E8),
    ai2 = hex(0xA48CF0),
    aiD = hex(0x6A3FC4),
    success = hex(0x25A368),
    danger = hex(0xC0392B),
    warn = hex(0xC77A1A),
    info = hex(0x2F7FED),
    primaryT = hex(0xF3E2D8),
    aiT = hex(0xEFEAFC),
    successT = hex(0xE4F5EC),
    dangerT = hex(0xFBE3E1),
    warnT = hex(0xFDF2DD),
    infoT = hex(0xE7F0FE),
    isDark = false,
)

internal val DarkColors = WaffledColors(
    canvas = hex(0x14110C),
    rail = hex(0x1B160F),
    panel = hex(0x1A1710),
    card = hex(0x232019),
    card2 = hex(0x1C1811),
    ink = hex(0xF3EEE4),
    ink2 = hex(0xADA69A),
    ink3 = hex(0x726B5E),
    onInk = hex(0x14110C),
    hair = hex(0xFFFFFF, 0.10f),
    hair2 = hex(0xFFFFFF, 0.06f),
    line = hex(0xFFFFFF, 0.18f),
    primary = hex(0xEC6049),
    primaryD = hex(0xF0745F),
    gold = hex(0xF3A93B),
    ai = hex(0x6E56CF),
    ai2 = hex(0x8C74E8),
    aiD = hex(0xB9A3F5),
    success = hex(0x34B87A),
    danger = hex(0xE15B4C),
    warn = hex(0xE8A13E),
    info = hex(0x4C9BFF),
    primaryT = hex(0xEC6049, 0.18f),
    aiT = hex(0x8C74E8, 0.20f),
    successT = hex(0x34B87A, 0.20f),
    dangerT = hex(0xE15B4C, 0.18f),
    warnT = hex(0xE8A13E, 0.18f),
    infoT = hex(0x4C9BFF, 0.20f),
    isDark = true,
)

/**
 * Per-person identity colours. `solid` is FIXED in both themes; only `tint` adapts,
 * washing instead of using a solid pastel in dark.
 */
enum class FamilyColor(
    val solid: Color,
    private val tintLight: Color,
    private val tintDark: Color,
) {
    Person1(hex(0x2F7FED), hex(0xE7F0FE), hex(0x2F7FED, 0.20f)),
    Person2(hex(0xE0548B), hex(0xFCE9F1), hex(0xE0548B, 0.22f)),
    Person3(hex(0x25A368), hex(0xE4F5EC), hex(0x25A368, 0.20f)),
    Person4(hex(0x8A5CF0), hex(0xF0E9FD), hex(0x8A5CF0, 0.22f));

    fun tint(isDark: Boolean): Color = if (isDark) tintDark else tintLight

    companion object {
        /** Stable slot assignment, matching the iOS ordering. */
        fun forIndex(index: Int): FamilyColor = entries[((index % entries.size) + entries.size) % entries.size]
    }
}

/** Corner radii — the only non-colour scale iOS actually declares. */
object WaffledRadius {
    val xs: Dp = 8.dp
    val sm: Dp = 12.dp
    val md: Dp = 16.dp
    val lg: Dp = 22.dp
    val xl: Dp = 30.dp
    /** Fully-rounded pill. */
    val pill: Dp = 999.dp
}

/**
 * Spacing scale. iOS does NOT tokenise spacing — every call site inlines a number.
 * These are the measured de-facto values (by frequency across `apps/ios/Sources`),
 * declared properly here so Android doesn't inherit that inconsistency.
 */
object WaffledSpacing {
    val xxs: Dp = 4.dp
    val xs: Dp = 6.dp
    val sm: Dp = 8.dp
    val md: Dp = 10.dp
    val lg: Dp = 12.dp
    val xl: Dp = 14.dp
    val xxl: Dp = 16.dp
    val xxxl: Dp = 20.dp

    /** Content must scroll UNDER the phone tab bar; matches iOS `WF.tabBarClearance`. */
    val tabBarClearance: Dp = 110.dp
}

val LocalWaffledColors = staticCompositionLocalOf { LightColors }

/** Token entry point: `WF.colors.card`, `WF.radius.lg`, `WF.spacing.lg`. */
object WF {
    val colors: WaffledColors
        @Composable @ReadOnlyComposable get() = LocalWaffledColors.current
    val radius = WaffledRadius
    val spacing = WaffledSpacing
}

@Composable
fun WaffledTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    CompositionLocalProvider(
        LocalWaffledColors provides colors,
        content = content,
    )
}
