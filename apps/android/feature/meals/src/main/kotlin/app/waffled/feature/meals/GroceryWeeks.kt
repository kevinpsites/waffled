package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters

/**
 * Which grocery weeks a meal-plan apply has to rebuild.
 *
 * A grocery rebuild covers exactly ONE week (`weekStart` … +6 days). "Plan my month"
 * used to make a single call with the month's 1st, so every week after the first was
 * planned and then never shopped for. The fix is to derive the weeks from the dates
 * actually written — plus the ones CLEARED, since that shopping has to come back off the
 * list — and rebuild each.
 *
 * **The SERVER owns the week boundary.** These keys are deliberately cut on the
 * HOUSEHOLD's `week_start`, never on the device's locale: grouping a Monday household on
 * Sundays merges two of its weeks into one call and leaves another genuinely uncovered.
 * (The server snaps a mid-week `?weekStart=` onto the household boundary, so a wrongly
 * grouped key doesn't error — it silently rebuilds the wrong week.)
 *
 * All arithmetic uses [LocalDate], which is date-only: there is no zone to get wrong, so
 * the off-by-one week that comes of parsing in one zone and formatting in another cannot
 * arise here.
 */
object GroceryWeeks {

    /**
     * The distinct week-start keys (`yyyy-MM-dd`) covering [dates], sorted.
     *
     * [firstDay] is null when the household's preference genuinely hasn't reached this
     * device yet. That is NOT the same as Sunday, and treating it as Sunday has a silent
     * failure mode: for a Monday household a Sunday cut merges two real weeks into one
     * key, the server snaps that key onto its own boundary, and the week left over is
     * never built. So when it is unknown, cover BOTH cuts — the extra rebuild is
     * idempotent and far cheaper than a week of shopping that quietly never appears.
     *
     * Unparseable dates are skipped rather than guessed at: garbage in, nothing out.
     */
    fun weekStarts(dates: List<String>, firstDay: HouseholdWeekStart?): List<String> {
        val cuts = firstDay?.let { listOf(it.dayOfWeek) }
            ?: listOf(DayOfWeek.SUNDAY, DayOfWeek.MONDAY)
        val keys = sortedSetOf<String>()
        for (raw in dates) {
            val day = runCatching { LocalDate.parse(raw) }.getOrNull() ?: continue
            for (cut in cuts) {
                // previousOrSame: a Monday household's Sunday CLOSES the week that began
                // six days earlier; it does not open a new one.
                keys.add(day.with(TemporalAdjusters.previousOrSame(cut)).toString())
            }
        }
        return keys.toList()
    }

    /**
     * Step the grocery week forward or back from the week the SERVER last returned.
     *
     * It must be the server's own answer, never a week computed here. A device-derived
     * week honours the DEVICE locale's first-day-of-week while the server snaps every
     * `?weekStart=` onto the HOUSEHOLD's. On a Sunday-locale phone in a Monday household
     * those disagree by a day, which was enough for a locally derived "next week" to snap
     * straight back to the week already on screen — and for "last week" to jump two,
     * leaving the week between them impossible to reach.
     *
     * Whatever cut the server used is carried forward untouched: this only adds days.
     * Returns null when there is nothing to step from, so a not-yet-loaded board can't
     * turn a tap into a request for a nonsense week.
     */
    fun step(shownWeekStart: String, weeks: Int): String? = runCatching {
        LocalDate.parse(shownWeekStart).plusWeeks(weeks.toLong()).toString()
    }.getOrNull()
}
