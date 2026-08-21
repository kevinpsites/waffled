package app.waffled.feature.rewards

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * The reward-shop categories — mirrors the web `SHOP_CATEGORIES` and iOS `ShopCategory`:
 * a key the backend stores, plus the emoji, label and thumbnail gradient the shop draws.
 * An unknown or null key falls into [Other] rather than disappearing.
 *
 * ### Why these are literal colours
 *
 * `Theme.kt` documents two cases where a literal is correct, and the second is
 * "identity palettes that must stay distinct regardless of theme — allergen badges,
 * **per-person/per-category coding**, reward confetti". These gradients are exactly
 * that: Treats is peach and Screen time is blue in both themes, because a child learns
 * the shop by colour and a palette that re-hues at sunset stops being a label. They are
 * also drawn *behind* a large emoji, not behind body text, so they never participate in
 * the theme's contrast rules.
 *
 * Do NOT "fix" these into tokens — see also [ConfettiView].
 */
enum class ShopCategory(
    val key: String,
    val label: String,
    val emoji: String,
    private val from: Long,
    private val to: Long,
) {
    Treats("treats", "Treats", "🍦", 0xFBDCC4, 0xF3B183),
    Screen("screen", "Screen time", "📺", 0xD3E2FB, 0x9DC0F2),
    Adventures("adventures", "Adventures", "🎢", 0xD9EDD2, 0xA9D59A),
    Toys("toys", "Toys", "🧸", 0xEEDAF7, 0xCFA9E8),
    Privileges("privileges", "Privileges", "👑", 0xFBDCC4, 0xF3B183),

    /** The bucket for an uncategorised or unrecognised reward. Never offered in the editor. */
    Other("other", "Other", "🎁", 0xEEDAF7, 0xCFA9E8),
    ;

    val gradient: Brush
        get() = Brush.linearGradient(
            listOf(Color(0xFF000000L or from), Color(0xFF000000L or to)),
        )

    companion object {
        /** The categories a reward can actually be filed under — [Other] is derived, not chosen. */
        val selectable: List<ShopCategory> = entries.filter { it != Other }

        /** Map a stored key to a category; anything unknown lands in [Other]. */
        fun of(key: String?): ShopCategory = entries.firstOrNull { it.key == key } ?: Other
    }
}
