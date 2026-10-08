package app.waffled.feature.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
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
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.model.WaffledDates
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

private val HourHeight = 56.dp
private val TimeGutter = 46.dp
private val GridTrailing = 12.dp
private val GridTopInset = 12.dp

/**
 * One day: date header, an all-day strip, then a timed grid with overlap lanes and a now
 * line. Twin of iOS `PhoneDayTimeline`.
 *
 * Hour rows add an event at that hour on a TAP; the grid's own flick detector consumes a
 * sideways drag first, so a swipe between days that lifts on a row never opens "New event".
 */
@Composable
internal fun PhoneDayTimeline(
    day: LocalDate,
    zone: ZoneId,
    rows: List<EventRow>,
    countdowns: List<CalendarApi.Countdown>,
    isToday: Boolean,
    style: EventStyle,
    onTapEvent: (EventRow) -> Unit,
    onTapCountdown: (CalendarApi.Countdown) -> Unit,
    onAddAt: (hour: Int) -> Unit,
    onSwipeDay: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val ordered = remember(rows) { PhoneCalendar.displayOrder(rows) }
    val allDay = remember(ordered) { ordered.filter { it.allDay } }
    val timed = remember(ordered) { ordered.filter { !it.allDay && it.startsAt != null } }
    val hours = remember(timed, zone) { PhoneCalendar.dayHours(timed, zone) }
    val opening = remember(timed, hours, zone) { PhoneCalendar.openingHour(timed, hours, zone) }
    val scroll = rememberScrollState()
    val density = LocalDensity.current

    // Keyed on the opening hour too: on a cold launch the day's events sync in after the first
    // frame, and the grid should still open on them.
    LaunchedEffect(day, opening) {
        delay(60)
        scroll.scrollTo(with(density) { (HourHeight * (opening - hours.first)).roundToPx() })
    }

    Column(modifier) {
        DayHeader(day, zone, isToday, rows.size + countdowns.size)
        if (allDay.isNotEmpty() || countdowns.isNotEmpty()) {
            AllDayStrip(allDay, countdowns, style, onTapEvent, onTapCountdown)
        }
        Box(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                // On the grid only: the all-day strip above scrolls sideways itself.
                .calendarFlick(guardBackEdge = true, onStep = onSwipeDay)
                .verticalScroll(scroll),
        ) {
            TimeGrid(day, zone, timed, hours, isToday, style, onTapEvent, onAddAt)
        }
    }
}

private fun format(day: LocalDate, pattern: String, zone: ZoneId): String =
    WaffledDates.format(day.atStartOfDay(zone).toInstant(), pattern, zone)

@Composable
private fun DayHeader(day: LocalDate, zone: ZoneId, isToday: Boolean, count: Int) {
    Column {
        Row(
            Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 2.dp, bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text(
                text = format(day, "EEE", zone).uppercase(),
                modifier = Modifier.alignByBaseline(),
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.9.sp),
                color = WF.colors.ink3,
            )
            Text("${day.dayOfMonth}", Modifier.alignByBaseline(), style = WF.type.serif(30.sp), color = WF.colors.ink)
            Text(
                text = format(day, "MMMM", zone),
                modifier = Modifier.alignByBaseline(),
                style = WF.type.serif(18.sp, FontWeight.Normal),
                color = WF.colors.ink3,
            )
            if (isToday) {
                WaffledStatusBadge(
                    text = "TODAY",
                    color = WF.colors.primaryD,
                    modifier = Modifier.alignByBaseline(),
                    size = 10.sp,
                    weight = FontWeight.ExtraBold,
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                text = if (count == 1) "1 event" else "$count events",
                modifier = Modifier.alignByBaseline(),
                style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink3,
            )
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair))
    }
}

@Composable
private fun AllDayStrip(
    allDay: List<EventRow>,
    countdowns: List<CalendarApi.Countdown>,
    style: EventStyle,
    onTapEvent: (EventRow) -> Unit,
    onTapCountdown: (CalendarApi.Countdown) -> Unit,
) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            for (c in countdowns) {
                StripChip(
                    text = "${c.emoji ?: "⏳"} ${c.title} · ${CountdownFormat.short(c.daysLeft)}",
                    foreground = WF.colors.warn,
                    background = WF.colors.warnT,
                    onClick = { onTapCountdown(c) },
                )
            }
            for (row in allDay) {
                val paint = phoneChipPaint(row, style)
                StripChip(
                    text = RhythmMark.prefixed(row.title, row.event.isRhythm),
                    foreground = paint.foreground,
                    background = paint.background,
                    onClick = { onTapEvent(row) },
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair))
    }
}

