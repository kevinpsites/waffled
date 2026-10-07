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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CountdownFormat
import app.waffled.feature.calendar.EventRow
import app.waffled.feature.calendar.EventStyle
import app.waffled.feature.calendar.RhythmMark
import app.waffled.feature.calendar.TimeLanes
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One time-grid column: a day (Week / Day) or a person (People). */
@Immutable
data class KioskGridColumn(
    val id: String,
    val events: List<EventRow>,
    val day: LocalDate? = null,
    val person: PersonHeader? = null,
    val countdowns: List<CalendarApi.Countdown> = emptyList(),
) {
    @Immutable
    data class PersonHeader(val name: String, val colorHex: String?, val emoji: String?, val isEveryone: Boolean)
}

enum class KioskGridHeaders { None, Days, People }

private val HourHeight = KioskCalendar.HOUR_HEIGHT.dp
private val Gutter = KioskCalendar.GUTTER.dp
private val GridHeight = HourHeight * 24
private val DividerAlpha = 0.12f

/**
 * The Week / Day / People time grid: an hour axis with one column of positioned blocks per
 * [columns] entry. People is deliberately the SAME grid as Week, so a person's column reads
 * exactly like a day's. Opens on [scrollToHour] once and then keeps the reader's offset as
 * they page — each mode is its own call site, so entering a mode builds a fresh grid.
 */
@Composable
internal fun KioskTimeGrid(
    columns: List<KioskGridColumn>,
    headers: KioskGridHeaders,
    zone: ZoneId,
    today: LocalDate,
    style: EventStyle,
    showsNowLine: Boolean,
    scrollToHour: Int,
    onTapEvent: (EventRow) -> Unit,
    onTapCountdown: (CalendarApi.Countdown) -> Unit,
    onPickDay: (LocalDate) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Lane packing and the timed/all-day split once per data change, never per frame.
    val prepared = remember(columns) {
        columns.map { col ->
            val timed = col.events.filter { !it.allDay && it.startsAt != null }
            Prepared(col, TimeLanes.place(timed), col.events.filter { it.allDay })
        }
    }
    val hasAllDay = prepared.any { it.allDay.isNotEmpty() || it.column.countdowns.isNotEmpty() }
    val scroll = rememberScrollState()
    val density = LocalDensity.current

    LaunchedEffect(Unit) {
        scroll.scrollTo(with(density) { (HourHeight * scrollToHour).roundToPx() })
    }

    Column(modifier.fillMaxSize()) {
        if (headers != KioskGridHeaders.None) ColumnHeaders(prepared, headers, today, zone, onPickDay)
        if (hasAllDay) AllDayRow(prepared, style, onTapEvent, onTapCountdown)
        val shape = RoundedCornerShape(WF.radius.lg)
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .clip(shape)
                .background(WF.colors.card, shape)
                .border(1.dp, WF.colors.hair, shape)
                .verticalScroll(scroll),
        ) {
            Box(Modifier.fillMaxWidth().height(GridHeight)) {
                Column(Modifier.fillMaxWidth()) {
                    for (h in 0 until 24) HourRow(h)
                }
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Spacer(Modifier.width(Gutter))
                    prepared.forEachIndexed { idx, p ->
                        BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
                            if (prepared.size > 1 && idx > 0) ColumnDivider(GridHeight)
                            val colWidth = maxWidth
                            for (placed in p.placed) {
                                EventBlock(placed, colWidth, zone, style) { onTapEvent(placed.row) }
                            }
                        }
                    }
                }
                if (showsNowLine) NowLine(zone)
            }
        }
    }
}

@Immutable
private data class Prepared(
    val column: KioskGridColumn,
    val placed: List<TimeLanes.Placed>,
    val allDay: List<EventRow>,
)

/** A faint boundary centred in the 4dp column gap; takes no taps. */
@Composable
private fun ColumnDivider(height: androidx.compose.ui.unit.Dp) {
    Box(
        Modifier
            .offset(x = (-2).dp)
            .width(1.dp)
            .height(height)
            .background(WF.colors.ink.copy(alpha = DividerAlpha)),
    )
}

@Composable
private fun ColumnHeaders(
    prepared: List<Prepared>,
    headers: KioskGridHeaders,
    today: LocalDate,
    zone: ZoneId,
    onPickDay: (LocalDate) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().height(48.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Spacer(Modifier.width(Gutter))
        prepared.forEachIndexed { idx, p ->
            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.TopCenter) {
                if (headers == KioskGridHeaders.People) {
                    PersonHeader(p.column.person)
                } else {
                    p.column.day?.let { DayHeader(it, it == today, onPickDay) }
                }
                if (prepared.size > 1 && idx > 0) {
                    Box(Modifier.align(Alignment.CenterStart)) { ColumnDivider(40.dp) }
                }
            }
        }
    }
    Spacer(Modifier.height(10.dp))
}

private val weekdayFormat = DateTimeFormatter.ofPattern("EEE", Locale.getDefault())

@Composable
private fun DayHeader(day: LocalDate, isToday: Boolean, onPick: (LocalDate) -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable { onPick(day) },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = weekdayFormat.format(day).uppercase(),
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.ExtraBold),
            color = WF.colors.ink3,
        )
        Box(
            Modifier
                .size(30.dp)
                .background(if (isToday) WF.colors.primary else Color.Transparent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "${day.dayOfMonth}",
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                // White on the saturated coral fill, which stays coral in both themes.
                color = if (isToday) Color.White else WF.colors.ink,
            )
        }
    }
}

