package app.waffled.feature.goalcharts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import kotlin.math.floor

/**
 * Collection — the count signature view. Progress reads as "the shelf fills up", not as a
 * percentage bar: [GoalChart]'s target is a row of slots and the first `done` are filled.
 */
@Composable
fun CollectionGridView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    // The one place the widened total is deliberately narrowed again. A shelf slot is a
    // discrete thing you either collected or did not, so a fractional total TRUNCATES:
    // 4.8 books fills four slots, not five. Same rule as `progressPercent` — not quite
    // there is not there — and now an explicit decision rather than a silent `roundToInt`
    // upstream, which used to round 4.6 UP into a slot nobody had earned.
    val done = floor(chart.stats.total).toInt()
    val slots = collectionSlots(chart.stats.target, done)
    val base = WF.colors.panel
    val peak = WF.colors.success
    val hair = WF.colors.hair
    val summary = remember(done, slots, chart.unit) {
        collectionSummary(done, chart.stats.target, chart.unit)
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = chart.title.ifBlank { "The collection" },
            subtitle = null,
            trailing = headerRight,
        )

        // Adaptive columns, sized from the actual card width — the Compose answer to
        // iOS's `GridItem(.adaptive(minimum: 30))`. A lazy grid is not an option here:
        // this card sits inside the detail screen's vertical scroll.
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .semantics { contentDescription = summary },
        ) {
            val columns = ((maxWidth / 34.dp).toInt()).coerceAtLeast(1)
            Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.xxs)) {
                (0 until slots).chunked(columns).forEach { row ->
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxs),
                    ) {
                        row.forEach { index ->
                            val filled = index < done
                            // The shelf is deliberately not one flat colour: each filled
                            // slot samples the ramp at a repeating offset so it reads as a
                            // shelf of distinct things rather than one long bar. Ported
                            // from the iOS `0.42 + 0.5 * ((i * 3) % 5) / 5` walk.
                            val t = 0.42f + 0.5f * ((index * 3) % 5) / 5f
                            Box(
                                Modifier
                                    .weight(1f)
                                    .height(46.dp)
                                    .then(
                                        if (filled) {
                                            Modifier.background(
                                                heatColor(t, base, peak),
                                                RoundedCornerShape(4.dp),
                                            )
                                        } else {
                                            Modifier.drawBehind {
                                                drawRoundRect(
                                                    color = hair,
                                                    cornerRadius = CornerRadius(4.dp.toPx()),
                                                    style = Stroke(
                                                        width = 1.dp.toPx(),
                                                        pathEffect = PathEffect.dashPathEffect(
                                                            floatArrayOf(3.dp.toPx(), 3.dp.toPx()),
                                                        ),
                                                    ),
                                                )
                                            }
                                        },
                                    ),
                            )
                        }
                        repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }

        Row(
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxs),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text("$done", style = WF.type.serif(15.sp), color = WF.colors.ink)
            Text(
                "of $slots",
                style = WF.type.size(12.sp, FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
            chart.stats.projectedFinish?.let {
                Text(
                    "· on pace for ${monthName(it.monthValue - 1)}",
                    style = WF.type.size(12.sp, FontWeight.SemiBold),
                    color = WF.colors.success,
                )
            }
        }

        SectionLabel("${chart.unit.ifBlank { "items" }} per month")
        MonthlyBars(chart)
    }
}

/** The little "how many a month" strip under the shelf. */
@Composable
private fun MonthlyBars(chart: GoalChart) {
    val currentMonth = chart.today.monthValue - 1
    val max = remember(chart) {
        scaleDenominator(chart.stats.byMonth.take(currentMonth + 1).maxOrNull())
    }
    Row(
        modifier = Modifier.height(48.dp),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
        verticalAlignment = Alignment.Bottom,
    ) {
        (0..currentMonth).forEach { m ->
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(WF.spacing.xxs),
            ) {
                Box(
                    Modifier
                        .width(18.dp)
                        .height((2f + 38f * (chart.stats.byMonth[m] / max).toFloat()).dp)
                        .background(WF.colors.success, RoundedCornerShape(3.dp)),
                )
                Text(
                    monthName(m).take(1),
                    style = WF.type.size(9.5.sp, FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
    }
}
