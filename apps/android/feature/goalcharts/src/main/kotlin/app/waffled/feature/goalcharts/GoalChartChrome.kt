package app.waffled.feature.goalcharts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.GoalSeries

/**
 * The bundle every one of the eight views reads from.
 *
 * [GoalSeries] is the whole input contract; the three extras here are presentation-only
 * labels the series does not carry (see the module's reported contract gaps) and every one
 * of them is optional, so a caller with nothing but a `GoalSeries` still gets a complete
 * chart.
 *
 * Build it with [rememberGoalChart] so the derived stats and grids are computed once per
 * series change, never inside a draw scope.
 */
@Immutable
class GoalChart(
    val series: GoalSeries,
    val stats: GoalChartStats,
    /** The goal's own name, used as a subtitle by the consistency and collection views. */
    val title: String = "",
    /** Display names by person id. `GoalSeries` carries colours only. */
    val personNames: Map<String, String> = emptyMap(),
    /** Avatar emoji by person id, for the drill-down sheets. */
    val personEmoji: Map<String, String> = emptyMap(),
) {
    val unit: String get() = series.unit
    val today get() = stats.today

    fun name(personId: String): String = personLabel(personId, personNames)
}

@Composable
fun rememberGoalChart(
    series: GoalSeries,
    today: java.time.LocalDate,
    title: String = "",
    personNames: Map<String, String> = emptyMap(),
    personEmoji: Map<String, String> = emptyMap(),
): GoalChart = remember(series, today, title, personNames, personEmoji) {
    GoalChart(
        series = series,
        stats = computeGoalChartStats(series, today),
        title = title,
        personNames = personNames,
        personEmoji = personEmoji,
    )
}

/**
 * A person's identity colour.
 *
 * One of the two documented cases where a literal colour is correct: this is real
 * `persons.color_hex` data arriving in `GoalSeries.personColors`. Anything unparseable
 * falls back to a token rather than to an invented hex.
 */
@Composable
internal fun GoalChart.colorOf(personId: String): Color =
    colorFromHex(series.personColors[personId]) ?: WF.colors.ink3

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/** Every view's header: serif title, quiet subtitle, and whatever the caller hangs off it. */
@Composable
internal fun ChartHeader(
    title: String,
    subtitle: String?,
    modifier: Modifier = Modifier,
    leading: @Composable (RowScope.() -> Unit)? = null,
    trailing: @Composable (RowScope.() -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        leading?.invoke(this)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = WF.type.serif(17.sp), color = WF.colors.ink)
            if (!subtitle.isNullOrBlank()) {
                Text(
                    subtitle,
                    style = WF.type.size(12.sp, FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
        trailing?.invoke(this)
    }
}

/** A "🔥 12 / current streak" figure. Used by the year grid and consistency calendar. */
@Composable
internal fun StatColumn(value: String, label: String, color: Color = WF.colors.ink) {
    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.xxs)) {
        Text(value, style = WF.type.serif(20.sp), color = color)
        Text(label, style = WF.type.size(11.sp, FontWeight.Black), color = WF.colors.ink3)
    }
}

/** The "Less ▢▢▢▢▢ More" ramp key under a heatmap. */
@Composable
internal fun HeatLegend(modifier: Modifier = Modifier) {
    val base = WF.colors.panel
    val peak = WF.colors.success
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Less", style = WF.type.size(11.sp, FontWeight.SemiBold), color = WF.colors.ink3)
        Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxs)) {
            // The same five stops iOS samples the ramp at.
            listOf(0.12f, 0.35f, 0.6f, 0.85f, 1f).forEach { t ->
                Box(
                    Modifier
                        .size(16.dp)
                        .background(heatColor(t, base, peak), RoundedCornerShape(5.dp)),
                )
            }
        }
        Text("More", style = WF.type.size(11.sp, FontWeight.SemiBold), color = WF.colors.ink3)
    }
}

/**
 * The little identity dots along the bottom of a heat cell — who logged that day.
 *
 * On a dark fill they go white (the onInk rule permits a literal white on a saturated
 * coloured fill), because a person's own hue can vanish against deep green.
 */
@Composable
internal fun PersonDots(
    chart: GoalChart,
    personIds: List<String>,
    onDark: Boolean,
    dotSize: androidx.compose.ui.unit.Dp = 4.dp,
) {
    if (personIds.isEmpty()) return
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        personIds.forEach { id ->
            val color = if (onDark) Color.White.copy(alpha = 0.9f) else chart.colorOf(id)
            Box(Modifier.size(dotSize).background(color, CircleShape))
        }
    }
}

/**
 * The background of a single heatmap cell.
 *
 * Hand-rolled with [drawBehind] rather than a shared component because no shared component
 * covers "a fill whose colour is a data value" — and the three states it has to tell apart
 * (heat / logged-nothing / not-tracked) are the point of the whole view.
 */
@Composable
internal fun Modifier.heatCellBackground(
    cell: DayCell,
    intensity: Float,
    corner: androidx.compose.ui.unit.Dp,
): Modifier {
    val base = WF.colors.panel
    val peak = WF.colors.success
    val hair = WF.colors.hair
    val shape = RoundedCornerShape(corner)
    return when (cell.paint) {
        // Something was logged: the ramp.
        DayPaint.Heat -> this.background(heatColor(intensity, base, peak), shape)
        // An entry exists but logged nothing — a visible, quiet cell.
        DayPaint.Empty -> this.background(base, shape)
        // Not tracked: the slot is reserved so the grid stays aligned, but nothing is
        // painted in it. This is the distinction `GoalSeries` omits days to preserve.
        DayPaint.Blank -> this
        // Beyond today: a dashed outline, so tomorrow reads as "not yet", not "missed".
        DayPaint.Future -> this.drawBehind {
            drawRoundRect(
                color = hair,
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(corner.toPx()),
                style = androidx.compose.ui.graphics.drawscope.Stroke(
                    width = 1.dp.toPx(),
                    pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(
                        floatArrayOf(3.dp.toPx(), 3.dp.toPx()),
                    ),
                ),
            )
        }
    }
}

/** A horizontal bar filled to [fraction] of its track. The caller sizes it. */
@Composable
internal fun MiniBar(fraction: Float, color: Color, modifier: Modifier = Modifier) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Box(modifier.background(WF.colors.panel, pill)) {
        Box(
            Modifier
                .fillMaxHeight()
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .background(color, pill),
        )
    }
}
