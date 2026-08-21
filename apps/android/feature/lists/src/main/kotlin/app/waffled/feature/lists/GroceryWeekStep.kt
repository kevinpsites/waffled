package app.waffled.feature.lists

import java.time.LocalDate

/**
 * Stepping the grocery board from one week to the next.
 *
 * **The SERVER owns the week boundary.** The board is always stepped from the week the
 * server last returned ([GroceryBoardDTO.weekStart]), never from a week computed here: a
 * device-derived week honours the DEVICE region's first-day-of-week, while the server
 * snaps every `?weekStart=` onto the HOUSEHOLD's (`households.week_start`). On a
 * Sunday-locale phone in a Monday household those disagree by a day, which was enough for
 * a locally-derived "next week" to snap straight back to the week already on screen, and
 * for "last week" to jump two — leaving the week between them unreachable. The same class
 * of mistake caused the PlanMonth grocery-rebuild bug.
 *
 * Whatever cut the server used is therefore carried forward untouched: this only adds
 * days. Port of `GroceryWeeks.step` in `apps/ios/.../Features/Meals/GroceryWeeks.swift`
 * (the `weekStarts` half of that file belongs to the Meals feature, not here).
 */
object GroceryWeekStep {

    /**
     * [shownWeekStart] plus [weeks] weeks, as `yyyy-MM-dd`.
     *
     * Returns null when there is nothing to step from, so a not-yet-loaded board can't
     * turn a tap into a request for a nonsense week.
     */
    fun step(shownWeekStart: String, weeks: Int): String? = runCatching {
        // LocalDate is date-only, so there is no zone to get wrong here — the off-by-one
        // week that comes from parsing in one zone and formatting in another can't arise.
        LocalDate.parse(shownWeekStart).plusWeeks(weeks.toLong()).toString()
    }.getOrNull()
}
