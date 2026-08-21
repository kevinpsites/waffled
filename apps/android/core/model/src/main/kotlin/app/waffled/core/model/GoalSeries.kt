package app.waffled.core.model

import java.time.LocalDate
import kotlin.math.floor

/**
 * The contract between the Goals feature and its visualisations.
 *
 * Goals owns fetching, membership and logging; the eight data views own drawing. Neither
 * depends on the other's module — they meet here, so both can be built in parallel.
 *
 * A view receives already-derived numbers. It must not parse dates, call an API, or
 * recompute totals while rendering: date math in a render path is one of the two
 * documented jank sources inherited from iOS.
 */
data class GoalPoint(
    val day: LocalDate,
    /**
     * The value logged on [day]; 0 means "logged nothing", not "no data".
     *
     * **A `Double`, because amounts are MEASURED quantities and the server sends them
     * fractional.** `apps/api/src/modules/goals/goals.service.ts:33` is explicit about it:
     * walk_run_distance is the first fractional quantity (miles/km) and the server stores
     * it in the same numeric column as every other amount (`goal_logs.amount`), so
     * decimals ride through unchanged. An hours goal logs 1h5m as 1.0833… the same way.
     *
     * Rounding here is not a cosmetic loss: a 20-minute log (0.3333) collapsed to a
     * *present day valued zero* — a logged day that rendered as "nothing logged" — and
     * per-day totals drifted from the goal's own total by up to half a unit per day.
     *
     * Contrast [GoalSeries.target], which stays an `Int`: a target is a COUNT a person
     * chose ("read 100 pages"), not a measurement.
     */
    val value: Double,
    /** Who logged it, for the per-person breakdown. Null for a household total. */
    val personId: String? = null,
)

/** How a goal is counted, which decides what a chart's axis means. */
enum class GoalCadence { Daily, Weekly, Monthly, Total }

/**
 * Everything a data view needs, and nothing it doesn't.
 *
 * @param points one entry per logged day, ascending. Days with no entry are ABSENT
 *   rather than zero-valued, so a view can distinguish "did nothing" from "not tracked".
 * @param target the goal's target for one [cadence] period, or null for an open goal.
 *   Deliberately an `Int` — see [GoalPoint.value] for which quantities are measured.
 * @param rangeStart / [rangeEnd] the window being shown, so a view can draw empty days
 *   without inferring the range from the data.
 * @param unit what one unit is called ("pages", "km"), for axis and summary labels.
 * @param today the HOUSEHOLD's today. Pace, the current-streak today-or-yesterday rule
 *   and "which month is the current one" all hinge on it, and a consumer that falls back
 *   to `LocalDate.now()` is using the DEVICE's date — the exact drift the household
 *   timezone exists to prevent. Null only when the producer genuinely doesn't know.
 */
data class GoalSeries(
    val points: List<GoalPoint> = emptyList(),
    val target: Int? = null,
    val cadence: GoalCadence = GoalCadence.Daily,
    val rangeStart: LocalDate? = null,
    val rangeEnd: LocalDate? = null,
    val unit: String = "",
    /** Per-person colours, keyed by person id — pass through to the view, don't invent. */
    val personColors: Map<String, String> = emptyMap(),
    val today: LocalDate? = null,
) {
    val total: Double get() = points.sumOf { it.value }

    /** Values keyed by day, for O(1) lookup while drawing. */
    val byDay: Map<LocalDate, Double> by lazy {
        points.groupBy { it.day }.mapValues { (_, v) -> v.sumOf { it.value } }
    }

    /**
     * Progress toward [target], truncated — see [progressPercent].
     *
     * The total is FLOORED before the comparison rather than rounded: 99.6 of 100 is 99%,
     * never a premature 100% that says "done" while a fraction of a unit is still owed.
     */
    val percent: Int get() = target?.let { progressPercent(floor(total).toInt(), it) } ?: 0
}

/**
 * A recipe as other features refer to it — the Meals planner picking one, Today naming
 * tonight's dinner. The full recipe belongs to the recipes feature.
 */
data class RecipeRef(
    val id: String,
    val title: String,
    val emoji: String? = null,
    val imagePath: String? = null,
)
