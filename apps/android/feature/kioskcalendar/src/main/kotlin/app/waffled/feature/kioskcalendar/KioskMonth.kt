package app.waffled.feature.kioskcalendar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.feature.calendar.Agenda
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CalendarModel
import app.waffled.feature.calendar.CountdownCard
import app.waffled.feature.calendar.CountdownFormat
import app.waffled.feature.calendar.EventCard
import app.waffled.feature.calendar.EventChipPaint
import app.waffled.feature.calendar.EventRow
import app.waffled.feature.calendar.EventStyle
import app.waffled.feature.calendar.PhoneCalendar
import app.waffled.feature.calendar.RhythmMark
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The tablet's chip paint: the household style over the event colour, with no meal / thaw
 * override (that is the phone's `phoneChipPaint`). Unassigned falls back to `ink3`.
 */
@Composable
internal fun kioskChipPaint(row: EventRow, style: EventStyle): EventChipPaint {
    val c = WF.colors
    return EventChipPaint.of(colorFromHex(row.colorHex) ?: c.ink3, style, c.ink, c.isDark)
}

private const val OUT_OF_MONTH_ALPHA = 0.42f

@Composable
internal fun KioskMonthGrid(
    anchor: LocalDate,
    weekStart: HouseholdWeekStart,
    byDay: Map<LocalDate, List<EventRow>>,
    countdownsByDate: Map<String, List<CalendarApi.Countdown>>,
    style: EventStyle,
    today: LocalDate,
    selectedDay: LocalDate,
    onSelect: (LocalDate) -> Unit,
    modifier: Modifier = Modifier,
) {
    val rows = remember(anchor, weekStart) { KioskCalendar.monthRows(anchor, weekStart) }
    val spans = remember(rows, byDay) { rows.map { r -> PhoneCalendar.weekSpans(r.map { it.date }, byDay) } }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (label in KioskCalendar.weekdayHeaders(weekStart)) {
                Text(
                    text = label,
                    modifier = Modifier.weight(1f),
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.ExtraBold),
                    color = WF.colors.ink3,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
        rows.forEachIndexed { i, cells ->
            val rowSpans = spans[i]
            Box(Modifier.weight(1f).fillMaxWidth()) {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (cell in cells) {
                        MonthCell(
                            cell = cell,
                            items = rowSpans.chipsByDay[cell.date].orEmpty(),
                            lanes = rowSpans.lanes,
                            countdown = countdownsByDate[cell.date.toString()]?.firstOrNull(),
                            isToday = cell.date == today,
                            isSelected = cell.date == selectedDay,
                            style = style,
                            onClick = { onSelect(cell.date) },
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                        )
                    }
                }
                KioskSpanBars(rowSpans, cells.map { it.inMonth }, style)
            }
        }
    }
}

