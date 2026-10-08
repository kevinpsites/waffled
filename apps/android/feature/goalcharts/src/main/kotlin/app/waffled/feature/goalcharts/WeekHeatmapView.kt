package app.waffled.feature.goalcharts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

private val WEEKDAY_DAY: DateTimeFormatter =
    DateTimeFormatter.ofPattern("EEE d", Locale.getDefault())

/**
 * Week — the heatmap strip. Only what was done is drawn; rest days sit light and quiet,
 * never "an empty bar = failure". Pages back and forth, clamped at the current week.
 *
 * Anchored to the fixed household calendar week containing today, NOT a rolling 7-day
 * window — the same choice iOS makes.
 */
@Composable
fun WeekHeatmapView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    onDayTap: (LocalDate) -> Unit = {},
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    var weekOffset by rememberSaveable(chart.today) { mutableIntStateOf(0) }
    val weekStart = remember(chart, weekOffset) {
        startOfWeek(chart.today.plusDays(weekOffset * 7L), chart.firstDay)
    }
    // The whole week is resolved once per page, outside the draw scope.
    val cells = remember(chart, weekStart) { weekCells(chart.stats, weekStart) }
    val previous = remember(chart, weekStart) {
        weekCells(chart.stats, weekStart.minusDays(7)).sumOf { it.value }
    }
    val max = remember(cells) { scaleMax(cells) }
    val total = cells.sumOf { it.value }
    val delta = total - previous
    val canGoForward = weekOffset < 0
    val summary = remember(chart, weekStart) { weekSummary(chart.stats, weekStart, chart.unit) }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = if (weekOffset == 0) {
                "This week"
            } else {
                "Week of ${monthDay(weekStart)} – ${monthDay(weekStart.plusDays(6))}"
            },
            subtitle = if (weekOffset == 0) {
                "${monthDay(weekStart)} – ${monthDay(weekStart.plusDays(6))} · the rhythm of your week"
            } else {
                "the rhythm of your week"
            },
            leading = {
                IconButton(onClick = { weekOffset -= 1 }) {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                        contentDescription = "Previous week",
                        tint = WF.colors.ink2,
                    )
                }
            },
            trailing = {
                IconButton(
                    onClick = { weekOffset = minOf(0, weekOffset + 1) },
                    enabled = canGoForward,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = "Next week",
                        tint = if (canGoForward) WF.colors.ink2 else WF.colors.ink3.copy(alpha = 0.4f),
                    )
                }
                headerRight?.invoke(this)
            },
        )

        // A plain Row of weighted, square cells rather than a LazyVGrid: these cards live
        // inside the goal detail screen's vertical scroll, and a lazy grid on the same
        // axis inside a scrollable parent is unmeasurable. `weight` + `aspectRatio` squares
        // a cell reliably here — the SwiftUI measurement dance the iOS view needs has no
        // Compose equivalent.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = summary },
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
        ) {
            cells.forEach { cell ->
                val intensity = heatIntensity(cell.value, max)
                val dark = isHeatDark(intensity)
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(enabled = !cell.future) { onDayTap(cell.day) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.xs),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(1f)
                            .heatCellBackground(cell, intensity, 13.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Text(
                                text = if (cell.logged) amountText(cell.value) else "·",
                                style = WF.type.serif(15.sp),
                                color = when {
                                    dark -> androidx.compose.ui.graphics.Color.White
                                    cell.logged -> WF.colors.ink
                                    else -> WF.colors.ink3
                                },
                            )
                            PersonDots(chart, cell.personIds, dark, dotSize = 5.dp)
                        }
                    }
                    Text(
                        text = WEEKDAY_DAY.format(cell.day),
                        style = WF.type.size(11.sp, FontWeight.Black),
                        color = if (cell.day == chart.today) WF.colors.primary else WF.colors.ink3,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxs)) {
            Text(total.toString(), style = WF.type.serif(15.sp), color = WF.colors.ink)
            Text(
                text = if (chart.unit.isBlank()) "this week" else "${chart.unit} this week",
                style = WF.type.size(12.sp, FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
            if (previous > 0 || total > 0) {
                Text(
                    text = "· ${if (delta >= 0) "+" else ""}$delta vs last",
                    style = WF.type.size(12.sp, FontWeight.SemiBold),
                    color = if (delta >= 0) WF.colors.success else WF.colors.danger,
                )
            }
        }
    }
}
