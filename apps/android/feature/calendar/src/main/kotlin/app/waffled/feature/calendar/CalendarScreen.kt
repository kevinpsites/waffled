package app.waffled.feature.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.Avatar
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * How the calendar is being read.
 *
 * ⚠️ Only two modes on the phone, deliberately. iOS also offers a 24-hour Day grid and the
 * tablet adds a People view; a phone column is too narrow for the latter (four members
 * already truncate titles to "Dinn…"), and the person FILTER below covers "just show me one
 * person's day" instead. The Day grid is Phase 4.
 */
enum class CalMode(val label: String) { Agenda("Agenda"), Month("Month") }

/** The month grid's day headings, Sunday-led to match the web and iOS grids. */

private val MonthCellHeight = 44.dp
private const val MAX_DAY_DOTS = 3

/**
 * The Calendar tab — an upcoming agenda grouped by day, or a month grid with the selected
 * day's list beneath it, filtered to one person or to everyone.
 *
 * Events arrive over PowerSync and are read through [CalendarModel], which has already
 * ordered and labelled every row; this screen only looks things up. Countdowns are REST and
 * appear inline as all-day rows, so a day with only a countdown still shows.
 */
@Composable
fun CalendarScreen(
    model: CalendarModel,
    countdowns: CountdownsModel,
    api: CalendarApi,
    modifier: Modifier = Modifier,
) {
    val rows by model.rowsByDay.collectAsStateWithLifecycle()
    val members by model.members.collectAsStateWithLifecycle()
    val zone by model.zone.collectAsStateWithLifecycle()
    val countdownItems by countdowns.byDateState.collectAsStateWithLifecycle()
    val sleeps by countdowns.sleepsState.collectAsStateWithLifecycle()

    val scope = androidx.compose.runtime.rememberCoroutineScope()

    var mode by remember { mutableStateOf(CalMode.Agenda) }
    var filterPerson by remember { mutableStateOf<String?>(null) }
    var monthAnchor by remember { mutableStateOf(LocalDate.now()) }
    var selectedDay by remember { mutableStateOf(LocalDate.now()) }

    var detailRow by remember { mutableStateOf<EventRow?>(null) }
    var editing by remember { mutableStateOf<EditTarget?>(null) }
    var editingCountdown by remember { mutableStateOf<CalendarApi.Countdown?>(null) }

    LaunchedEffect(Unit) {
        model.refresh(api)
        countdowns.load()
    }

    // The household's zone arrives after first composition, so "today" is only correct once
    // it lands — anchor the grid on it rather than on the device day.
    LaunchedEffect(zone) {
        val today = model.today()
        monthAnchor = today
        selectedDay = today
    }

    val visible = remember(rows, filterPerson) { model.filtered(filterPerson, rows) }
    val today = remember(zone) { model.today() }
    // One clock read per data change, not one per row — `isPast` is a per-row lookup after
    // this, never a fresh `Instant.now()` inside the list.
    val now = remember(visible) { Instant.now() }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .statusBarsPadding(),
    ) {
        CalendarHeader(
            mode = mode,
            monthAnchor = monthAnchor,
            zone = zone,
            onModeChange = { mode = it },
            onStepMonth = { monthAnchor = monthAnchor.plusMonths(it.toLong()) },
            onAdd = { editing = EditTarget.New(selectedDay) },
        )

        PersonFilterRow(
            members = members,
            selected = filterPerson,
            onSelect = { filterPerson = it },
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 18.dp,
                end = 18.dp,
                top = 8.dp,
                // Content scrolls UNDER the tab bar.
                bottom = WF.spacing.tabBarClearance,
            ),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when (mode) {
                CalMode.Agenda -> agendaContent(
                    groups = Agenda.upcoming(visible, today),
                    countdownsByDate = countdownItems,
                    today = today,
                    zone = zone,
                    now = now,
                    sleeps = sleeps,
                    onOpenEvent = { detailRow = it },
                    onOpenCountdown = { open(it, rows, { editingCountdown = it }, { detailRow = it }) },
                )

                CalMode.Month -> monthContent(
                    anchor = monthAnchor,
                    selectedDay = selectedDay,
                    today = today,
                    rows = visible,
                    countdownsByDate = countdownItems,
                    zone = zone,
                    now = now,
                    sleeps = sleeps,
                    model = model,
                    onSelectDay = { selectedDay = it },
                    onOpenEvent = { detailRow = it },
                    onOpenCountdown = { open(it, rows, { editingCountdown = it }, { detailRow = it }) },
                    onAddOnDay = { editing = EditTarget.New(it) },
                )
            }
        }
    }

    detailRow?.let { row ->
        EventDetailSheet(
            api = api,
            row = row,
            zone = zone,
            onDismiss = { detailRow = null },
            onEdit = {
                editing = EditTarget.Edit(row)
                detailRow = null
            },
        )
    }

    editing?.let { target ->
        EventEditSheet(
            api = api,
            zone = zone,
            members = members,
            event = (target as? EditTarget.Edit)?.row?.event,
            initialDate = when (target) {
                is EditTarget.New -> target.day
                is EditTarget.Edit -> target.row.day
            },
            onDismiss = { editing = null },
            onSaved = {
                editing = null
                // Events down-sync on their own, but the countdown list is REST and would
                // otherwise never hear that this event's "show a countdown" flag moved.
                scope.launch { countdowns.load() }
            },
        )
    }

    editingCountdown?.let { countdown ->
        EditCountdownSheet(
            countdown = countdown,
            onDismiss = { editingCountdown = null },
            onSave = { title, date, emoji -> countdowns.update(countdown, title, date, emoji) },
            onRemove = { countdowns.remove(countdown) },
        )
    }
}

