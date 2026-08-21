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
 * Four rules carry the weight, and all four are pinned by `GoalSeriesBuilderTest`:
 *
 *  1. **A day with no entry is ABSENT, never zero-filled.** That absence is the only way
 *     a view can tell "logged nothing" from "not tracked" — they render differently on a
 *     heatmap. A day the server *did* send at 0 stays, as a zero.
 *  2. **Presence beats amount.** `perMember` may hold a key at 0 (a `count_once` shared
 *     event's attendee: present, not credited), so members are keyed on presence.
 *  3. **The day's total is never lost.** When the credited members sum to LESS than the
 *     day total, the difference is emitted as an unattributed household point, so
 *     `series.total` always agrees with the hero ring.
 *  4. **Amounts pass through EXACT.** [GoalPoint.value] is a `Double`, matching the
 *     server's numeric `goal_logs.amount` (`apps/api/src/modules/goals/goals.service.ts:33`),
 *     so an hours goal's 1h5m stays 1.0833… and a 20-minute log stays 0.3333 instead of
 *     rounding to a present day valued zero. Only [GoalSeries.target] is still narrowed
 *     to a whole number, because a target is a count a person chose, not a measurement.
 */
object GoalSeriesBuilder {

    /**
     * Floating-point residue tolerance for the "is there anything uncredited left" test.
     *
     * Amounts used to be rounded to whole numbers here, which incidentally swallowed the
     * residue of summing doubles. Exact pass-through exposes it: a day whose members
     * credit the total precisely can still leave ~1e-16 behind, and without this the
     * builder would emit a phantom unattributed household point for it.
     */
    private const val RESIDUE = 1e-9

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
    ): GoalSeries {
        // The server knows the household's timezone and this client does not, so `today`
        // travels on the series rather than being re-derived from the device's clock.
        val householdToday = parseDayOrNull(today)
        return GoalSeries(
            points = points(days),
            target = target(goalType, target, habitTargetPerPeriod),
            cadence = cadence(goalType, habitPeriod),
            rangeStart = parseDayOrNull(startDate),
            // An open-ended goal's window still has to end somewhere a view can draw to.
            // Today is the only honest answer.
            rangeEnd = parseDayOrNull(endDate) ?: householdToday,
            unit = unit?.trim().orEmpty(),
            personColors = personColors,
            today = householdToday,
        )
    }

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
            return listOf(GoalPoint(day = day, value = entry.total, personId = null))
        }

        val members = entry.perMember.entries
            .sortedBy { it.key }
            .map { (personId, amount) -> GoalPoint(day = day, value = amount, personId = personId) }

        // An `each_tracks` goal credits everyone fully, so the members can sum ABOVE the
        // pooled day total — the breakdown wins and no phantom point is invented.
        val credited = entry.perMember.values.sum()
        val remainder = entry.total - credited
        if (remainder <= RESIDUE) return members

        return members + GoalPoint(day = day, value = remainder, personId = null)
    }

    /**
     * A habit's target is its per-period count ("5× a week"), which is what a cadence
     * period means; every other type accumulates toward one lifetime number.
     *
     * This is the ONE place rounding survives, and deliberately: [GoalSeries.target] is an
     * `Int` because a target is a whole number a person chose ("read 100 pages"). The
     * server types it as a double, so a fractional target is narrowed here rather than
     * silently somewhere downstream.
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
