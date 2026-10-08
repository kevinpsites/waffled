package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import org.junit.Test
import java.time.LocalDate
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The planner grids' date math — the Kotlin twin of `PlannerWeekStartTests.swift`.
 *
 * Both grids cut on the HOUSEHOLD's first day, never the device locale: the grocery list
 * is keyed by that boundary, so a grid cut elsewhere plans a week straddling two of the
 * household's own.
 */
class MealsFormatTest {

    private val mon = HouseholdWeekStart.Monday
    private val sun = HouseholdWeekStart.Sunday
    private val midweek = LocalDate.parse("2026-08-19") // a Wednesday

    @Test
    fun `a monday household's week starts on the monday before`() {
        assertEquals(LocalDate.parse("2026-08-17"), MealsFormat.weekStart(midweek, mon))
    }

    @Test
    fun `a sunday household's week starts on the sunday before`() {
        assertEquals(LocalDate.parse("2026-08-16"), MealsFormat.weekStart(midweek, sun))
    }

    @Test
    fun `a day that is the household's first day is its own week start`() {
        assertEquals(LocalDate.parse("2026-08-17"), MealsFormat.weekStart(LocalDate.parse("2026-08-17"), mon))
        assertEquals(LocalDate.parse("2026-08-16"), MealsFormat.weekStart(LocalDate.parse("2026-08-16"), sun))
    }

    @Test
    fun `a monday household's sunday belongs to the week that just ended`() {
        val sunday = LocalDate.parse("2026-08-23")
        assertEquals(LocalDate.parse("2026-08-17"), MealsFormat.weekStart(sunday, mon))
        assertEquals(LocalDate.parse("2026-08-23"), MealsFormat.weekStart(sunday, sun))
    }

    @Test
    fun `the week grid ignores the device locale`() {
        val saved = Locale.getDefault()
        try {
            Locale.setDefault(Locale.UK) // a Monday-first device
            assertEquals(LocalDate.parse("2026-08-16"), MealsFormat.weekStart(midweek, sun))
        } finally {
            Locale.setDefault(saved)
        }
    }

    @Test
    fun `stepping the week grid moves whole weeks`() {
        assertEquals(LocalDate.parse("2026-08-23"), MealsFormat.weekStart(midweek, sun, weekOffset = 1))
        assertEquals(LocalDate.parse("2026-08-09"), MealsFormat.weekStart(midweek, sun, weekOffset = -1))
    }

    @Test
    fun `a week is seven consecutive days`() {
        val days = MealsFormat.weekDays(LocalDate.parse("2026-08-16"))
        assertEquals(7, days.size)
        assertEquals(LocalDate.parse("2026-08-22"), days.last())
    }

    @Test
    fun `the month grid starts on the household's first day on or before the 1st`() {
        // September 2026 starts on a Tuesday.
        val start = MealsFormat.monthStart(LocalDate.parse("2026-09-17"))
        assertEquals(LocalDate.parse("2026-09-01"), start)
        assertEquals(LocalDate.parse("2026-08-31"), MealsFormat.monthGridStart(start, mon))
        assertEquals(LocalDate.parse("2026-08-30"), MealsFormat.monthGridStart(start, sun))
        val grid = MealsFormat.monthGridDays(start, mon)
        assertEquals(42, grid.size)
        assertEquals(LocalDate.parse("2026-08-31"), grid.first())
    }

    @Test
    fun `a month starting on the household's first day needs no lead-in`() {
        val nov = MealsFormat.monthStart(LocalDate.parse("2026-11-15")) // Nov 1 2026 is a Sunday
        assertEquals(nov, MealsFormat.monthGridStart(nov, sun))
        assertEquals(LocalDate.parse("2026-10-26"), MealsFormat.monthGridStart(nov, mon))
    }

    @Test
    fun `the weekday headings are read from the household's first day`() {
        assertEquals(listOf("Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"), MealsFormat.weekdaySymbols(sun))
        assertEquals(listOf("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"), MealsFormat.weekdaySymbols(mon))
    }

    @Test
    fun `the review week key groups on the household's week`() {
        assertEquals("2026-08-16", MealsFormat.reviewWeekKey("2026-08-17", sun))
        assertEquals("2026-08-17", MealsFormat.reviewWeekKey("2026-08-17", mon))
        assertEquals("2026-08-17", MealsFormat.reviewWeekKey("2026-08-23", mon))
    }

    @Test
    fun `unparseable dates fall back to the raw key rather than throwing`() {
        assertEquals("not-a-date", MealsFormat.reviewWeekKey("not-a-date", sun))
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
