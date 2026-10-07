package app.waffled.feature.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.WaffledDates
import java.time.LocalDate
import java.time.ZoneId

private val GutterWidth = 18.dp
private val HeaderHeight = 20.dp
private const val OUT_OF_MONTH_ALPHA = 0.42f
private val SUNDAY_FIRST_INITIALS = listOf("S", "M", "T", "W", "T", "F", "S")

/** What a day cell's content slot has to work with. */
data class MonthCellSpace(
    /** The row's height in dp — feed it to [PhoneCalendar.cellChips]. */
    val rowHeight: Float,
    /** Bar lanes the row reserved under the day number (already left empty above the slot). */
    val reservedLanes: Int,
)

/**
 * The phone month grid — week numbers in a left gutter, a day number per cell, and a content
 * slot under it — with no opinion about what goes in the cells. Twin of iOS `PhoneMonthGrid`'s
 * frame; the Calendar tab fills it with [EventMonthGrid], and Weekly Planning's Horizon scan
 * draws the same grid with its own chips.
 *
 * It splits whatever height its caller gives it across [rows], so the caller fixes the size:
 * `weight(1f)` to fill a screen, or a fixed height per row in a scrolling page.
 *
 * [reservedLanes] and [rowOverlay] let a caller draw things that span cells (multi-day bars):
 * the cells leave that many chip-heights empty under the day number, and the overlay is
 * drawn over the row's seven cells without taking taps.
 */
@Composable
fun PhoneMonthGrid(
    rows: List<PhoneCalendar.MonthRow>,
    weekStart: HouseholdWeekStart,
    today: LocalDate,
    selectedDay: LocalDate?,
    onPick: (LocalDate) -> Unit,
    modifier: Modifier = Modifier,
    reservedLanes: (PhoneCalendar.MonthRow) -> Int = { 0 },
    rowOverlay: @Composable BoxScope.(PhoneCalendar.MonthRow) -> Unit = {},
    dayLabel: (PhoneCalendar.MonthDay) -> String = { it.date.toString() },
    cellContent: @Composable ColumnScope.(PhoneCalendar.MonthDay, MonthCellSpace) -> Unit = { _, _ -> },
) {
    val initials = remember(weekStart) { weekStart.rotated(SUNDAY_FIRST_INITIALS) }
    Column(modifier.padding(horizontal = 8.dp)) {
        Row(Modifier.fillMaxWidth().height(HeaderHeight), verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.width(GutterWidth))
            for (label in initials) {
                Text(
                    text = label,
                    modifier = Modifier.weight(1f),
                    style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.ExtraBold),
                    color = WF.colors.ink3,
                    textAlign = TextAlign.Center,
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair2))
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val rowHeight: Dp = if (rows.isEmpty()) 0.dp else maxHeight / rows.size
            Column(Modifier.fillMaxSize()) {
                for (row in rows) {
                    val lanes = reservedLanes(row)
                    Row(Modifier.fillMaxWidth().height(rowHeight)) {
                        WeekNumber(row.weekNumber)
                        Box(Modifier.weight(1f).fillMaxHeight()) {
                            Row(Modifier.fillMaxSize()) {
                                for (d in row.days) {
                                    DayCell(
                                        day = d,
                                        isToday = d.date == today,
                                        isSelected = d.date == selectedDay && d.date != today,
                                        lanes = lanes,
                                        label = dayLabel(d),
                                        onPick = onPick,
                                        modifier = Modifier.weight(1f),
                                    ) { cellContent(d, MonthCellSpace(rowHeight.value, lanes)) }
                                }
                            }
                            rowOverlay(row)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WeekNumber(number: Int) {
    Box(
        Modifier
            .width(GutterWidth)
            .fillMaxHeight()
            .semantics { contentDescription = "Week $number" },
    ) {
        Text(
            text = "$number",
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 5.dp),
            style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink3.copy(alpha = 0.7f),
        )
        Box(Modifier.align(Alignment.CenterEnd).width(1.dp).fillMaxHeight().background(WF.colors.hair2))
    }
}

@Composable
private fun DayCell(
    day: PhoneCalendar.MonthDay,
    isToday: Boolean,
    isSelected: Boolean,
    lanes: Int,
    label: String,
    onPick: (LocalDate) -> Unit,
    modifier: Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(
        modifier
            .fillMaxHeight()
            // No ripple: the cell is a plain target, like the iOS plain-style button.
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                onPick(day.date)
            }
            .semantics { contentDescription = label },
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(start = 2.dp, end = 2.dp, top = PhoneCalendar.CELL_TOP_PADDING.dp),
            verticalArrangement = Arrangement.spacedBy(PhoneCalendar.CHIP_GAP.dp),
        ) {
            DayNumber(day, isToday, isSelected)
            if (lanes > 0) Spacer(Modifier.height(SpanBarMetrics.reservedHeight(lanes)))
            content()
        }
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(1.dp).background(WF.colors.hair2))
    }
}

@Composable
private fun DayNumber(day: PhoneCalendar.MonthDay, isToday: Boolean, isSelected: Boolean) {
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.fillMaxWidth().height(PhoneCalendar.DAY_NUMBER_HEIGHT.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(width = 22.dp, height = (PhoneCalendar.DAY_NUMBER_HEIGHT - 2).dp)
                .background(if (isToday) WF.colors.primary else Color.Transparent, shape)
                .then(if (isSelected) Modifier.border(1.5.dp, WF.colors.primary, shape) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "${day.day}",
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                // White on the saturated coral fill, which stays coral in both themes.
                color = when {
                    isToday -> Color.White
                    isSelected -> WF.colors.primary
                    day.inMonth -> WF.colors.ink
                    else -> WF.colors.ink3.copy(alpha = 0.6f)
                },
            )
        }
    }
}

