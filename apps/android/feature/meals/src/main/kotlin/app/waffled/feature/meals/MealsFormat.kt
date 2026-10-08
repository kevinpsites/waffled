package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/**
 * Dates and labels for the planner grids.
 *
 * Both grids cut on the HOUSEHOLD's first day, never the device locale: the server keys
 * the grocery list by that boundary, so a grid cut elsewhere plans a week straddling two
 * of the household's own. The rebuild keys themselves still come from [GroceryWeeks],
 * which treats an unsynced household differently (it covers both cuts).
 *
 * Everything is precomputed by the models rather than called from a Composable: date math
 * in a render path is one of the two documented performance traps carried over from iOS.
 */
object MealsFormat {

    /** Today in the household's timezone — the clock the whole app formats against. */
    fun today(zone: ZoneId): LocalDate = LocalDate.now(zone)

    /** The household's first day of [date]'s week, stepped by [weekOffset] weeks. */
    fun weekStart(date: LocalDate, firstDay: HouseholdWeekStart, weekOffset: Int = 0): LocalDate =
        firstDay.weekStart(date).plusWeeks(weekOffset.toLong())

    /** The seven days of the week starting at [start]. */
    fun weekDays(start: LocalDate): List<LocalDate> = (0L until 7L).map { start.plusDays(it) }

    /** The 1st of [date]'s month. */
    fun monthStart(date: LocalDate): LocalDate = date.withDayOfMonth(1)

    /** The household's first day on or before the 1st — top-left of the 6x7 month grid. */
    fun monthGridStart(monthStart: LocalDate, firstDay: HouseholdWeekStart): LocalDate =
        firstDay.weekStart(monthStart)

    /** The 42 cells of the month grid. */
    fun monthGridDays(monthStart: LocalDate, firstDay: HouseholdWeekStart): List<LocalDate> =
        monthGridStart(monthStart, firstDay).let { start -> (0L until 42L).map { start.plusDays(it) } }

    /** The month grid's two-letter column headings, opening on the household's day. */
    fun weekdaySymbols(firstDay: HouseholdWeekStart): List<String> =
        firstDay.rotated(listOf("Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"))

    /** `yyyy-MM-dd` — the key every meals endpoint speaks. */
    fun ymd(date: LocalDate): String = date.toString()

    /** "MON", "TUE" … for a day header. */
    fun weekdayShort(date: LocalDate, locale: Locale = Locale.getDefault()): String =
        date.dayOfWeek.getDisplayName(TextStyle.SHORT, locale).uppercase(locale)

    /** "Jul 13" — the secondary line on a day header. */
    fun monthDay(date: LocalDate, locale: Locale = Locale.getDefault()): String =
        "${date.month.getDisplayName(TextStyle.SHORT, locale)} ${date.dayOfMonth}"

    /** "Jul 13 – Jul 19" — the week header's title. */
    fun weekRangeLabel(start: LocalDate, locale: Locale = Locale.getDefault()): String =
        "${monthDay(start, locale)} – ${monthDay(start.plusDays(6), locale)}"

    /** "September 2026". */
    fun monthYearLabel(date: LocalDate, locale: Locale = Locale.getDefault()): String =
        "${date.month.getDisplayName(TextStyle.FULL, locale)} ${date.year}"

    /** "September" — the plan-month sheet's title. */
    fun monthLabel(date: LocalDate, locale: Locale = Locale.getDefault()): String =
        date.month.getDisplayName(TextStyle.FULL, locale)

    /** "TUE SEP 2" — a review card's day line. Falls back to the raw key if unparseable. */
    fun reviewDayLabel(ymd: String, locale: Locale = Locale.getDefault()): String =
        runCatching { LocalDate.parse(ymd) }.getOrNull()
            ?.let { "${weekdayShort(it, locale)} ${monthDay(it, locale).uppercase(locale)}" }
            ?: ymd

    /**
     * The household week [ymd] falls in, for GROUPING the month review under headings that
     * match the planner grid. Heading only — the rebuild keys are [GroceryWeeks.weekStarts].
     */
    fun reviewWeekKey(ymd: String, firstDay: HouseholdWeekStart): String =
        runCatching { LocalDate.parse(ymd) }.getOrNull()?.let { firstDay.weekStart(it).toString() } ?: ymd

    /** "Sep 6" — the label on a month-review week header. */
    fun reviewWeekLabel(key: String, locale: Locale = Locale.getDefault()): String =
        runCatching { LocalDate.parse(key) }.getOrNull()?.let { monthDay(it, locale) } ?: key

    /** "1h 15m" / "45m" — a plate's total time. */
    fun hoursMinutes(total: Int): String = when {
        total <= 0 -> "0m"
        total < 60 -> "${total}m"
        total % 60 == 0 -> "${total / 60}h"
        else -> "${total / 60}h ${total % 60}m"
    }

    /** "Breakfast" from "breakfast". */
    fun slotLabel(slot: String): String =
        slot.replaceFirstChar { it.uppercase() }

    /** breakfast → lunch → dinner → snack → anything else. */
    fun slotOrder(slot: String): Int = when (slot) {
        "breakfast" -> 0
        "lunch" -> 1
        "dinner" -> 2
        "snack" -> 3
        else -> 4
    }

    /**
     * A free-text "eating out" night — draw a fork rather than a plate.
     *
     * A Meal Builder plate also has no `recipeId`, but it is a real meal with real
     * dishes: without the [WeekEntryDTO.isMealBacked] guard a plate someone named
     * "Takeout Night" would be drawn as an eating-out night.
     */
    fun isEatingOut(entry: WeekEntryDTO): Boolean {
        if (entry.recipeId != null || entry.isMealBacked) return false
        val t = entry.title?.lowercase() ?: return false
        return EATING_OUT_WORDS.any { t.contains(it) }
    }

    private val EATING_OUT_WORDS = listOf(
        "eat", "dining", "takeout", "take-out", "take out", "delivery", "order", "out",
    )
}

/** Pure text helpers shared by the plan sheets. */
object MealPlanText {

    /** Turn a provider's error code into something a person can act on. */
    fun friendly(err: String): String =
        if (err == "AIUnavailable" || err == "No AI provider configured") {
            "No AI provider is set up. Choose one in Settings → AI & capture."
        } else {
            err
        }

    /** The provider's human name, for "Drafted via …". */
    fun viaLabel(v: String): String = when (v) {
        "anthropic" -> "Claude"
        "openai" -> "OpenAI"
        "ollama", "local" -> "local AI"
        else -> v
    }
}
