package app.waffled.feature.goalcharts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * A point on the cumulative line, already reduced to plot space.
 *
 * `x` is days since the domain start and `y` is the running total — both plain numbers, so
 * the draw scope only ever scales, never parses a date.
 */
internal data class PacePoint(val x: Float, val y: Float)

/**
 * Reduce a series to the staircase the pace chart draws.
 *
 * Walking every calendar day to emit a point apiece is wasted work: between logged days
 * the cumulative total never changes, so those interior points are collinear and
 * contribute nothing. This walks only the days that actually have a log, emitting a flat
 * point just before each jump and the jump itself — the same rendered staircase, without
 * visiting every no-op day in between. Ported from the iOS comment of the same shape.
 */
internal fun pacePoints(stats: GoalChartStats): List<PacePoint> {
    val start = stats.rangeStart ?: stats.byDay.keys.minOrNull() ?: stats.today
    fun x(day: LocalDate) = ChronoUnit.DAYS.between(start, day).toFloat()

    val result = mutableListOf(PacePoint(0f, 0f))
    var cumulative = 0f
    stats.byDay.keys
        .filter { !it.isBefore(start) && !it.isAfter(stats.today) }
        .sorted()
        .forEach { day ->
            val dayBefore = day.minusDays(1)
            if (!dayBefore.isBefore(start)) result += PacePoint(x(dayBefore), cumulative)
            cumulative += stats.byDay[day]?.total?.toFloat() ?: 0f
            result += PacePoint(x(day), cumulative)
        }
    result += PacePoint(x(stats.today), cumulative)
    return result
}

/**
 * Pace — cumulative logged amount against the straight-line path to target.
 *
 * Handles all three timeframes off the goal's own start and end; there is no hard-coded
 * 365 anywhere. Hand-drawn on a `Canvas` because there is no charting library in the
 * catalog and none is being added — and a cumulative staircase plus one dashed pace line
 * is less code than configuring one would be.
 */
@Composable
fun PaceChartView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    val stats = chart.stats
    val target = (stats.target ?: 0).toFloat()
    val points = remember(chart) { pacePoints(stats) }
    val summary = remember(chart) { paceSummary(stats, chart.unit) }

    val start = stats.rangeStart ?: stats.byDay.keys.minOrNull() ?: stats.today
    // Domain end: the goal's deadline, else the projected finish, else a fortnight out —
    // derived, never assumed.
    val domainEnd = stats.rangeEnd
        ?: stats.projectedFinish?.takeIf { it.isAfter(stats.today) }
        ?: stats.today.plusDays(14)
    // Always stretch the domain to at least today: an overdue or just-finished goal has a
    // rangeEnd in the past, and without this its today rule, today dot and the tail of the
    // staircase would all be plotted off the right edge of the canvas.
    val domainDays = maxOf(
        1f,
        ChronoUnit.DAYS.between(start, maxOf(domainEnd, stats.today)).toFloat(),
    )
    val todayX = ChronoUnit.DAYS.between(start, stats.today).toFloat()
    // The pace line still ends at the deadline, even when the domain now runs past it.
    val paceEndX = ChronoUnit.DAYS.between(start, domainEnd).toFloat()
    val total = points.lastOrNull()?.y ?: 0f
    val yUpper = if (maxOf(target, total) > 0f) maxOf(target, total) * 1.05f else 1f

    val line = WF.colors.success
    val ink3 = WF.colors.ink3
    val primary = WF.colors.primary

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = "Path to ${stats.target ?: 0}",
            subtitle = "cumulative ${chart.unit.ifBlank { "progress" }} vs. the pace you need",
            trailing = {
                stats.pace?.let { pace ->
                    val ahead = pace.delta >= 0
                    Text(
                        text = "${if (ahead) "+" else ""}${pace.delta} ${chart.unit} vs pace".trim(),
                        modifier = Modifier
                            .background(
                                if (ahead) WF.colors.successT else WF.colors.dangerT,
                                RoundedCornerShape(WF.radius.pill),
                            )
                            .padding(horizontal = 11.dp, vertical = 5.dp),
                        style = WF.type.size(12.sp, FontWeight.Black),
                        color = if (ahead) WF.colors.success else WF.colors.danger,
                    )
                }
                headerRight?.invoke(this)
            },
        )

        Canvas(
            Modifier
                .fillMaxWidth()
                .height(220.dp)
                .semantics { contentDescription = summary },
        ) {
            fun px(x: Float) = (x / domainDays) * size.width
            fun py(y: Float) = size.height - (y / yUpper) * size.height

            // The cumulative staircase, plus the area beneath it.
            val stroke = Path()
            points.forEachIndexed { i, p ->
                if (i == 0) stroke.moveTo(px(p.x), py(p.y)) else stroke.lineTo(px(p.x), py(p.y))
            }
            val area = Path().apply {
                addPath(stroke)
                lineTo(px(points.last().x), size.height)
                lineTo(px(points.first().x), size.height)
                close()
            }
            drawPath(
                path = area,
                brush = Brush.verticalGradient(
                    listOf(line.copy(alpha = 0.28f), line.copy(alpha = 0f)),
                ),
            )
            drawPath(
                path = stroke,
                color = line,
                style = Stroke(width = 3.dp.toPx(), join = StrokeJoin.Round, cap = StrokeCap.Round),
            )

            val dash = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 5.dp.toPx()))
            if (stats.pace != null) {
                // The pace line: zero at the start, target at the deadline.
                drawLine(
                    color = ink3,
                    start = Offset(px(0f), py(0f)),
                    end = Offset(px(paceEndX), py(target)),
                    strokeWidth = 2.dp.toPx(),
                    pathEffect = dash,
                )
            } else if (target > 0f) {
                drawLine(
                    color = ink3,
                    start = Offset(0f, py(target)),
                    end = Offset(size.width, py(target)),
                    strokeWidth = 2.dp.toPx(),
                    pathEffect = dash,
                )
            }

            // Today.
            drawLine(
                color = primary.copy(alpha = 0.6f),
                start = Offset(px(todayX), 0f),
                end = Offset(px(todayX), size.height),
                strokeWidth = 1.5.dp.toPx(),
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())),
            )
            drawCircle(color = line, radius = 5.dp.toPx(), center = Offset(px(todayX), py(total)))
        }

        Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.xs)) {
            LegendDot(line, "Logged so far")
            LegendDot(
                ink3,
                stats.pace?.let { "Pace to hit ${stats.target} by ${monthDay(it.endLabel)}" }
                    ?: "Target · ${amount((stats.target ?: 0).toDouble(), chart.unit)}",
            )
            stats.projectedFinish?.let {
                Text(
                    text = (if (stats.pace != null) "Projected finish · " else "On track to finish ~ ") +
                        monthDay(it),
                    style = WF.type.size(12.sp, FontWeight.SemiBold),
                    color = WF.colors.ink2,
                )
            } ?: run {
                if (stats.pace == null && stats.target != null) {
                    Text(
                        text = "Keep going — ${amount(maxOf(0.0, stats.target - stats.total), chart.unit)} to go",
                        style = WF.type.size(12.sp, FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                }
            }
        }
    }
}

@Composable
private fun LegendDot(color: Color, text: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(11.dp).background(color, RoundedCornerShape(4.dp)))
        Text(text, style = WF.type.size(12.sp, FontWeight.Bold), color = WF.colors.ink2)
    }
}
