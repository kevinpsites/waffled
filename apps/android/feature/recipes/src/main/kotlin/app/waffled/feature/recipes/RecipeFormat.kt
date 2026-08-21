package app.waffled.feature.recipes

import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * Whole-number + common-fraction amount formatting (½ ¼ ¾ ⅓ ⅔), shared by the detail
 * screen, the grocery picker and cook mode — the Kotlin port of `RecipeAmount` in
 * `apps/ios/.../Features/Meals/RecipeDetailView.swift`.
 *
 * Recipes are written in fractions and the database stores doubles; "0.5 cup flour" is a
 * spreadsheet, not a recipe.
 */
object RecipeAmount {

    fun format(n: Double?): String {
        if (n == null || n <= 0) return ""
        val whole = floor(n).toInt()
        val cents = ((n - whole) * 100).roundToInt()
        val glyph = when (cents) {
            50 -> "½"
            25 -> "¼"
            75 -> "¾"
            33 -> "⅓"
            67 -> "⅔"
            else -> null
        }
        if (glyph != null) return if (whole > 0) "$whole$glyph" else glyph
        if (cents == 0 || cents == 100) return n.roundToInt().toString()
        val trimmed = (n * 100).roundToInt() / 100.0
        // Drop a trailing ".0" — "1.2", never "1.20" and never "2.0".
        return if (trimmed == floor(trimmed)) trimmed.toInt().toString() else trimmed.toString()
    }

    /** The whole "1½ cup" line, amount and unit together. */
    fun line(amount: Double?, unit: String?): String {
        val a = format(amount)
        if (a.isEmpty()) return ""
        return unit?.takeIf { it.isNotBlank() }?.let { "$a $it" } ?: a
    }

    /** "1h 15m" — how a cook says a duration. */
    fun minutes(total: Int?): String = MealBuilderModel.hoursMinutes(total)
}

/**
 * Category → hero gradient + fallback emoji, mirroring the kiosk's `GRAD_BY_CATEGORY`.
 *
 * One of the two documented cases where literal colours are correct: this is an identity
 * palette that must stay recognisable across themes, like the allergen badges. It is not a
 * theme surface — it sits behind [app.waffled.core.design.WaffledColors.onMedia] text on a
 * scrim, exactly as a photo would.
 */
object RecipeGradient {

    /** The two hex stops for a category's hero, top-leading to bottom-trailing. */
    fun stops(category: String?): Pair<Long, Long> = when (category?.lowercase()) {
        "breakfast" -> 0xF3E2C4L to 0xE6C188L
        "dinner" -> 0xF6D9C6L to 0xE9B596L
        "snack", "dessert" -> 0xECCFA6L to 0xD8A868L
        else -> 0xD9E6C2L to 0xA9C585L // lunch / fallback
    }

    fun emoji(category: String?): String = when (category?.lowercase()) {
        "breakfast" -> "🥞"
        "lunch" -> "🥗"
        "dinner" -> "🍝"
        "snack", "dessert" -> "🍪"
        else -> "🍽️"
    }
}
