package app.waffled.feature.goals

import app.waffled.core.model.GoalCadence
import app.waffled.core.model.GoalPoint
import app.waffled.core.model.GoalSeries
import java.time.LocalDate
import kotlin.math.roundToInt

/**
 * Turns a goal's day-bucketed activity into the [GoalSeries] the data views draw.
 *
 * This is the SEAM between `feature:goals` (which owns fetching, membership and logging)
 * and `feature:goalcharts` (which owns drawing). Goals produces, charts consumes, and
 * neither depends on the other's module.
 *
 * Three rules carry the weight, and all three are pinned by `GoalSeriesBuilderTest`:
 *
 *  1. **A day with no entry is ABSENT, never zero-filled.** That absence is the only way
 *     a view can tell "logged nothing" from "not tracked" — they render differently on a
 *     heatmap. A day the server *did* send at 0 stays, as a zero.
 *  2. **Presence beats amount.** `perMember` may hold a key at 0 (a `count_once` shared
 *     event's attendee: present, not credited), so members are keyed on presence.
 *  3. **The day's total is never lost.** When the credited members sum to LESS than the
 *     day total, the difference is emitted as an unattributed household point, so
 *     `series.total` always agrees with the hero ring.
 *
 * ⚠️ **Known lossy edge: [GoalPoint.value] is an `Int`, while the server sends fractional
 * amounts** (an hours goal logs 1h5m as 1.0833…). Every amount is rounded here, so a
 * 20-minute log on an hours goal becomes a *present day with value 0*. Presence still
 * distinguishes it from an untracked day, but the magnitude is gone and per-day totals
 * can drift from the goal's own total by up to half a unit per day. Reported to the
 * contract's owner; the fix is a `Double` value on `GoalPoint`.
 */
object GoalSeriesBuilder {

    fun build(
        goalType: String,
        unit: String?,
        target: Double?,
        habitPeriod: String?,
        habitTargetPerPeriod: Int?,
        startDate: String,
        endDate: String?,
        today: String,
        days: List<DayEntry>,
        personColors: Map<String, String> = emptyMap(),
    ): GoalSeries = GoalSeries(
        points = points(days),
        target = target(goalType, target, habitTargetPerPeriod),
        cadence = cadence(goalType, habitPeriod),
        rangeStart = parseDayOrNull(startDate),
        // GoalSeries carries no `today`, so an open-ended goal's window has to end
        // somewhere a view can draw to. Today is the only honest answer.
        rangeEnd = parseDayOrNull(endDate) ?: parseDayOrNull(today),
        unit = unit?.trim().orEmpty(),
        personColors = personColors,
    )

    /**
     * One point per credited person per day, plus the uncredited remainder.
     *
     * A day whose key doesn't parse is dropped rather than thrown on — these values come
     * over the wire, and one bad row must not blank an entire chart.
     */
    private fun points(days: List<DayEntry>): List<GoalPoint> =
        days.mapNotNull { entry -> parseDayOrNull(entry.dateKey)?.let { it to entry } }
            .sortedBy { it.first }
            .flatMap { (day, entry) -> pointsForDay(day, entry) }

    private fun pointsForDay(day: LocalDate, entry: DayEntry): List<GoalPoint> {
        if (entry.perMember.isEmpty()) {
            return listOf(GoalPoint(day = day, value = whole(entry.total), personId = null))
        }

        val members = entry.perMember.entries
            .sortedBy { it.key }
            .map { (personId, amount) -> GoalPoint(day = day, value = whole(amount), personId = personId) }

        // An `each_tracks` goal credits everyone fully, so the members can sum ABOVE the
        // pooled day total — the breakdown wins and no phantom point is invented.
        val credited = entry.perMember.values.sum()
        val remainder = entry.total - credited
        if (whole(remainder) <= 0) return members

        return members + GoalPoint(day = day, value = whole(remainder), personId = null)
    }

    /**
     * A habit's target is its per-period count ("5× a week"), which is what a cadence
     * period means; every other type accumulates toward one lifetime number.
     */
    private fun target(goalType: String, target: Double?, habitTargetPerPeriod: Int?): Int? =
        if (goalType == "habit") habitTargetPerPeriod?.takeIf { it > 0 }
        else target?.let { whole(it) }

    private fun cadence(goalType: String, habitPeriod: String?): GoalCadence =
        if (goalType != "habit") {
            GoalCadence.Total
        } else {
            when (habitPeriod?.trim()?.lowercase()) {
                "day" -> GoalCadence.Daily
                "month" -> GoalCadence.Monthly
                // "N× a week" is the server's own default for a habit with no period.
                else -> GoalCadence.Weekly
            }
        }

    private fun whole(value: Double): Int = value.roundToInt()

    private fun parseDayOrNull(key: String?): LocalDate? {
        val raw = key?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return runCatching { GoalDateKey.parse(raw) }.getOrNull()
    }
}