/**
 * The Calendar tab's month grid: event chips, one countdown pill, "+N more", and multi-day
 * all-day events as bars across their days. Twin of iOS `PhoneMonthGrid` with its content.
 *
 * Bars are laid out once per data change, never per cell.
 */
@Composable
fun EventMonthGrid(
    rows: List<PhoneCalendar.MonthRow>,
    weekStart: HouseholdWeekStart,
    zone: ZoneId,
    byDay: Map<LocalDate, List<EventRow>>,
    countdownsByDate: Map<String, List<CalendarApi.Countdown>>,
    style: EventStyle,
    today: LocalDate,
    selectedDay: LocalDate?,
    onPick: (LocalDate) -> Unit,
    modifier: Modifier = Modifier,
) {
    val spans = remember(rows, byDay) {
        rows.associate { row -> row.days.first().date to PhoneCalendar.weekSpans(row.days.map { it.date }, byDay) }
    }
    // Every date sits in exactly one row, so the rows' leftover chips merge into one index.
    val chipsByDate = remember(spans) {
        spans.values.flatMap { it.chipsByDay.entries }.associate { (day, rows) -> day to PhoneCalendar.displayOrder(rows) }
    }
    PhoneMonthGrid(
        rows = rows,
        weekStart = weekStart,
        today = today,
        selectedDay = selectedDay,
        onPick = onPick,
        modifier = modifier,
        reservedLanes = { spans[it.days.first().date]?.lanes ?: 0 },
        rowOverlay = { row ->
            spans[row.days.first().date]?.let { MonthSpanBars(it, row.days.map { d -> d.inMonth }, style) }
        },
        dayLabel = { d ->
            val count = byDay[d.date].orEmpty().size + countdownsByDate[d.date.toString()].orEmpty().size
            val date = WaffledDates.format(d.date.atStartOfDay(zone).toInstant(), "EEEE, MMMM d", zone)
            if (count == 0) date else "$date, $count event${if (count == 1) "" else "s"}"
        },
    ) { d, space ->
        val chips = chipsByDate[d.date].orEmpty()
        val countdowns = countdownsByDate[d.date.toString()].orEmpty()
        val budget = PhoneCalendar.cellChips(chips.size, countdowns.size, space.rowHeight, space.reservedLanes)
        Column(
            Modifier.alpha(if (d.inMonth) 1f else OUT_OF_MONTH_ALPHA),
            verticalArrangement = Arrangement.spacedBy(PhoneCalendar.CHIP_GAP.dp),
        ) {
            if (budget.showsCountdown) countdowns.firstOrNull()?.let { CountdownPill(it) }
            for (row in chips.take(budget.shown)) MonthChip(row, style)
        }
        if (budget.more > 0) {
            Text(
                text = "+${budget.more} more",
                modifier = Modifier.padding(start = 3.dp).height(PhoneCalendar.MORE_LINE_HEIGHT.dp),
                style = TextStyle(fontSize = 8.5.sp, fontWeight = FontWeight.ExtraBold),
                color = WF.colors.ink3,
                maxLines = 1,
            )
        }
    }
}

/**
 * The Calendar's events in a run of whole weeks — the grid Weekly Planning's Horizon scan
 * shows. Reads the calendar's own model, so a change there reaches Horizon too.
 */
@Composable
fun CalendarWeeksGrid(
    model: CalendarModel,
    countdowns: CountdownsModel,
    start: LocalDate,
    weeks: Int,
    selectedDay: LocalDate?,
    onPick: (LocalDate) -> Unit,
    modifier: Modifier = Modifier,
) {
    val byDay by model.rowsByDay.collectAsState()
    val zone by model.zone.collectAsState()
    val weekStart by model.weekStart.collectAsState()
    val palette by model.palette.collectAsState()
    val countdownsByDate by countdowns.byDateState.collectAsState()
    val rows = remember(start, weeks, weekStart) { PhoneCalendar.weekRows(start, weeks, weekStart) }
    EventMonthGrid(
        rows = rows,
        weekStart = weekStart,
        zone = zone,
        byDay = byDay,
        countdownsByDate = countdownsByDate,
        style = palette.style,
        today = remember(zone) { LocalDate.now(zone) },
        selectedDay = selectedDay,
        onPick = onPick,
        modifier = modifier,
    )
}

