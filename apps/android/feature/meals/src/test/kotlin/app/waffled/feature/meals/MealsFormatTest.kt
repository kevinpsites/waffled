package app.waffled.feature.meals

import org.junit.Test
import java.time.LocalDate
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The planner grids' date math.
 *
 * These are DISPLAY grids. The week cut here follows the device locale and the month grid
 * is Sunday-cut like the web's; neither is ever a grocery key. [GroceryWeeks] owns that
 * boundary, and the whole point of keeping them apart is that they legitimately disagree.
 */
class MealsFormatTest {

    private val us = Locale.US // week starts Sunday
    private val gb = Locale.UK // week starts Monday

    @Test
    fun `the week grid follows the device locale, not the household`() {
        val wednesday = LocalDate.parse("2026-08-19")
        assertEquals(LocalDate.parse("2026-08-16"), MealsFormat.weekStart(wednesday, locale = us))
        assertEquals(LocalDate.parse("2026-08-17"), MealsFormat.weekStart(wednesday, locale = gb))
    }

    @Test
    fun `stepping the week grid moves whole weeks`() {
        val d = LocalDate.parse("2026-08-19")
        assertEquals(LocalDate.parse("2026-08-23"), MealsFormat.weekStart(d, weekOffset = 1, locale = us))
        assertEquals(LocalDate.parse("2026-08-09"), MealsFormat.weekStart(d, weekOffset = -1, locale = us))
    }

    @Test
    fun `a week is seven consecutive days`() {
        val days = MealsFormat.weekDays(LocalDate.parse("2026-08-16"))
        assertEquals(7, days.size)
        assertEquals(LocalDate.parse("2026-08-22"), days.last())
    }

    /** The month grid is always 42 cells starting on the Sunday on or before the 1st. */
    @Test
    fun `the month grid starts on the sunday before the first`() {
        // September 2026 starts on a Tuesday.
        val start = MealsFormat.monthStart(LocalDate.parse("2026-09-17"))
        assertEquals(LocalDate.parse("2026-09-01"), start)
        assertEquals(LocalDate.parse("2026-08-30"), MealsFormat.monthGridStart(start))
        val grid = MealsFormat.monthGridDays(start)
        assertEquals(42, grid.size)
        assertEquals(LocalDate.parse("2026-08-30"), grid.first())
    }

    /** A month that already begins on a Sunday does not gain a blank leading week. */
    @Test
    fun `a month starting on sunday needs no lead-in`() {
        val start = MealsFormat.monthStart(LocalDate.parse("2026-11-15")) // Nov 1 2026 is a Sunday
        assertEquals(start, MealsFormat.monthGridStart(start))
    }

    /**
     * The month review's week grouping is Sunday-cut and separate from the grocery cut on
     * purpose — it only decides which cards sit under one header.
     */
    @Test
    fun `the review week key groups on sunday regardless of household`() {
        assertEquals("2026-08-16", MealsFormat.reviewWeekKey("2026-08-17"))
        assertEquals("2026-08-16", MealsFormat.reviewWeekKey("2026-08-22"))
        // …and the grocery cut for a Monday household genuinely disagrees.
        assertEquals(listOf("2026-08-17"), GroceryWeeks.weekStarts(listOf("2026-08-17"), HouseholdWeekStart.Monday))
    }

    @Test
    fun `unparseable dates fall back to the raw key rather than throwing`() {
        assertEquals("not-a-date", MealsFormat.reviewWeekKey("not-a-date"))
        assertEquals("", MealsFormat.reviewDayLabel(""))
        assertEquals("nope", MealsFormat.reviewWeekLabel("nope"))
    }

    @Test
    fun `slots order and label the way the day reads`() {
        assertEquals(
            listOf("breakfast", "lunch", "dinner", "snack", "brunch"),
            listOf("snack", "brunch", "dinner", "breakfast", "lunch").sortedBy(MealsFormat::slotOrder),
        )
        assertEquals("Breakfast", MealsFormat.slotLabel("breakfast"))
    }

    @Test
    fun `a plate's total time reads in hours and minutes`() {
        assertEquals("45m", MealsFormat.hoursMinutes(45))
        assertEquals("1h", MealsFormat.hoursMinutes(60))
        assertEquals("1h 15m", MealsFormat.hoursMinutes(75))
        assertEquals("0m", MealsFormat.hoursMinutes(0))
    }

    /**
     * A plate named "Takeout Night" is a real meal with real dishes — it must not be
     * drawn as an eating-out night.
     */
    @Test
    fun `only a free-text night counts as eating out`() {
        val takeout = WeekEntryDTO(id = "1", date = "d", mealType = "dinner", title = "Takeout")
        assertTrue(MealsFormat.isEatingOut(takeout))

        val plate = takeout.copy(mealId = "m1", meal = WeekMealSlot(id = "m1", name = "Takeout Night"))
        assertFalse(MealsFormat.isEatingOut(plate))

        val recipe = takeout.copy(recipeId = "r1")
        assertFalse(MealsFormat.isEatingOut(recipe))

        val cooked = WeekEntryDTO(id = "2", date = "d", mealType = "dinner", title = "Lasagne")
        assertFalse(MealsFormat.isEatingOut(cooked))
    }

    @Test
    fun `provider names and error text are humanised`() {
        assertEquals("Claude", MealPlanText.viaLabel("anthropic"))
        assertEquals("local AI", MealPlanText.viaLabel("ollama"))
        assertEquals("something-else", MealPlanText.viaLabel("something-else"))
        assertEquals(
            "No AI provider is set up. Choose one in Settings → AI & capture.",
            MealPlanText.friendly("AIUnavailable"),
        )
        assertEquals("Rate limited", MealPlanText.friendly("Rate limited"))
    }
}
