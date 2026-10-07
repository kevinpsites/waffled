package app.waffled.feature.kioskcalendar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.SegmentedRow
import app.waffled.core.design.WF
import app.waffled.core.model.Person
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CalendarModel
import app.waffled.feature.calendar.CountdownsModel
import app.waffled.feature.calendar.EditCountdownSheet
import app.waffled.feature.calendar.EventDetailSheet
import app.waffled.feature.calendar.EventEditSheet
import app.waffled.feature.calendar.EventRow
import app.waffled.feature.calendar.HorizontalSwipe
import app.waffled.feature.calendar.PeopleColumns
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDate

private typealias Mode = KioskCalendar.Mode

/**
 * The tablet Calendar page — Month (grid + day panel), Week and Day time grids, People
 * (one column per member) and Agenda. Twin of iOS `KioskCalendarView`; the rules live in
 * [KioskCalendar]. Pass the SAME [CalendarModel] / [CountdownsModel] instances the phone
 * calendar uses, so both read one event index.
 */
@Composable
fun KioskCalendarPage(
    model: CalendarModel,
    countdowns: CountdownsModel,
    api: CalendarApi,
    kioskApi: KioskCalendarApi,
    modifier: Modifier = Modifier,
) {
    val rows by model.rowsByDay.collectAsStateWithLifecycle()
    val members by model.members.collectAsStateWithLifecycle()
    val zone by model.zone.collectAsStateWithLifecycle()
    val weekStart by model.weekStart.collectAsStateWithLifecycle()
    val palette by model.palette.collectAsStateWithLifecycle()
    val countdownItems by countdowns.byDateState.collectAsStateWithLifecycle()
    val sleeps by countdowns.sleepsState.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    var mode by rememberSaveable { mutableStateOf(Mode.Month) }
    var pos by remember { mutableStateOf(KioskCalendar.jumpToToday(LocalDate.now())) }
    var miniAnchor by remember { mutableStateOf(LocalDate.now()) }
    var filterPerson by rememberSaveable { mutableStateOf<String?>(null) }
    var detailRow by remember { mutableStateOf<EventRow?>(null) }
    var editing by remember { mutableStateOf<EditTarget?>(null) }
    var editingCountdown by remember { mutableStateOf<CalendarApi.Countdown?>(null) }
    var headsUp by remember { mutableStateOf<KioskCalendarApi.HeadsUp?>(null) }

    LaunchedEffect(Unit) {
        model.refresh(api)
        countdowns.load()
    }
    // The household zone lands after first composition; "today" is only right once it has.
    LaunchedEffect(zone) {
        val today = model.today()
        pos = KioskCalendar.jumpToToday(today)
        miniAnchor = today
    }

    // Ticks, because a wall display runs across midnight and every "today" read must follow.
    val today by produceState(model.today(), zone) {
        value = model.today()
        while (true) {
            delay(60_000)
            value = model.today()
        }
    }
    val visible = remember(rows, filterPerson) { model.filtered(filterPerson, rows) }
    val openCountdown: (CalendarApi.Countdown) -> Unit = { c ->
        when (val target = KioskCalendar.route(c, rows)) {
            is KioskCalendar.CountdownTarget.Edit -> editingCountdown = target.countdown
            is KioskCalendar.CountdownTarget.Detail -> detailRow = target.row
            KioskCalendar.CountdownTarget.None -> Unit
        }
    }
    val step: (Int) -> Unit = { n -> pos = KioskCalendar.step(mode, pos, n) }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        Header(
            title = KioskCalendar.navTitle(mode, pos, today, weekStart),
            mode = mode,
            members = members,
            filterPerson = filterPerson,
            onStep = step,
            onToday = { pos = KioskCalendar.jumpToToday(today) },
            onMode = { mode = it },
            onAdd = { editing = EditTarget.New(pos.selectedDay) },
            onFilter = { filterPerson = it },
            modifier = Modifier.padding(start = 28.dp, end = 28.dp, top = 18.dp, bottom = 12.dp),
        )
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(start = 28.dp, end = 28.dp, bottom = 24.dp)
                .horizontalFlick(enabled = mode.showsSteppers, onStep = step),
        ) {
            when (mode) {
                Mode.Month -> Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    KioskMonthGrid(
                        anchor = pos.monthAnchor,
                        weekStart = weekStart,
                        byDay = visible,
                        countdownsByDate = countdownItems,
                        style = palette.style,
                        today = today,
                        selectedDay = pos.selectedDay,
                        onSelect = { pos = pos.copy(selectedDay = it) },
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                    )
                    KioskDayPanel(
                        day = pos.selectedDay,
                        today = today,
                        zone = zone,
                        rows = visible[pos.selectedDay].orEmpty(),
                        countdowns = countdownItems[pos.selectedDay.toString()].orEmpty(),
                        sleeps = sleeps,
                        onAdd = { editing = EditTarget.New(pos.selectedDay) },
                        onOpenEvent = { detailRow = it },
                        onOpenCountdown = openCountdown,
                        modifier = Modifier.width(340.dp),
                    )
                }

                Mode.Week -> {
                    val columns = remember(pos.selectedDay, weekStart, visible, countdownItems) {
                        KioskCalendar.weekDays(pos.selectedDay, weekStart).map { day ->
                            KioskGridColumn(
                                id = day.toString(),
                                events = visible[day].orEmpty(),
                                day = day,
                                countdowns = countdownItems[day.toString()].orEmpty(),
                            )
                        }
                    }
                    KioskTimeGrid(
                        columns = columns,
                        headers = KioskGridHeaders.Days,
                        zone = zone,
                        today = today,
                        style = palette.style,
                        showsNowLine = KioskCalendar.showsNowLine(columns.mapNotNull { it.day }, today),
                        scrollToHour = KioskCalendar.DEFAULT_OPENING_HOUR,
                        onTapEvent = { detailRow = it },
                        onTapCountdown = openCountdown,
                        onPickDay = {
                            pos = pos.copy(selectedDay = it)
                            mode = Mode.Day
                        },
                    )
                }

                Mode.Day -> {
                    val day = pos.selectedDay
                    val columns = remember(day, visible, countdownItems) {
                        listOf(
                            KioskGridColumn(
                                id = day.toString(),
                                events = visible[day].orEmpty(),
                                day = day,
                                countdowns = countdownItems[day.toString()].orEmpty(),
                            ),
                        )
                    }
                    KioskTimeGrid(
                        columns = columns,
                        headers = KioskGridHeaders.None,
                        zone = zone,
                        today = today,
                        style = palette.style,
                        showsNowLine = day == today,
                        scrollToHour = KioskCalendar.DEFAULT_OPENING_HOUR,
                        onTapEvent = { detailRow = it },
                        onTapCountdown = openCountdown,
                        onPickDay = {},
                    )
                }

                Mode.People -> PeopleContent(
                    // The UNFILTERED day on purpose: the columns are the per-person split.
                    dayRows = rows[pos.selectedDay].orEmpty(),
                    members = members,
                    zone = zone,
                    today = today,
                    selectedDay = pos.selectedDay,
                    style = palette.style,
                    onTapEvent = { detailRow = it },
                )

                Mode.Agenda -> {
                    val eventCount = rows.values.sumOf { it.size }
                    LaunchedEffect(eventCount, today, weekStart) {
                        val week = KioskCalendar.weekDays(today, weekStart)
                        headsUp = kioskApi.headsUp(week.first().toString(), week.last().toString())
                    }
                    KioskAgenda(
                        byDay = visible,
                        countdownsByDate = countdownItems,
                        sleeps = sleeps,
                        today = today,
                        zone = zone,
                        weekStart = weekStart,
                        members = members,
                        miniAnchor = miniAnchor,
                        headsUp = headsUp,
                        onStepMini = { miniAnchor = miniAnchor.plusMonths(it.toLong()) },
                        onPickDay = {
                            pos = pos.copy(selectedDay = it)
                            mode = Mode.Day
                        },
                        onOpenEvent = { detailRow = it },
                        onOpenCountdown = openCountdown,
                    )
                }
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
                // Countdowns are REST, so they don't hear an event's countdown flag move.
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

private sealed interface EditTarget {
    data class New(val day: LocalDate) : EditTarget
    data class Edit(val row: EventRow) : EditTarget
}

@Composable
private fun PeopleContent(
    dayRows: List<EventRow>,
    members: List<Person>,
    zone: java.time.ZoneId,
    today: LocalDate,
    selectedDay: LocalDate,
    style: app.waffled.feature.calendar.EventStyle,
    onTapEvent: (EventRow) -> Unit,
) {
    if (members.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Add family members to see per-person columns.", style = TextStyle(fontSize = 15.sp), color = WF.colors.ink3)
        }
        return
    }
    val columns = remember(dayRows, members) {
        PeopleColumns.build(dayRows, members).map { col ->
            KioskGridColumn(
                id = col.id,
                events = col.events,
                person = KioskGridColumn.PersonHeader(
                    name = col.name,
                    colorHex = col.colorHex,
                    emoji = col.avatarEmoji,
                    isEveryone = col.id == PeopleColumns.UNASSIGNED_ID,
                ),
            )
        }
    }
    KioskTimeGrid(
        columns = columns,
        headers = KioskGridHeaders.People,
        zone = zone,
        today = today,
        style = style,
        // Column keys are people, not dates, so the grid can't infer "today is visible".
        showsNowLine = selectedDay == today,
        scrollToHour = remember(dayRows) { KioskCalendar.peopleScrollHour(dayRows, zone) },
        onTapEvent = onTapEvent,
        onTapCountdown = {},
        onPickDay = {},
    )
}