/** A person as a column header — the day header's shape, avatar where the date goes. */
@Composable
private fun PersonHeader(person: KioskGridColumn.PersonHeader?) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            text = person?.name ?: "Everyone",
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.ExtraBold),
            color = WF.colors.ink3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (person != null && !person.isEveryone) {
            AvatarFromHex(colorHex = person.colorHex, emoji = person.emoji ?: "🙂", size = 30.dp)
        } else {
            EveryoneGlyph(size = 30.dp, tint = WF.colors.ink3, fill = WF.colors.panel)
        }
    }
}

@Composable
internal fun EveryoneGlyph(size: androidx.compose.ui.unit.Dp, tint: Color, fill: Color) {
    Box(Modifier.size(size).background(fill, CircleShape), contentAlignment = Alignment.Center) {
        Icon(Icons.Filled.Group, contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

@Composable
private fun AllDayRow(
    prepared: List<Prepared>,
    style: EventStyle,
    onTapEvent: (EventRow) -> Unit,
    onTapCountdown: (CalendarApi.Countdown) -> Unit,
) {
    val separator = KioskCalendar.allDayContentHeight(
        prepared.map { it.allDay.size + it.column.countdowns.size },
    ).dp
    Row(
        Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = "all-day",
            modifier = Modifier.width(Gutter).padding(end = 6.dp),
            style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.ExtraBold),
            color = WF.colors.ink3,
            textAlign = TextAlign.End,
        )
        prepared.forEachIndexed { idx, p ->
            Box(Modifier.weight(1f)) {
                if (prepared.size > 1 && idx > 0) ColumnDivider(separator)
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    // Countdowns first, then all-day events — the day panel's order.
                    for (c in p.column.countdowns) CountdownChip(c) { onTapCountdown(c) }
                    for (row in p.allDay) AllDayChip(row, style) { onTapEvent(row) }
                }
            }
        }
    }
}

@Composable
private fun CountdownChip(c: CalendarApi.Countdown, onClick: () -> Unit) {
    val shape = RoundedCornerShape(6.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(WF.colors.warnT, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(c.emoji ?: "⏳", style = TextStyle(fontSize = 10.sp))
        Text(
            text = c.title,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = CountdownFormat.short(c.daysLeft),
            style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.ExtraBold),
            color = WF.colors.warn,
        )
    }
}

@Composable
private fun AllDayChip(row: EventRow, style: EventStyle, onClick: () -> Unit) {
    val paint = kioskChipPaint(row, style)
    val shape = RoundedCornerShape(6.dp)
    Text(
        text = RhythmMark.prefixed(row.title, row.event.isRhythm),
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(paint.background, shape)
            .clickable(onClick = onClick)
            .semantics { contentDescription = RhythmMark.accessibilityLabel(row.title, row.event.isRhythm) }
            .padding(horizontal = 6.dp, vertical = 3.dp),
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
        color = paint.foreground,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun HourRow(hour: Int) {
    Row(
        Modifier.fillMaxWidth().height(HourHeight),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = KioskCalendar.hourLabel(hour),
            modifier = Modifier.width(Gutter - 8.dp),
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
            textAlign = TextAlign.End,
        )
        Box(Modifier.weight(1f).height(1.dp).background(WF.colors.hair))
    }
}

@Composable
private fun EventBlock(
    placed: TimeLanes.Placed,
    colWidth: androidx.compose.ui.unit.Dp,
    zone: ZoneId,
    style: EventStyle,
    onClick: () -> Unit,
) {
    val row = placed.row
    val geometry = KioskCalendar.block(row, zone) ?: return
    val laneW = colWidth / placed.lanes
    val paint = kioskChipPaint(row, style)
    val shape = RoundedCornerShape(7.dp)
    Row(
        Modifier
            .offset(x = laneW * placed.lane + 1.dp, y = geometry.y.dp)
            .size(width = maxOf(0.dp, laneW - 3.dp), height = geometry.height.dp)
            .clip(shape)
            .background(paint.background, shape)
            .border(1.dp, WF.colors.card, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(paint.color, RoundedCornerShape(99.dp)))
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = RhythmMark.prefixed(row.title, row.event.isRhythm),
                modifier = Modifier.semantics {
                    contentDescription = RhythmMark.accessibilityLabel(row.title, row.event.isRhythm)
                },
                style = TextStyle(fontSize = if (placed.lanes > 1) 12.sp else 13.sp, fontWeight = FontWeight.Bold),
                color = paint.foreground,
                maxLines = if (placed.lanes > 2) 1 else 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (geometry.height > 38f && placed.lanes < 3) {
                Text(
                    text = row.timeLabel,
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium),
                    color = paint.foreground.copy(alpha = 0.75f),
                    maxLines = 1,
                )
            }
        }
    }
}

/** The live "now" rule: a dot at the gutter edge and a line across the columns, every minute. */
@Composable
private fun NowLine(zone: ZoneId) {
    val now by produceState(Instant.now()) {
        while (true) {
            delay(60_000)
            value = Instant.now()
        }
    }
    // iOS paints a literal red here; `danger` is the token for it.
    val red = WF.colors.danger
    Box(
        Modifier
            .fillMaxWidth()
            .offset(y = KioskCalendar.nowOffset(now, zone).dp - 4.5.dp)
            .height(9.dp)
            .clearAndSetSemantics {},
    ) {
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .padding(start = Gutter)
                .fillMaxWidth()
                .height(2.dp)
                .background(red),
        )
        Box(Modifier.offset(x = Gutter - 4.dp).size(9.dp).background(red, CircleShape))
    }
}
