package app.waffled.feature.meals

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.time.temporal.TemporalAdjusters
import java.time.temporal.WeekFields
import java.util.Locale

/**
 * Dates and labels for the planner grids.
 *
 * **These are display grids, never grocery keys.** The week the planner draws is cut on
 * the DEVICE locale's first day (and the month grid on Sunday, matching the web), because
 * that is the week the person looking at the phone expects to see. The grocery list is
 * keyed by the HOUSEHOLD's `week_start` and lives in [GroceryWeeks] — mixing the two is
 * exactly what caused the PlanMonth grocery-rebuild bug. Nothing here may be passed to a
 * `?weekStart=` parameter.
 *
 * Everything is precomputed by the models rather than called from a Composable: date math
 * in a render path is one of the two documented performance traps carried over from iOS.
 */
object MealsFormat {

    /** Today in the household's timezone — the clock the whole app formats against. */
    fun today(zone: ZoneId): LocalDate = LocalDate.now(zone)

    /**
     * The first day of [date]'s week under the device locale, stepped by [weekOffset]
     * weeks. Display only — see the class docs.
     */
    fun weekStart(date: LocalDate, weekOffset: Int = 0, locale: Locale = Locale.getDefault()): LocalDate =
        date.with(TemporalAdjusters.previousOrSame(WeekFields.of(locale).firstDayOfWeek))
            .plusWeeks(weekOffset.toLong())

    /** The seven days of the week starting at [start]. */
    fun weekDays(start: LocalDate): List<LocalDate> = (0L until 7L).map { start.plusDays(it) }

    /** The 1st of [date]'s month. */
    fun monthStart(date: LocalDate): LocalDate = date.withDayOfMonth(1)

    /**
     * The Sunday on or before the 1st — top-left of the 6x7 month grid. Sunday-cut on
     * purpose: the month grid mirrors the web's, whose weekday header is Su..Sa.
     */
    fun monthGridStart(monthStart: LocalDate): LocalDate =
        monthStart.with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY))

    /** The 42 cells of the month grid. */
    fun monthGridDays(monthStart: LocalDate): List<LocalDate> =
        monthGridStart(monthStart).let { start -> (0L until 42L).map { start.plusDays(it) } }

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
     * The Sunday that starts [ymd]'s week, for GROUPING the month review into weeks.
     *
     * Sunday-cut and display-only, deliberately NOT [GroceryWeeks.weekStarts]: this
     * decides which cards sit under one collapsible header, nothing more. Re-pointing it
     * at the household cut would change the grouping without changing what is rebuilt,
     * which is the confusing half of a bug rather than a fix.
     */
    fun reviewWeekKey(ymd: String): String =
        runCatching { LocalDate.parse(ymd) }.getOrNull()
            ?.with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY))?.toString()
            ?: ymd

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