/**
 * A sideways flick steps the calendar like the header chevrons. Horizontal drags only, so
 * the week / day grids still scroll vertically underneath.
 */
@Composable
private fun Modifier.horizontalFlick(enabled: Boolean, onStep: (Int) -> Unit): Modifier {
    val step by rememberUpdatedState(onStep)
    if (!enabled) return this
    return pointerInput(Unit) {
        var dx = 0f
        detectHorizontalDragGestures(
            onDragStart = { dx = 0f },
            // Thresholds are in dp; pointer deltas are pixels.
            onDragEnd = { HorizontalSwipe.step(dx / density, 0f)?.let(step) },
        ) { change, amount ->
            dx += amount
            change.consume()
        }
    }
}

@Composable
private fun Header(
    title: String,
    mode: Mode,
    members: List<Person>,
    filterPerson: String?,
    onStep: (Int) -> Unit,
    onToday: () -> Unit,
    onMode: (Mode) -> Unit,
    onAdd: () -> Unit,
    onFilter: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(
                Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(
                    text = title,
                    modifier = Modifier.weight(1f, fill = false),
                    style = WF.type.serif(34.sp),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (mode.showsSteppers) {
                    Chevron(Icons.Filled.ChevronLeft, "Previous") { onStep(-1) }
                    Chevron(Icons.Filled.ChevronRight, "Next") { onStep(1) }
                    TodayButton(onToday)
                }
            }
            SegmentedRow(
                options = Mode.entries.map { it.label },
                selectedIndex = mode.ordinal,
                onSelect = { onMode(Mode.entries[it]) },
                modifier = Modifier.width(320.dp),
            )
            AddEventButton(onAdd)
        }
        if (mode.showsPersonFilter) PersonFilter(members, filterPerson, onFilter)
    }
}

