package app.waffled.feature.goalcharts

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF

private val CHART_HEIGHT = 190.dp

/**
 * By person — stacked columns by month. Who is driving the family total.
 *
 * The bars are laid out rather than drawn: a stack of proportionally-sized boxes IS a
 * stacked column, and layout gives free hit-testing per column, which a `Canvas` would
 * make me re-derive. The drawing-heavy views in this module (year grid, year ring, pace)
 * are the ones a `Canvas` genuinely earns.
 */
@Composable
fun ByPersonBarsView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    onMonthTap: (year: Int, month: Int) -> Unit = { _, _ -> },
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    val currentMonth = chart.today.monthValue - 1
    val months = remember(chart) { (0..currentMonth).toList() }
    val max = remember(chart) {
        maxOf(1, chart.stats.byMonth.take(currentMonth + 1).maxOrNull() ?: 1)
    }
    val summary = remember(chart) {
        byPersonSummary(chart.stats, chart.personNames, chart.unit)
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = "By month · by person",
            subtitle = "who is driving the family total",
            trailing = headerRight,
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(CHART_HEIGHT)
                .semantics { contentDescription = summary },
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
            verticalAlignment = Alignment.Bottom,
        ) {
            months.forEach { m ->
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable { onMonthTap(chart.today.year, m) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.xxs),
                ) {
                    StackedColumn(chart, m, max)
                    Text(
                        shortMonthName(m),
                        style = WF.type.size(9.5.sp, FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
        }

        PersonTotalChips(chart)
    }
}

@Composable
private fun StackedColumn(chart: GoalChart, month: Int, max: Int) {
    // 22dp of the 190 is the month label + spacing, so the tallest bar tops out at 160.
    val trackHeight = 160.dp
    val perPerson = chart.stats.byMonthPerPerson[month]
    Box(
        modifier = Modifier.height(trackHeight).fillMaxWidth(),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Bottom,
        ) {
            // Segments stack bottom-up in the same stable person order the dots use, so a
            // month's colours never reshuffle between frames.
            chart.stats.personOrder.reversed().forEach { personId ->
                val amount = perPerson[personId] ?: 0
                if (amount <= 0) return@forEach
                Box(
                    Modifier
                        .width(20.dp)
                        .height(trackHeight * (amount.toFloat() / max))
                        .background(chart.colorOf(personId), RoundedCornerShape(3.dp)),
                )
            }
            // A month logged without any person attached still has to show up.
            val unattributed = chart.stats.byMonth[month] - perPerson.values.sum()
            if (unattributed > 0) {
                Box(
                    Modifier
                        .width(20.dp)
                        .height(trackHeight * (unattributed.toFloat() / max))
                        .background(WF.colors.ink3, RoundedCornerShape(3.dp)),
                )
            }
        }
    }
}

/** A wrapped row of `dot · Name · total unit` chips. */
@Composable
private fun PersonTotalChips(chart: GoalChart) {
    if (chart.stats.personOrder.isEmpty()) return
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = ((maxWidth / 118.dp).toInt()).coerceAtLeast(1)
        Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.sm)) {
            chart.stats.personOrder.chunked(columns).forEach { row ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                ) {
                    row.forEach { personId ->
                        Row(
                            modifier = Modifier
                                .weight(1f)
                                .background(WF.colors.panel, RoundedCornerShape(WF.radius.sm))
                                .padding(horizontal = WF.spacing.lg, vertical = 9.dp),
                            horizontalArrangement = Arrangement.spacedBy(9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier
                                    .size(12.dp)
                                    .background(chart.colorOf(personId), CircleShape),
                            )
                            Column {
                                Text(
                                    chart.name(personId),
                                    style = WF.type.size(12.sp, FontWeight.Bold),
                                    color = WF.colors.ink2,
                                )
                                Text(
                                    amount(chart.stats.byPerson[personId] ?: 0, chart.unit),
                                    style = WF.type.serif(15.sp),
                                    color = WF.colors.ink,
                                )
                            }
                        }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}
