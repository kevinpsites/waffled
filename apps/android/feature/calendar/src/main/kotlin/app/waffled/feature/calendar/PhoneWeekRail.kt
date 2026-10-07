package app.waffled.feature.calendar

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.snapping.SnapPosition
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfShadow1
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.WaffledDates
import java.time.LocalDate
import java.time.ZoneId

private const val RAIL_WEEKS_EACH_SIDE = 26

/**
 * Day cards on one continuous rail — whole weeks either side of the selected one — so
 * swiping on from a week's last day simply scrolls into the next week. The day strip above
 * and the dots below show the selected day's week. Tapping an event opens its editor; the
 * card is not a way into Day. Twin of iOS `PhoneWeekRail`.
 *
 * Only a USER drag moves the selection; programmatic scrolls (following a strip tap, or
 * re-centring the rail) never report back, so the two scrollers can't chase each other.
 */
@Composable
internal fun PhoneWeekRail(
    selectedDay: LocalDate,
    onSelect: (LocalDate) -> Unit,
    weekStart: HouseholdWeekStart,
    zone: ZoneId,
    today: LocalDate,
    byDay: Map<LocalDate, List<EventRow>>,
    countdownsByDate: Map<String, List<CalendarApi.Countdown>>,
    style: EventStyle,
    mealsEnabled: Boolean,
    onEditEvent: (EventRow) -> Unit,
    onTapCountdown: (CalendarApi.Countdown) -> Unit,
    modifier: Modifier = Modifier,
) {
    val select by rememberUpdatedState(onSelect)
    var railDays by remember(weekStart) {
        mutableStateOf(PhoneCalendar.railDays(selectedDay, RAIL_WEEKS_EACH_SIDE, weekStart))
    }
    val weeks = remember(railDays) { PhoneCalendar.railWeeks(railDays) }
    val listState = rememberLazyListState(railDays.indexOf(selectedDay).coerceAtLeast(0))
    val pager = rememberPagerState(weeks.indexOf(weekStart.weekStart(selectedDay)).coerceAtLeast(0)) { weeks.size }
    val currentWeek = remember(selectedDay, weekStart) { PhoneCalendar.weekDays(selectedDay, weekStart) }

    LaunchedEffect(selectedDay, railDays) {
        if (PhoneCalendar.railNeedsRecenter(selectedDay, railDays)) {
            // Items are keyed by day, so the list holds its place across the swap and the
            // relaunched effect below scrolls the short way to the selection.
            railDays = PhoneCalendar.railDays(selectedDay, RAIL_WEEKS_EACH_SIDE, weekStart)
            return@LaunchedEffect
        }
        val i = railDays.indexOf(selectedDay)
        if (listState.firstVisibleItemIndex != i || listState.firstVisibleItemScrollOffset != 0) {
            listState.animateScrollToItem(i)
        }
        val w = weeks.indexOf(weekStart.weekStart(selectedDay))
        if (w >= 0 && pager.currentPage != w) pager.animateScrollToPage(w)
    }

    val railDragged by listState.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(listState, railDays) {
        var dragged = false
        snapshotFlow { listState.isScrollInProgress to railDragged }.collect { (scrolling, dragging) ->
            if (dragging) dragged = true
            if (!scrolling && !dragging && dragged) {
                dragged = false
                railDays.getOrNull(listState.firstVisibleItemIndex)?.let(select)
            }
        }
    }

    val stripDragged by pager.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(pager, weeks) {
        var dragged = false
        snapshotFlow { pager.settledPage to stripDragged }.collect { (page, dragging) ->
            if (dragging) dragged = true
            if (!dragging && dragged && !pager.isScrollInProgress) {
                dragged = false
                // Paging the strip lands on that week's first day.
                weeks.getOrNull(page)?.let(select)
            }
        }
    }

    Column(modifier) {
        HorizontalPager(
            state = pager,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 2.dp, bottom = 10.dp)
                .height(54.dp),
            key = { weeks[it] },
        ) { page ->
            val first = weeks[page]
            Row(
                Modifier.fillMaxSize().padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                for (offset in 0 until 7) {
                    val day = first.plusDays(offset.toLong())
                    StripDay(
                        day = day,
                        on = day == selectedDay,
                        zone = zone,
                        colors = personColors(byDay[day].orEmpty()),
                        onClick = { select(day) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val cardWidth = maxOf(220.dp, maxWidth - 101.dp)
            val cardHeight = maxOf(0.dp, maxHeight - 8.dp)
            LazyRow(
                state = listState,
                flingBehavior = rememberSnapFlingBehavior(listState, SnapPosition.Start),
                contentPadding = PaddingValues(start = 16.dp, end = maxOf(16.dp, maxWidth - cardWidth - 16.dp)),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                itemsIndexed(railDays, key = { _, d -> d.toString() }) { _, day ->
                    WeekCard(
                        day = day,
                        selected = day == selectedDay,
                        isToday = day == today,
                        zone = zone,
                        rows = byDay[day].orEmpty(),
                        countdowns = countdownsByDate[day.toString()].orEmpty(),
                        style = style,
                        mealsEnabled = mealsEnabled,
                        onEditEvent = onEditEvent,
                        onTapCountdown = onTapCountdown,
                        modifier = Modifier.width(cardWidth).height(cardHeight),
                    )
                }
            }
        }
        WeekDots(currentWeek, selectedDay, Modifier.padding(vertical = 12.dp).align(Alignment.CenterHorizontally))
    }
}

/**
 * Distinct event colours for a strip day — a whole-family event contributes the family
 * colour; meal and thaw events belong to nobody in particular, so they add no dot.
 */
private fun personColors(rows: List<EventRow>): List<String?> =
    rows.filter { PhoneCalendar.EventKind.of(it.event.origin) == PhoneCalendar.EventKind.Regular }
        .map { it.colorHex }
        .distinct()

private fun format(day: LocalDate, pattern: String, zone: ZoneId): String =
    WaffledDates.format(day.atStartOfDay(zone).toInstant(), pattern, zone)

@Composable
private fun StripDay(
    day: LocalDate,
    on: Boolean,
    zone: ZoneId,
    colors: List<String?>,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    val shape = RoundedCornerShape(13.dp)
    val label = format(day, "EEEE, MMMM d", zone)
    Column(
        modifier
            .background(if (on) WF.colors.card else Color.Transparent, shape)
            .then(if (on) Modifier.border(1.5.dp, WF.colors.primary, shape) else Modifier)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
            .semantics {
                contentDescription = label
                selected = on
            }
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            text = format(day, "EEEEE", zone),
            style = TextStyle(fontSize = 9.5.sp, fontWeight = FontWeight.ExtraBold),
            color = if (on) WF.colors.primary else WF.colors.ink3,
        )
        Text(
            text = "${day.dayOfMonth}",
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            color = if (on) WF.colors.primary else WF.colors.ink,
        )
        Row(Modifier.height(4.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            for (hex in colors.take(3)) {
                Box(Modifier.size(4.dp).background(colorFromHex(hex) ?: WF.colors.ink3, CircleShape))
            }
        }
    }
}

@Composable
private fun WeekCard(
    day: LocalDate,
    selected: Boolean,
    isToday: Boolean,
    zone: ZoneId,
    rows: List<EventRow>,
    countdowns: List<CalendarApi.Countdown>,
    style: EventStyle,
    mealsEnabled: Boolean,
    onEditEvent: (EventRow) -> Unit,
    onTapCountdown: (CalendarApi.Countdown) -> Unit,
    modifier: Modifier,
) {
    val events = remember(rows) { PhoneCalendar.displayOrder(rows) }
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, if (selected) WF.colors.primary.copy(alpha = 0.45f) else WF.colors.hair2, shape)
            .padding(start = 15.dp, end = 15.dp, top = 15.dp),
    ) {
        Row(Modifier.padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = format(day, "EEE", zone).uppercase(),
                style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.8.sp),
                color = WF.colors.ink3,
            )
            Spacer(Modifier.width(7.dp))
            Text(text = "${day.dayOfMonth}", style = WF.type.serif(26.sp), color = WF.colors.ink)
            if (isToday) {
                Spacer(Modifier.width(7.dp))
                WaffledStatusBadge(text = "TODAY", color = WF.colors.primaryD, size = 9.5.sp, weight = FontWeight.ExtraBold)
            }
            Spacer(Modifier.weight(1f))
            Text(
                text = "${events.size + countdowns.size}",
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink3,
            )
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair2))
        if (events.isEmpty() && countdowns.isEmpty()) {
            Text(
                text = "Nothing planned",
                modifier = Modifier.padding(top = 14.dp),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                color = WF.colors.ink3,
            )
            Spacer(Modifier.weight(1f))
        } else {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                for (c in countdowns) {
                    RailRow(
                        time = CountdownFormat.short(c.daysLeft),
                        timeColor = WF.colors.warn,
                        bar = colorFromHex(c.color) ?: WF.colors.warn,
                        title = "${c.emoji ?: "⏳"} ${c.title}",
                        onClick = { onTapCountdown(c) },
                    )
                }
                for (row in events) {
                    RailRow(
                        time = when {
                            row.allDay -> "all day"
                            else -> row.startsAt?.let { PhoneCalendar.shortTime(it, zone) }.orEmpty()
                        },
                        timeColor = WF.colors.ink3,
                        bar = phoneChipPaint(row, style).color,
                        title = RhythmMark.prefixed(row.title, row.event.isRhythm),
                        onClick = { onEditEvent(row) },
                    )
                }
            }
        }
        if (mealsEnabled) {
            val dinner = PhoneCalendar.dinnerFooter(events)
            Text(
                text = dinner ?: "No dinner planned",
                modifier = Modifier.padding(top = 9.dp, bottom = 12.dp),
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                color = if (dinner == null) WF.colors.ink3 else WF.colors.warn,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun RailRow(time: String, timeColor: Color, bar: Color, title: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = time,
                modifier = Modifier.width(50.dp),
                style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.Bold, fontFeatureSettings = "tnum"),
                color = timeColor,
                maxLines = 1,
            )
            Box(Modifier.size(width = 3.dp, height = 18.dp).background(bar, RoundedCornerShape(2.dp)))
            Text(
                text = title,
                modifier = Modifier.weight(1f),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair2))
    }
}

@Composable
private fun WeekDots(days: List<LocalDate>, selected: LocalDate, modifier: Modifier) {
    Row(modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        for (day in days) {
            val on = day == selected
            val width by animateDpAsState(if (on) 16.dp else 5.dp, label = "weekDot")
            Box(
                Modifier
                    .size(width = width, height = 5.dp)
                    .background(if (on) WF.colors.primary else WF.colors.ink3.copy(alpha = 0.35f), CircleShape),
            )
        }
    }
}
