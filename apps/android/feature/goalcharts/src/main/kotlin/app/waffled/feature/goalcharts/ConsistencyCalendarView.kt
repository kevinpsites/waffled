package app.waffled.feature.goalcharts

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.waffled.core.design.WF
import java.time.LocalDate
import java.time.YearMonth

/**
 * Consistency — the habit signature view. Did you show up? A month of hit/miss dots plus
 * the streak figures. (The week strip is the compact seven-dot variant of the same idea,
 * offered alongside this one.)
 */
@Composable
fun ConsistencyCalendarView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    onDayTap: (LocalDate) -> Unit = {},
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    val month = remember(chart) { YearMonth.from(chart.today) }
    val grid = remember(chart, month) { monthGrid(chart.stats, month) }
    val rows = remember(grid) { (List(grid.lead) { null } + grid.cells).chunked(7) }
    val hits = grid.cells.count { it.logged }
    val elapsed = grid.cells.count { !it.future }
    val summary = remember(chart, month) { consistencySummary(chart.stats, month) }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = monthName(month.monthValue - 1),
            subtitle = chart.title.ifBlank { "did you show up?" },
            trailing = headerRight,
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = summary },
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            rows.forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    row.forEach { cell ->
                        if (cell == null) {
                            Spacer(Modifier.weight(1f))
                        } else {
                            ConsistencyDot(cell, Modifier.weight(1f), onDayTap)
                        }
                    }
                    repeat(7 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            StatColumn("🔥 ${chart.stats.currentStreak}", "current", WF.colors.primary)
            StatColumn("${chart.stats.longestStreak}", "longest")
            StatColumn("${percentOf(hits, elapsed)}%", "this month")
        }
    }
}

@Composable
private fun ConsistencyDot(cell: DayCell, modifier: Modifier, onDayTap: (LocalDate) -> Unit) {
    val hair = WF.colors.hair
    Box(
        modifier
            .aspectRatio(1f)
            .clickable(enabled = !cell.future) { onDayTap(cell.day) },
    ) {
        when (cell.paint) {
            // Showed up.
            DayPaint.Heat -> Box(Modifier.fillMaxSize().background(WF.colors.success, CircleShape))
            // Logged an explicit zero — a visible miss, not an absence.
            DayPaint.Empty -> Box(Modifier.fillMaxSize().background(WF.colors.panel, CircleShape))
            // Not tracked at all: the slot holds the grid's shape and stays unpainted.
            DayPaint.Blank -> Unit
            // Still to come.
            DayPaint.Future -> Box(
                Modifier.fillMaxSize().drawBehind {
                    val d = minOf(size.width, size.height)
                    drawArc(
                        color = hair,
                        startAngle = 0f,
                        sweepAngle = 360f,
                        useCenter = false,
                        size = Size(d, d),
                        style = Stroke(
                            width = 1.dp.toPx(),
                            pathEffect = PathEffect.dashPathEffect(
                                floatArrayOf(3.dp.toPx(), 3.dp.toPx()),
                            ),
                        ),
                    )
                },
            )
        }
    }
}