/** What the editor sheet is creating or editing. */
private sealed interface EditTarget {
    data class New(val day: LocalDate) : EditTarget
    data class Edit(val row: EventRow) : EditTarget
}

/**
 * Route a tapped countdown: standalone → the inline editor; an event-sourced one (whose id
 * IS the event's) → that event's detail; a birthday → nowhere, it is managed on the
 * person's profile.
 */
private fun open(
    countdown: CalendarApi.Countdown,
    rows: Map<LocalDate, List<EventRow>>,
    edit: (CalendarApi.Countdown) -> Unit,
    show: (EventRow) -> Unit,
) {
    when (countdown.source) {
        "standalone" -> edit(countdown)
        "event" -> rows.values.asSequence().flatten().firstOrNull { it.id == countdown.id }?.let(show)
        else -> Unit
    }
}

// ---------------------------------------------------------------------------
// Header + filter
// ---------------------------------------------------------------------------

@Composable
private fun CalendarHeader(
    mode: CalMode,
    monthAnchor: LocalDate,
    zone: ZoneId,
    onModeChange: (CalMode) -> Unit,
    onStepMonth: (Int) -> Unit,
    onAdd: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (mode == CalMode.Month) {
            HeaderIcon(Icons.Filled.ChevronLeft, "Previous month") { onStepMonth(-1) }
        }
        Text(
            text = monthTitle(if (mode == CalMode.Agenda) LocalDate.now(zone) else monthAnchor, zone, mode),
            modifier = Modifier.weight(1f),
            style = if (mode == CalMode.Agenda) WF.type.hero else WF.type.title,
            color = WF.colors.ink,
            maxLines = 1,
        )
        if (mode == CalMode.Month) {
            HeaderIcon(Icons.Filled.ChevronRight, "Next month") { onStepMonth(1) }
        }
        ModeToggle(mode = mode, onChange = onModeChange)
        HeaderIcon(Icons.Filled.Add, "Add an event", tint = WF.colors.primary, onClick = onAdd)
    }
}