@Composable
private fun Chevron(icon: ImageVector, label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(WF.colors.card, CircleShape)
            .border(1.dp, WF.colors.hair, CircleShape)
            .clickable(onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = WF.colors.ink2, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun TodayButton(onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Text(
        text = "Today",
        modifier = Modifier
            .clip(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.ink2,
        maxLines = 1,
        softWrap = false,
    )
}

@Composable
private fun AddEventButton(onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .clip(shape)
            .background(WF.colors.primary, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // White on the saturated coral fill, which stays coral in both themes.
        Icon(Icons.Filled.Add, contentDescription = null, tint = Color.White, modifier = Modifier.size(17.dp))
        Text(
            text = "Add event",
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            color = Color.White,
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
private fun PersonFilter(members: List<Person>, selected: String?, onSelect: (String?) -> Unit) {
    LazyRow(Modifier.fillMaxWidth().height(36.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            FilterChip("Everyone", selected == null, { onSelect(null) }) {
                EveryoneGlyph(
                    size = 22.dp,
                    tint = if (selected == null) WF.colors.onInk else WF.colors.ink2,
                    fill = if (selected == null) WF.colors.onInk.copy(alpha = 0.22f) else WF.colors.panel,
                )
            }
        }
        items(members, key = { it.id }) { m ->
            FilterChip(m.name, selected == m.id, { onSelect(m.id) }) {
                AvatarFromHex(colorHex = m.colorHex, emoji = m.avatarEmoji ?: "🙂", size = 22.dp)
            }
        }
    }
}

/**
 * A filter pill that fills with `ink` when on. Hand-rolled for the same reason as the phone
 * calendar's: `Modifier.wfChip` tints at 12%, too quiet for a single-select filter. The
 * label is `onInk` because the fill IS `ink`.
 */
@Composable
private fun FilterChip(label: String, on: Boolean, onClick: () -> Unit, leading: @Composable () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .clip(shape)
            .background(if (on) WF.colors.ink else WF.colors.card, shape)
            .then(if (on) Modifier else Modifier.border(1.dp, WF.colors.hair, shape))
            .clickable(onClick = onClick)
            .padding(start = 6.dp, end = 13.dp, top = 6.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(
            text = label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            color = if (on) WF.colors.onInk else WF.colors.ink2,
        )
    }
}
