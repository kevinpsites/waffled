package app.waffled.feature.goalcharts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import java.time.LocalDate

private val CELL = 13.dp
private val GAP = 3.5.dp
private val LABEL_ROW = 16.dp

/**
 * Year — the contribution grid. Consistency at a glance for the whole calendar year so
 * far: every day from Jan 1 to today gets a square, including the ones before a mid-year
 * goal existed, which simply sit unpainted.
 *
 * Genuinely a `Canvas`: a few hundred rounded rectangles as composables would be a few
 * hundred layout nodes for something with no per-cell interaction beyond a tap, and the
 * tap resolves from coordinates arithmetically.
 */
@Composable
fun YearGridView(
    chart: GoalChart,
    modifier: Modifier = Modifier,
    onDayTap: (LocalDate) -> Unit = {},
    headerRight: @Composable (RowScope.() -> Unit)? = null,
) {
    // Built once per series change: every LocalDate this view needs already exists before
    // the draw scope runs, which is the whole point.
    val columns = remember(chart) { yearColumns(chart.stats, chart.today) }
    val max = remember(chart) { scaleDenominator(chart.stats.yearMax) }
    val jan1 = remember(chart) { LocalDate.of(chart.today.year, 1, 1) }
    // The goal's own start scopes only the "% of days" denominator, not what is drawn.
    val viewStart = remember(chart) {
        chart.stats.rangeStart?.takeIf { it.isAfter(jan1) } ?: jan1
    }
    val painted = remember(columns) { columns.flatten().filter { it.paint != DayPaint.Blank } }
    val activeCount = remember(painted, viewStart) {
        painted.count { it.logged && !it.day.isBefore(viewStart) }
    }
    val daySpan = remember(chart, viewStart) {
        maxOf(1, (java.time.temporal.ChronoUnit.DAYS.between(viewStart, chart.today) + 1).toInt())
    }
    val summary = remember(chart) { yearSummary(chart.stats) }

    // Month labels, resolved outside the draw scope: the column index of each month's
    // first week, paired with its name.
    val monthLabels = remember(columns) {
        val seen = mutableSetOf<Int>()
        columns.mapIndexedNotNull { index, column ->
            val first = column.first().day
            if (first.dayOfMonth <= 7 && seen.add(first.monthValue)) {
                index to shortMonthName(first.monthValue - 1)
            } else {
                null
            }
        }
    }

    val measurer = rememberTextMeasurer()
    val scroll = rememberScrollState()
    val base = WF.colors.panel
    val peak = WF.colors.success
    val hair = WF.colors.hair
    val labelStyle = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Bold, color = WF.colors.ink3)

    // Cells before the goal's own start are unpainted by design, so a goal that didn't
    // begin on Jan 1 would open on a blank leading stretch unless we jump to the
    // most-recent edge.
    LaunchedEffect(scroll.maxValue) { scroll.scrollTo(scroll.maxValue) }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        ChartHeader(
            title = "The whole year",
            subtitle = "$activeCount active days · every square is a day",
            trailing = headerRight,
        )

        Row(Modifier.fillMaxWidth().horizontalScroll(scroll)) {
            Canvas(
                Modifier
                    .width(CELL * columns.size + GAP * columns.size)
                    .height(LABEL_ROW + (CELL + GAP) * 7)
                    .semantics { contentDescription = summary }
                    .pointerInput(columns) {
                        detectTapGestures { offset ->
                            val step = (CELL + GAP).toPx()
                            val c = (offset.x / step).toInt()
                            val r = ((offset.y - LABEL_ROW.toPx()) / step).toInt()
                            if (c in columns.indices && r in 0..6) {
                                val cell = columns[c][r]
                                if (cell.paint != DayPaint.Blank && !cell.future) onDayTap(cell.day)
                            }
                        }
                    },
            ) {
                val step = (CELL + GAP).toPx()
                val cell = CELL.toPx()
                val labelRow = LABEL_ROW.toPx()

                monthLabels.forEach { (index, name) ->
                    val laid = measurer.measure(name, labelStyle)
                    drawText(laid, topLeft = Offset(index * step, 0f))
                }

                columns.forEachIndexed { c, column ->
                    column.forEachIndexed { r, day ->
                        val topLeft = Offset(c * step, labelRow + r * step)
                        val radius = CornerRadius(3.dp.toPx())
                        when (day.paint) {
                            DayPaint.Heat -> drawRoundRect(
                                color = heatColor(heatIntensity(day.value, max), base, peak),
                                topLeft = topLeft,
                                size = Size(cell, cell),
                                cornerRadius = radius,
                            )
                            // Logged nothing: a visible quiet square.
                            DayPaint.Empty -> drawRoundRect(
                                color = base,
                                topLeft = topLeft,
                                size = Size(cell, cell),
                                cornerRadius = radius,
                            )
                            // Not tracked (before the range, or a day with no entry):
                            // nothing is painted, which is what makes the grid legible.
                            DayPaint.Blank -> Unit
                            DayPaint.Future -> drawRoundRect(
                                color = hair,
                                topLeft = topLeft,
                                size = Size(cell, cell),
                                cornerRadius = radius,
                                style = Stroke(width = 1.dp.toPx()),
                            )
                        }
                    }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxl)) {
            StatColumn("🔥 ${chart.stats.currentStreak}", "current streak", WF.colors.primary)
            StatColumn("${chart.stats.longestStreak}", "longest streak")
            StatColumn("$activeCount", "active days")
            StatColumn("${percentOf(activeCount, daySpan)}%", "of days")
        }
    }
}
