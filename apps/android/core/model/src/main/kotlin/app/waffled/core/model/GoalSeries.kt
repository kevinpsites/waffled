package app.waffled.core.model

import java.time.LocalDate

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
    /** The value logged on [day]; 0 means "logged nothing", not "no data". */
    val value: Int,
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
 * @param rangeStart / [rangeEnd] the window being shown, so a view can draw empty days
 *   without inferring the range from the data.
 * @param unit what one unit is called ("pages", "km"), for axis and summary labels.
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
) {
    val total: Int get() = points.sumOf { it.value }

    /** Values keyed by day, for O(1) lookup while drawing. */
    val byDay: Map<LocalDate, Int> by lazy {
        points.groupBy { it.day }.mapValues { (_, v) -> v.sumOf { it.value } }
    }

    /** Progress toward [target], truncated — see [progressPercent]. */
    val percent: Int get() = target?.let { progressPercent(total, it) } ?: 0
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