@Composable
private fun HeaderIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: Color = WF.colors.ink2,
    onClick: () -> Unit,
) {
    Icon(
        imageVector = icon,
        contentDescription = label,
        tint = tint,
        modifier = Modifier
            .size(30.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick)
            .padding(4.dp),
    )
}

/**
 * The Agenda/Month switch.
 *
 * Hand-rolled rather than a Material3 `SegmentedButton`: the segmented control is an
 * outlined, evenly-weighted control sized for a form row, and this has to sit in a title bar
 * beside a serif month name at icon scale. The tokens keep it consistent with the app's
 * other pills.
 */
@Composable
private fun ModeToggle(mode: CalMode, onChange: (CalMode) -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        modifier = Modifier
            .background(WF.colors.panel, shape)
            .clip(shape)
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (option in CalMode.entries) {
            val on = option == mode
            Icon(
                imageVector = if (option == CalMode.Agenda) {
                    Icons.AutoMirrored.Filled.FormatListBulleted
                } else {
                    Icons.Filled.CalendarMonth
                },
                contentDescription = option.label,
                tint = if (on) WF.colors.onInk else WF.colors.ink2,
                modifier = Modifier
                    .size(30.dp)
                    .background(if (on) WF.colors.ink else Color.Transparent, shape)
                    .clip(shape)
                    .clickable { onChange(option) }
                    .padding(7.dp),
            )
        }
    }
}

@Composable
private fun PersonFilterRow(
    members: List<Person>,
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    if (members.isEmpty()) return
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 18.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            FilterChip(label = "Everyone", selected = selected == null, onClick = { onSelect(null) }) {
                Icon(
                    imageVector = Icons.Filled.Group,
                    contentDescription = null,
                    tint = if (selected == null) WF.colors.onInk else WF.colors.ink2,
                    modifier = Modifier
                        .size(24.dp)
                        .background(
                            if (selected == null) WF.colors.onInk.copy(alpha = 0.22f) else WF.colors.panel,
                            CircleShape,
                        )
                        .padding(6.dp),
                )
            }
        }
        items(members, key = { it.id }) { member ->
            FilterChip(
                label = member.name,
                selected = selected == member.id,
                onClick = { onSelect(if (selected == member.id) null else member.id) },
            ) {
                Avatar(
                    emoji = member.displayEmoji,
                    tint = colorFromHex(member.colorHex)?.copy(alpha = 0.16f) ?: WF.colors.panel,
                    size = 24.dp,
                )
            }
        }
    }
}

/**
 * A filter pill: a glyph plus a name, filling with `ink` when on.
 *
 * Hand-rolled rather than reusing `Modifier.wfChip`, which tints at 12% and keeps ink text —
 * correct for a multi-select picker chip, but too quiet for a single-select filter that has
 * to announce "you are looking at one person". The `onInk` label is required here: the fill
 * IS `ink`, so a literal white would vanish in dark mode.
 */
@Composable
private fun FilterChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    leading: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        modifier = Modifier
            .background(if (selected) WF.colors.ink else WF.colors.card, shape)
            .then(if (selected) Modifier else Modifier.border(1.dp, WF.colors.hair, shape))
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(start = 6.dp, end = 14.dp, top = 7.dp, bottom = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(
            text = label,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            color = if (selected) WF.colors.onInk else WF.colors.ink2,
        )
    }
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