@Composable
private fun StripChip(text: String, foreground: Color, background: Color, onClick: () -> Unit) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier
            .height(20.dp)
            .widthIn(max = 196.dp)
            .clip(shape)
            .background(background, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = text,
            style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.Bold),
            color = foreground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun TimeGrid(
    day: LocalDate,
    zone: ZoneId,
    timed: List<EventRow>,
    hours: IntRange,
    isToday: Boolean,
    style: EventStyle,
    onTapEvent: (EventRow) -> Unit,
    onAddAt: (Int) -> Unit,
) {
    val gridHeight = HourHeight * (hours.last - hours.first) + GridTopInset * 2
    val placed = remember(timed) { TimeLanes.place(timed) }
    fun hourOffset(instant: Instant): Dp {
        val t = instant.atZone(zone)
        return HourHeight * ((t.hour - hours.first) + t.minute / 60f) + GridTopInset
    }

    BoxWithConstraints(Modifier.fillMaxWidth().height(gridHeight)) {
        Column(Modifier.fillMaxWidth()) {
            Spacer(Modifier.height(GridTopInset))
            for (h in hours.first until hours.last) {
                HourRow(
                    hour = h,
                    height = HourHeight,
                    modifier = Modifier
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            role = Role.Button,
                            onClickLabel = "Add an event at ${hourLabel(h)}",
                        ) { onAddAt(h) }
                        .semantics { contentDescription = "Add an event at ${hourLabel(h)}" },
                )
            }
            HourRow(hour = hours.last, height = 1.dp)
        }

        val laneArea = maxWidth - TimeGutter - GridTrailing
        for (p in placed) {
            val start = p.row.startsAt ?: continue
            val y = hourOffset(start)
            val minutes = Duration.between(start, TimeLanes.end(p.row)).toMinutes()
            val height = minOf(maxOf(22.dp, HourHeight * (minutes / 60f) - 4.dp), gridHeight - y)
            val laneWidth = laneArea / p.lanes
            EventBlock(
                row = p.row,
                zone = zone,
                tight = minutes < 60,
                style = style,
                onClick = { onTapEvent(p.row) },
                modifier = Modifier
                    .offset(x = TimeGutter + laneWidth * p.lane + 2.dp, y = y)
                    .size(width = maxOf(0.dp, laneWidth - 4.dp), height = height),
            )
        }

        if (isToday) {
            val now by produceState(Instant.now(), day) {
                while (true) {
                    delay(60_000)
                    value = Instant.now()
                }
            }
            val t = now.atZone(zone)
            val hour = t.hour + t.minute / 60f
            if (hour >= hours.first && hour <= hours.last) {
                Box(Modifier.fillMaxWidth().offset(y = hourOffset(now) - 4.dp).height(7.dp).padding(end = GridTrailing)) {
                    Box(
                        Modifier
                            .align(Alignment.CenterStart)
                            .padding(start = TimeGutter)
                            .fillMaxWidth()
                            .height(1.5.dp)
                            .background(WF.colors.primary),
                    )
                    Box(
                        Modifier
                            .offset(x = TimeGutter - 3.dp)
                            .size(7.dp)
                            .background(WF.colors.primary, CircleShape),
                    )
                }
            }
        }
    }
}

@Composable
private fun HourRow(hour: Int, height: Dp, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(height).padding(end = GridTrailing)) {
        Text(
            text = hourLabel(hour),
            modifier = Modifier
                .width(TimeGutter - 6.dp)
                .offset(y = (-6).dp),
            style = TextStyle(fontSize = 9.5.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
            textAlign = TextAlign.End,
            maxLines = 1,
        )
        Spacer(Modifier.width(6.dp))
        Box(Modifier.weight(1f).height(1.dp).background(WF.colors.hair2))
    }
}

@Composable
private fun EventBlock(
    row: EventRow,
    zone: ZoneId,
    tight: Boolean,
    style: EventStyle,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    val paint = phoneChipPaint(row, style)
    val shape = RoundedCornerShape(7.dp)
    Row(
        modifier
            .clip(shape)
            .background(paint.background)
            .clickable(onClick = onClick),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(paint.color))
        Column(
            Modifier.padding(horizontal = 7.dp, vertical = if (tight) 2.dp else 4.dp),
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            Text(
                text = RhythmMark.prefixed(row.title, row.event.isRhythm),
                style = TextStyle(fontSize = if (tight) 11.sp else 12.sp, fontWeight = FontWeight.Bold),
                color = paint.foreground,
                maxLines = if (tight) 1 else 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (!tight) {
                row.startsAt?.let {
                    Text(
                        text = PhoneCalendar.shortTime(it, zone),
                        style = TextStyle(fontSize = 9.5.sp, fontWeight = FontWeight.Bold),
                        color = paint.foreground.copy(alpha = 0.72f),
                    )
                }
            }
        }
    }
}

private fun hourLabel(h: Int): String {
    val hr = if (h % 12 == 0) 12 else h % 12
    return "$hr ${if (h < 12 || h == 24) "AM" else "PM"}"
}
