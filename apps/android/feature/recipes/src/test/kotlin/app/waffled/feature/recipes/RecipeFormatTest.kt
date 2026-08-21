package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Ingredient amounts as a cook reads them — the Kotlin port of the `RecipeAmount` helper
 * in `apps/ios/.../Features/Meals/RecipeDetailView.swift`.
 *
 * Recipes are written in fractions; the database stores doubles. "0.5 cup flour" is a
 * spreadsheet, not a recipe.
 */
class RecipeFormatTest {

    @Test
    fun spellsCommonFractionsAsGlyphs() {
        assertEquals("½", RecipeAmount.format(0.5))
        assertEquals("¼", RecipeAmount.format(0.25))
        assertEquals("¾", RecipeAmount.format(0.75))
        assertEquals("⅓", RecipeAmount.format(1.0 / 3.0))
        assertEquals("⅔", RecipeAmount.format(2.0 / 3.0))
    }

    @Test
    fun combinesAWholeNumberWithItsFraction() {
        assertEquals("1½", RecipeAmount.format(1.5))
        assertEquals("2¼", RecipeAmount.format(2.25))
    }

    @Test
    fun leavesWholeNumbersWhole() {
        assertEquals("1", RecipeAmount.format(1.0))
        assertEquals("12", RecipeAmount.format(12.0))
    }

    /** An amount with no common fraction falls back to a trimmed decimal. */
    @Test
    fun fallsBackToATrimmedDecimal() {
        assertEquals("1.2", RecipeAmount.format(1.2))
        assertEquals("0.4", RecipeAmount.format(0.4))
    }

    /** "0 cups" and "-1 cups" are both nothing worth printing. */
    @Test
    fun printsNothingForNothing() {
        assertEquals("", RecipeAmount.format(0.0))
        assertEquals("", RecipeAmount.format(-1.0))
        assertEquals("", RecipeAmount.format(null))
    }

    /** The whole "1½ cup" line, amount and unit together. */
    @Test
    fun joinsTheAmountToItsUnit() {
        assertEquals("1½ cup", RecipeAmount.line(1.5, "cup"))
        assertEquals("2", RecipeAmount.line(2.0, null))
        assertEquals("", RecipeAmount.line(null, "cup"))
    }

    /** Times read as a cook would say them, not as minutes-since-midnight. */
    @Test
    fun formatsARecipesTotalTime() {
        assertEquals("—", RecipeAmount.minutes(null))
        assertEquals("45m", RecipeAmount.minutes(45))
        assertEquals("1h", RecipeAmount.minutes(60))
        assertEquals("1h 15m", RecipeAmount.minutes(75))
    }
}