@Composable
private fun MonthCell(
    cell: CalendarModel.MonthCell,
    items: List<EventRow>,
    lanes: Int,
    countdown: CalendarApi.Countdown?,
    isToday: Boolean,
    isSelected: Boolean,
    style: EventStyle,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    val chips = PhoneCalendar.cappedChips(items.size, KioskCalendar.CELL_CHIP_CAP, lanes)
    val shape = RoundedCornerShape(12.dp)
    val fill = when {
        isSelected -> WF.colors.primary.copy(alpha = 0.08f)
        cell.inMonth -> WF.colors.card
        else -> WF.colors.panel.copy(alpha = 0.4f)
    }
    Column(
        modifier
            .clip(shape)
            .background(fill, shape)
            .border(if (isSelected) 1.5.dp else 1.dp, if (isSelected) WF.colors.primary else WF.colors.hair, shape)
            .clickable(onClick = onClick)
            .padding(7.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(24.dp).background(if (isToday) WF.colors.primary else Color.Transparent, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "${cell.dayOfMonth}",
                    style = TextStyle(fontSize = 14.sp, fontWeight = if (isToday) FontWeight.ExtraBold else FontWeight.SemiBold),
                    color = when {
                        !cell.inMonth -> WF.colors.ink3.copy(alpha = 0.5f)
                        // White on the saturated coral fill, which stays coral in both themes.
                        isToday -> Color.White
                        else -> WF.colors.ink
                    },
                )
            }
            Spacer(Modifier.weight(1f))
            countdown?.let { CountdownBadge(it) }
        }
        if (lanes > 0) Spacer(Modifier.height(KioskCalendar.spanReservedHeight(lanes).dp))
        for (row in items.take(chips.shown)) EventChip(row, style)
        if (chips.more > 0) {
            Text(
                text = "+${chips.more} more",
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
    }
}

@Composable
private fun CountdownBadge(c: CalendarApi.Countdown) {
    Row(
        Modifier
            .background(WF.colors.warnT, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 4.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(c.emoji ?: "⏳", style = TextStyle(fontSize = 9.sp))
        Text(
            text = CountdownFormat.short(c.daysLeft),
            style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.ExtraBold),
            color = WF.colors.warn,
        )
    }
}

/** Month-cell chips show the title only: in a narrow cell a leading time hides the title. */
@Composable
private fun EventChip(row: EventRow, style: EventStyle) {
    val paint = kioskChipPaint(row, style)
    Row(
        Modifier
            .fillMaxWidth()
            .background(paint.background, RoundedCornerShape(6.dp))
            .padding(horizontal = 5.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(width = 3.dp, height = 13.dp).background(paint.color, RoundedCornerShape(99.dp)))
        Text(
            text = RhythmMark.prefixed(row.title, row.event.isRhythm),
            style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
            color = paint.foreground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Multi-day all-day events as bars over one month row, at the tablet metrics. The cells
 * leave [KioskCalendar.spanReservedHeight] empty for them; the bars take no taps, so a tap
 * reaches the day underneath.
 */
@Composable
private fun KioskSpanBars(spans: PhoneCalendar.WeekSpans, inMonth: List<Boolean>, style: EventStyle) {
    if (spans.bars.isEmpty()) return
    BoxWithConstraints(Modifier.fillMaxSize().clearAndSetSemantics {}) {
        val width = maxWidth.value
        for (bar in spans.bars) {
            val paint = kioskChipPaint(bar.row, style)
            val frame = PhoneCalendar.spanBarX(
                bar.startCol, bar.endCol, width,
                spacing = KioskCalendar.SPAN_SPACING, inset = KioskCalendar.SPAN_INSET,
            )
            val lead = if (bar.continuesBefore) 0.dp else 4.dp
            val trail = if (bar.continuesAfter) 0.dp else 4.dp
            val dim = inMonth.getOrNull(bar.startCol) != true && inMonth.getOrNull(bar.endCol) != true
            val shape = RoundedCornerShape(topStart = lead, bottomStart = lead, topEnd = trail, bottomEnd = trail)
            Box(
                Modifier
                    .offset(x = frame.x.dp, y = KioskCalendar.spanBarTop(bar.lane).dp)
                    .size(width = frame.width.dp, height = KioskCalendar.SPAN_HEIGHT.dp)
                    .alpha(if (dim) OUT_OF_MONTH_ALPHA else 1f)
                    .background(paint.background, shape)
                    .padding(horizontal = 7.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    text = RhythmMark.prefixed(bar.row.title, bar.row.event.isRhythm),
                    style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                    color = paint.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Clip,
                )
            }
        }
    }
}

private val panelDateFormat = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())

/** Month mode's side panel: the selected day's countdowns, then its events. */
@Composable
internal fun KioskDayPanel(
    day: LocalDate,
    today: LocalDate,
    zone: ZoneId,
    rows: List<EventRow>,
    countdowns: List<CalendarApi.Countdown>,
    sleeps: Boolean,
    onAdd: () -> Unit,
    onOpenEvent: (EventRow) -> Unit,
    onOpenCountdown: (CalendarApi.Countdown) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier
            .fillMaxHeight()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .padding(18.dp),
    ) {
        Row(
            Modifier.padding(bottom = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text(KioskCalendar.relativeLabel(day, today), style = WF.type.serif(24.sp), color = WF.colors.ink)
            Text(
                text = panelDateFormat.format(day),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        if (rows.isEmpty() && countdowns.isEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(WF.radius.md))
                    .clickable(onClick = onAdd)
                    .padding(vertical = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Icons.Filled.CalendarMonth, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(30.dp))
                Text("Nothing scheduled", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
                Text("Tap to add an event", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
            }
        } else {
            // One clock read per data change, not one per row.
            val now = remember(rows) { Instant.now() }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(countdowns, key = { "countdown-${it.id}" }) { c ->
                    CountdownCard(countdown = c, sleeps = sleeps, onClick = { onOpenCountdown(c) })
                }
                items(rows, key = { "event-${it.id}" }) { row ->
                    EventCard(row = row, isPast = Agenda.isPast(row, zone, now), onClick = { onOpenEvent(row) })
                }
            }
        }
    }
}
