package app.waffled.feature.goalcharts

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import java.time.LocalDate
import java.time.YearMonth

private val WEEKDAY_HEADS = listOf("S", "M", "T", "W", "T", "F", "S")

/**
 * Month — the calendar heatmap. A familiar month grid where shade is how much was logged
 * that day. Pages back and forth, clamped so you can't walk past the current month.
 */
@Composable
fun MonthHeatmapView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    onDayTap: (LocalDate) -> Unit = {},
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    var monthOffset by rememberSaveable(chart.today) { mutableIntStateOf(0) }
    val month = remember(chart, monthOffset) {
        YearMonth.from(chart.today).plusMonths(monthOffset.toLong())
    }
    // The month's cells and its scale are derived once per page — never per frame.
    val grid = remember(chart, month) { monthGrid(chart.stats, month) }
    val max = remember(grid) { scaleMax(grid.cells) }
    val total = grid.cells.filter { !it.future }.sumOf { it.value }
    val best = remember(grid) { grid.cells.filter { it.logged }.maxByOrNull { it.value } }
    val canGoForward = monthOffset < 0
    val summary = remember(chart, month) { monthSummary(chart.stats, month, chart.unit) }

    // Leading blanks + the days, chunked into calendar rows once.
    val rows = remember(grid) {
        (List(grid.lead) { null } + grid.cells).chunked(7)
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = if (month.year == chart.today.year) {
                monthName(month.monthValue - 1)
            } else {
                "${monthName(month.monthValue - 1)} ${month.year}"
            },
            subtitle = "${amount(total, chart.unit)} this month",
            leading = {
                IconButton(onClick = { monthOffset -= 1 }) {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                        contentDescription = "Previous month",
                        tint = WF.colors.ink2,
                    )
                }
            },
            trailing = {
                IconButton(
                    onClick = { monthOffset = minOf(0, monthOffset + 1) },
                    enabled = canGoForward,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = "Next month",
                        tint = if (canGoForward) WF.colors.ink2 else WF.colors.ink3.copy(alpha = 0.4f),
                    )
                }
                headerRight?.invoke(this)
            },
        )

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
        ) {
            WEEKDAY_HEADS.forEach { head ->
                Text(
                    text = head,
                    modifier = Modifier.weight(1f),
                    style = WF.type.size(11.sp, FontWeight.Black),
                    color = WF.colors.ink3,
                    textAlign = TextAlign.Center,
                )
            }
        }

        // A Column of Rows rather than a LazyVGrid: a month is six rows, so laziness buys
        // nothing, and a lazy grid nested in the detail screen's vertical scroll cannot be
        // measured. Weighted cells + aspectRatio keep every square square.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = summary },
            verticalArrangement = Arrangement.spacedBy(WF.spacing.xs),
        ) {
            rows.forEach { row ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
                ) {
                    row.forEach { cell ->
                        if (cell == null) {
                            Spacer(Modifier.weight(1f))
                        } else {
                            MonthDayCell(chart, cell, max, Modifier.weight(1f), onDayTap)
                        }
                    }
                    // Pad the final row so its cells stay the same width as every other.
                    repeat(7 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeatLegend()
            if (best != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxs)) {
                    Text(
                        "Best day ·",
                        style = WF.type.size(12.sp, FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                    Text(
                        amount(best.value, chart.unit),
                        style = WF.type.serif(12.sp),
                        color = WF.colors.ink,
                    )
                }
            }
        }
    }
}

@Composable
private fun MonthDayCell(
    chart: GoalChart,
    cell: DayCell,
    max: Double,
    modifier: Modifier,
    onDayTap: (LocalDate) -> Unit,
) {
    val intensity = heatIntensity(cell.value, max)
    val dark = isHeatDark(intensity)
    val isToday = cell.day == chart.today
    Column(
        modifier = modifier
            .aspectRatio(1f)
            .heatCellBackground(cell, intensity, 10.dp)
            .clickable(enabled = !cell.future) { onDayTap(cell.day) }
            .padding(5.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // Today gets a ring around its number so you can find yourself in the month.
        Box(
            modifier = if (isToday) {
                Modifier.size(16.dp).border(1.5.dp, WF.colors.danger, CircleShape)
            } else {
                Modifier
            },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = cell.day.dayOfMonth.toString(),
                style = WF.type.size(11.5.sp, FontWeight.Black),
                color = when {
                    isToday -> WF.colors.danger
                    cell.future -> WF.colors.ink3
                    dark -> Color.White
                    else -> WF.colors.ink2
                },
            )
        }
        if (cell.logged) {
            Text(
                // amountText, not toString: a raw Double renders "1.0833333" in a cell
                // barely wider than the number itself.
                text = amountText(cell.value),
                style = WF.type.serif(12.sp),
                color = if (dark) Color.White else WF.colors.ink,
            )
        }
        Spacer(Modifier.weight(1f))
        PersonDots(chart, cell.personIds, dark)
    }
}