private fun androidx.compose.foundation.lazy.LazyListScope.agendaContent(
    groups: List<DayGroup>,
    countdownsByDate: Map<String, List<CalendarApi.Countdown>>,
    today: LocalDate,
    zone: ZoneId,
    now: Instant,
    sleeps: Boolean,
    onOpenEvent: (EventRow) -> Unit,
    onOpenCountdown: (CalendarApi.Countdown) -> Unit,
) {
    // Agenda days = event days ∪ countdown days from today forward, so a day carrying only
    // a countdown still appears. Countdowns behave like all-day events across every view.
    val eventDays = groups.associateBy { it.day }
    val countdownDays = countdownsByDate.keys.mapNotNull(CountdownFormat::parse)
        .filter { !it.isBefore(today) }
    val days = (eventDays.keys + countdownDays).sorted()

    if (days.isEmpty()) {
        item {
            WaffledEmptyState(
                emoji = "📅",
                title = "Nothing coming up",
                message = "Add an event and it'll show here, on every screen in the house.",
            )
        }
        return
    }

    for (day in days) {
        item(key = "heading-$day") {
            DayHeading(day = day, today = today, zone = zone)
        }
        items(eventDays[day]?.items.orEmpty(), key = { "event-${it.id}-$day" }) { row ->
            EventCard(row = row, isPast = Agenda.isPast(row, zone, now), onClick = { onOpenEvent(row) })
        }
        items(
            countdownsByDate[day.toString()].orEmpty(),
            key = { "countdown-${it.id}-$day" },
        ) { countdown ->
            CountdownCard(countdown = countdown, sleeps = sleeps, onClick = { onOpenCountdown(countdown) })
        }
    }
}

/** A day heading: a serif relative label ("Today") plus the grey date ("Sat · May 31"). */
@Composable
private fun DayHeading(day: LocalDate, today: LocalDate, zone: ZoneId) {
    val relative = when (day) {
        today -> "Today"
        today.plusDays(1) -> "Tomorrow"
        else -> WaffledDates.format(day.atStartOfDay(zone).toInstant(), "EEEE", zone)
    }
    Row(
        modifier = Modifier.padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Text(text = relative, style = WF.type.sectionTitle, color = WF.colors.ink)
        Text(
            text = WaffledDates.format(day.atStartOfDay(zone).toInstant(), "EEE · MMM d", zone),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
    }
}

// ---------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------

private fun androidx.compose.foundation.lazy.LazyListScope.monthContent(
    anchor: LocalDate,
    selectedDay: LocalDate,
    today: LocalDate,
    rows: Map<LocalDate, List<EventRow>>,
    countdownsByDate: Map<String, List<CalendarApi.Countdown>>,
    zone: ZoneId,
    now: Instant,
    sleeps: Boolean,
    model: CalendarModel,
    onSelectDay: (LocalDate) -> Unit,
    onOpenEvent: (EventRow) -> Unit,
    onOpenCountdown: (CalendarApi.Countdown) -> Unit,
    onAddOnDay: (LocalDate) -> Unit,
) {
    item(key = "month-grid") {
        MonthGrid(
            anchor = anchor,
            selectedDay = selectedDay,
            today = today,
            rows = rows,
            countdownsByDate = countdownsByDate,
            model = model,
            onSelectDay = onSelectDay,
        )
    }

    item(key = "month-day-heading") { DayHeading(day = selectedDay, today = today, zone = zone) }

    val dayRows = Agenda.forDay(rows, selectedDay)
    val dayCountdowns = countdownsByDate[selectedDay.toString()].orEmpty()

    if (dayRows.isEmpty() && dayCountdowns.isEmpty()) {
        item(key = "month-day-empty") {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onAddOnDay(selectedDay) }
                    .padding(vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = null,
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = "Add an event",
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
        return
    }

    items(dayRows, key = { "month-event-${it.id}" }) { row ->
        EventCard(row = row, isPast = Agenda.isPast(row, zone, now), onClick = { onOpenEvent(row) })
    }
    items(dayCountdowns, key = { "month-countdown-${it.id}" }) { countdown ->
        CountdownCard(countdown = countdown, sleeps = sleeps, onClick = { onOpenCountdown(countdown) })
    }
}

/**
 * Six weeks in a card, cut on the household's week start.
 *
 * A plain `Column` of `Row`s rather than a `LazyVerticalGrid`: the grid is exactly 42 cells,
 * always fully visible, and nesting a lazy grid inside the screen's `LazyColumn` needs a
 * fixed height anyway — so laziness buys nothing and costs a measurement constraint.
 */
@Composable
private fun MonthGrid(
    anchor: LocalDate,
    selectedDay: LocalDate,
    today: LocalDate,
    rows: Map<LocalDate, List<EventRow>>,
    countdownsByDate: Map<String, List<CalendarApi.Countdown>>,
    model: CalendarModel,
    onSelectDay: (LocalDate) -> Unit,
) {
    val weekStart by model.weekStart.collectAsStateWithLifecycle()
    val cells = remember(anchor, weekStart) { CalendarModel.monthCells(anchor, weekStart) }
    val initials = remember(weekStart) { CalendarModel.weekdayInitials(weekStart) }
    val shape = RoundedCornerShape(WF.radius.lg)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(Modifier.fillMaxWidth()) {
            for (initial in initials) {
                Text(
                    text = initial,
                    modifier = Modifier.weight(1f),
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black),
                    color = WF.colors.ink3,
                    textAlign = TextAlign.Center,
                )
            }
        }
        for (week in cells.chunked(initials.size)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (cell in week) {
                    MonthCell(
                        cell = cell,
                        isSelected = cell.date == selectedDay,
                        isToday = cell.date == today,
                        dots = model.dotColors(rows, cell.date),
                        countdowns = countdownsByDate[cell.date.toString()].orEmpty(),
                        modifier = Modifier.weight(1f),
                        onClick = { onSelectDay(cell.date) },
                    )
                }
            }
        }
    }
}

