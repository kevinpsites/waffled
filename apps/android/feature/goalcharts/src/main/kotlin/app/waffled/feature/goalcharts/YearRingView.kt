package app.waffled.feature.goalcharts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import kotlin.math.cos
import kotlin.math.sin

private val RING_SIZE = 260.dp

/**
 * Year ring — radial polar bars. A glanceable, decorative "year so far": each wedge is a
 * month, and a longer filled arc means more logged that month.
 *
 * The most ornamental of the eight and genuinely a `Canvas` — twelve annular sectors have
 * no layout equivalent, and the geometry behind them ([ringSector], [ringFillRadius],
 * [ringMonthAt]) is factored out into pure functions so it can be tested on the JVM.
 */
@Composable
fun YearRingView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    onMonthTap: (year: Int, month: Int) -> Unit = { _, _ -> },
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    val currentMonth = chart.today.monthValue - 1
    val max = remember(chart) {
        maxOf(1, chart.stats.byMonth.take(currentMonth + 1).maxOrNull() ?: 1)
    }
    val total = chart.stats.total
    val target = chart.stats.target ?: 0
    val summary = remember(chart) { yearRingSummary(chart.stats, chart.unit) }

    val hair = WF.colors.hair
    val panel = WF.colors.panel
    val base = WF.colors.panel
    val peak = WF.colors.success
    val measurer = rememberTextMeasurer()
    val monthLabelInk = WF.colors.ink2
    val futureLabelInk = WF.colors.ink3
    val centreBig = TextStyle(
        fontSize = 28.sp,
        fontWeight = FontWeight.SemiBold,
        fontFamily = FontFamily.Serif,
        color = WF.colors.ink,
        textAlign = TextAlign.Center,
    )
    val centreSmall = TextStyle(
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        color = WF.colors.ink3,
        textAlign = TextAlign.Center,
    )

    // The twelve month labels are measured ONCE, not inside the draw scope. Resolving a
    // month name is a CLDR lookup and building a fresh TextStyle per frame also defeats
    // the measurer's own cache — exactly the kind of per-frame work the port plan warns
    // about, just in the draw path rather than in a sort comparator.
    val monthLabels = remember(measurer, currentMonth, monthLabelInk, futureLabelInk) {
        (0..11).map { m ->
            measurer.measure(
                shortMonthName(m),
                TextStyle(
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Black,
                    color = if (m > currentMonth) futureLabelInk else monthLabelInk,
                ),
            )
        }
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = "The year in a ring",
            subtitle = "each wedge is a month — longer = more ${chart.unit.ifBlank { "logged" }}",
            trailing = headerRight,
        )

        Canvas(
            Modifier
                .size(RING_SIZE)
                .align(Alignment.CenterHorizontally)
                .semantics { contentDescription = summary }
                .pointerInput(currentMonth) {
                    detectTapGestures { offset ->
                        val month = ringMonthAt(
                            offset.x - size.width / 2f,
                            offset.y - size.height / 2f,
                        )
                        if (month <= currentMonth) onMonthTap(chart.today.year, month)
                    }
                },
        ) {
            val centre = Offset(size.width / 2f, size.height / 2f)
            // The pure geometry is expressed in the same 260/56/116 point space iOS uses;
            // scale it to whatever this device actually gave us.
            val scale = size.minDimension / RING_SIZE.toPx()
            val r0 = RING_INNER_RADIUS.dp.toPx() * scale
            val r1 = RING_OUTER_RADIUS.dp.toPx() * scale

            for (m in 0..11) {
                val sector = ringSector(m)
                drawPath(
                    path = sectorPath(centre, r0, r1, sector),
                    color = hair,
                    style = Stroke(width = 1f),
                )
                val monthTotal = chart.stats.byMonth[m]
                if (m <= currentMonth && monthTotal > 0) {
                    val rr = ringFillRadius(monthTotal, max, r0, r1)
                    val t = 0.35f + 0.6f * heatIntensity(monthTotal, max)
                    drawPath(
                        path = sectorPath(centre, r0, rr, sector),
                        color = heatColor(t, base, peak),
                    )
                }

                // The month's name, just outside the ring — measured above, not here.
                val mid = Math.toRadians((sector.startAngle + sector.sweepAngle / 2f).toDouble())
                val label = monthLabels[m]
                val lr = r1 + 13.dp.toPx() * scale
                drawText(
                    textLayoutResult = label,
                    topLeft = Offset(
                        centre.x + (lr * cos(mid)).toFloat() - label.size.width / 2f,
                        centre.y + (lr * sin(mid)).toFloat() - label.size.height / 2f,
                    ),
                )
            }

            // The hub, and the running total inside it.
            val hub = r0 - 4f * scale
            drawCircle(color = panel, radius = hub, center = centre)
            val big = measurer.measure(total.toString(), centreBig)
            drawText(
                textLayoutResult = big,
                topLeft = Offset(centre.x - big.size.width / 2f, centre.y - big.size.height - 2f),
            )
            val small = measurer.measure(
                if (target > 0) "of ${amount(target, chart.unit)}" else chart.unit,
                centreSmall,
            )
            drawText(
                textLayoutResult = small,
                topLeft = Offset(centre.x - small.size.width / 2f, centre.y + 4f),
            )
        }

        // The same twelve numbers as a list, because a ring is decorative and a list is
        // readable — and because the ring alone would leave the exact figures unavailable.
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            (0..currentMonth).forEach { m ->
                val value = chart.stats.byMonth[m]
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    androidx.compose.material3.Text(
                        shortMonthName(m),
                        modifier = Modifier.width(30.dp),
                        style = WF.type.size(11.5.sp, FontWeight.Black),
                        color = WF.colors.ink3,
                    )
                    MiniBar(
                        fraction = heatIntensity(value, max),
                        color = heatColor(0.4f + 0.55f * heatIntensity(value, max), base, peak),
                        modifier = Modifier.weight(1f).height(8.dp),
                    )
                    androidx.compose.material3.Text(
                        value.toString(),
                        modifier = Modifier.width(36.dp),
                        style = WF.type.serif(12.5.sp),
                        color = WF.colors.ink,
                    )
                }
            }
            if (target > 0) {
                androidx.compose.material3.Text(
                    "${amount(maxOf(0, target - total), chart.unit)} to go",
                    style = WF.type.size(11.5.sp, FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
    }
}

/**
 * One annular sector: an arc out at [r1], a line in, an arc back at [r0], closed.
 *
 * Compose has no annulus primitive, so this is hand-built — but every angle in it comes
 * from [ringSector], which is tested.
 */
private fun DrawScope.sectorPath(centre: Offset, r0: Float, r1: Float, sector: RingSector): Path {
    val path = Path()
    path.addArc(
        oval = androidx.compose.ui.geometry.Rect(
            offset = Offset(centre.x - r1, centre.y - r1),
            size = Size(r1 * 2, r1 * 2),
        ),
        startAngleDegrees = sector.startAngle,
        sweepAngleDegrees = sector.sweepAngle,
    )
    val endRad = Math.toRadians((sector.startAngle + sector.sweepAngle).toDouble())
    path.lineTo(
        centre.x + (r0 * cos(endRad)).toFloat(),
        centre.y + (r0 * sin(endRad)).toFloat(),
    )
    path.arcTo(
        rect = androidx.compose.ui.geometry.Rect(
            offset = Offset(centre.x - r0, centre.y - r0),
            size = Size(r0 * 2, r0 * 2),
        ),
        startAngleDegrees = sector.startAngle + sector.sweepAngle,
        sweepAngleDegrees = -sector.sweepAngle,
        forceMoveTo = false,
    )
    path.close()
    return path
}