@Composable
private fun MonthChip(row: EventRow, style: EventStyle) {
    val paint = phoneChipPaint(row, style)
    Box(
        Modifier
            .fillMaxWidth()
            .height(PhoneCalendar.CHIP_HEIGHT.dp)
            .background(paint.background, RoundedCornerShape(4.dp))
            .padding(horizontal = 3.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        ChipText(RhythmMark.prefixed(row.title, row.event.isRhythm), paint.foreground)
    }
}

@Composable
private fun ChipText(text: String, color: Color) {
    Text(
        text = text,
        style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.Bold),
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Clip,
    )
}

@Composable
private fun CountdownPill(c: CalendarApi.Countdown) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(PhoneCalendar.CHIP_HEIGHT.dp)
            .background(WF.colors.warnT, RoundedCornerShape(4.dp))
            .padding(horizontal = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        val pill = TextStyle(fontSize = 8.sp, fontWeight = FontWeight.ExtraBold)
        Text(c.title, Modifier.weight(1f), style = pill, color = WF.colors.warn, maxLines = 1, overflow = TextOverflow.Clip)
        Text(CountdownFormat.short(c.daysLeft), style = pill.copy(fontWeight = FontWeight.Black), color = WF.colors.warn, maxLines = 1)
    }
}

/**
 * Multi-day all-day events drawn as bars over one month row. Twin of iOS `MonthSpanBars`
 * (phone metrics). The cells leave [SpanBarMetrics.reservedHeight] empty under the day number; the bars
 * take no taps, so a tap reaches the day underneath.
 */
@Composable
internal fun MonthSpanBars(spans: PhoneCalendar.WeekSpans, inMonth: List<Boolean>, style: EventStyle) {
    if (spans.bars.isEmpty()) return
    BoxWithConstraints(Modifier.fillMaxSize().clearAndSetSemantics {}) {
        val width = maxWidth.value
        for (bar in spans.bars) {
            val paint = phoneChipPaint(bar.row, style)
            val frame = PhoneCalendar.spanBarX(bar.startCol, bar.endCol, width, spacing = 0f, inset = 2f)
            val lead = if (bar.continuesBefore) 0.dp else 4.dp
            val trail = if (bar.continuesAfter) 0.dp else 4.dp
            val dim = inMonth.getOrNull(bar.startCol) != true && inMonth.getOrNull(bar.endCol) != true
            Box(
                Modifier
                    .offset(x = frame.x.dp, y = (SpanBarMetrics.TOP + bar.lane * (PhoneCalendar.CHIP_HEIGHT + PhoneCalendar.CHIP_GAP)).dp)
                    .size(width = frame.width.dp, height = PhoneCalendar.CHIP_HEIGHT.dp)
                    .alpha(if (dim) OUT_OF_MONTH_ALPHA else 1f)
                    .clip(RoundedCornerShape(topStart = lead, bottomStart = lead, topEnd = trail, bottomEnd = trail))
                    .background(paint.background)
                    .padding(horizontal = 3.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                ChipText(RhythmMark.prefixed(bar.row.title, bar.row.event.isRhythm), paint.foreground)
            }
        }
    }
}

internal object SpanBarMetrics {
    /** Where lane 0 sits: below the cell's top padding, the day number and one gap. */
    const val TOP: Float = PhoneCalendar.CELL_TOP_PADDING + PhoneCalendar.DAY_NUMBER_HEIGHT + PhoneCalendar.CHIP_GAP

    fun reservedHeight(lanes: Int): Dp =
        if (lanes > 0) (lanes * PhoneCalendar.CHIP_HEIGHT + (lanes - 1) * PhoneCalendar.CHIP_GAP).dp else 0.dp
}

/**
 * The phone calendar's chip paint. People follow the household's event style; a planned meal
 * is always an amber wash so it reads as a meal, and a thaw reminder the faintest grey,
 * because it's a daily constant that shouldn't compete with real events.
 */
@Composable
internal fun phoneChipPaint(row: EventRow, style: EventStyle): EventChipPaint {
    val c = WF.colors
    return when (PhoneCalendar.EventKind.of(row.event.origin)) {
        PhoneCalendar.EventKind.Meal -> EventChipPaint.of(c.gold, EventStyle.Tinted, c.ink, c.isDark)
        PhoneCalendar.EventKind.Prep -> EventChipPaint.of(c.ink3, EventStyle.Tinted, c.ink, c.isDark)
        PhoneCalendar.EventKind.Regular ->
            EventChipPaint.of(colorFromHex(row.colorHex) ?: c.ink3, style, c.ink, c.isDark)
    }
}