@Composable
private fun MonthCell(
    cell: CalendarModel.MonthCell,
    isSelected: Boolean,
    isToday: Boolean,
    dots: List<String>,
    countdowns: List<CalendarApi.Countdown>,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier = modifier
            .height(MonthCellHeight)
            .background(if (isSelected) WF.colors.primary.copy(alpha = 0.12f) else Color.Transparent, shape)
            .then(if (isSelected) Modifier.border(1.5.dp, WF.colors.primary, shape) else Modifier)
            .clip(shape)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = cell.dayOfMonth.toString(),
            style = TextStyle(
                fontSize = 14.sp,
                fontWeight = if (isToday) FontWeight.Black else FontWeight.SemiBold,
            ),
            color = when {
                !cell.inMonth -> WF.colors.ink3.copy(alpha = 0.5f)
                isToday -> WF.colors.primary
                else -> WF.colors.ink
            },
        )
        Spacer(Modifier.height(3.dp))
        // A countdown badge REPLACES the dots: a day that is counting down to something is
        // about that thing, and both at 8sp in a 44dp cell is unreadable. Tapping the day
        // still lists everything below.
        if (countdowns.isNotEmpty()) {
            CountdownBadge(countdowns)
        } else {
            Row(
                modifier = Modifier.height(5.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                for (hex in dots.take(MAX_DAY_DOTS)) {
                    Box(
                        Modifier
                            .size(5.dp)
                            .background(colorFromHex(hex) ?: WF.colors.ink3, CircleShape),
                    )
                }
            }
        }
    }
}

@Composable
private fun CountdownBadge(countdowns: List<CalendarApi.Countdown>) {
    val first = countdowns.first()
    Row(
        modifier = Modifier
            .background(WF.colors.warnT, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 3.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = first.emoji ?: "⏳", style = TextStyle(fontSize = 8.sp))
        Text(
            text = CountdownFormat.short(first.daysLeft),
            style = TextStyle(fontSize = 8.sp, fontWeight = FontWeight.Black),
            color = WF.colors.warn,
        )
        if (countdowns.size > 1) {
            Text(
                text = "+${countdowns.size - 1}",
                style = TextStyle(fontSize = 8.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink3,
            )
        }
    }
}

/** "June" in agenda mode (this year is implied); "June 2026" once you can page months. */
private fun monthTitle(date: LocalDate, zone: ZoneId, mode: CalMode): String =
    WaffledDates.format(
        date.atStartOfDay(zone).toInstant(),
        if (mode == CalMode.Agenda) "MMMM" else "MMMM yyyy",
        zone,
    )
