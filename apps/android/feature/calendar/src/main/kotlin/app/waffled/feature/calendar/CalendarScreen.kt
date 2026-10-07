package app.waffled.feature.calendar

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
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
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.ViewDay
import androidx.compose.material.icons.filled.ViewWeek
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.Avatar
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

private typealias CalMode = PhoneCalendar.Mode

private const val PREFS = "waffled.calendar"
private const val MODE_KEY = "waffled.calendarMode"

/**
 * The Calendar tab on a phone: Month is home and fills the screen, a tapped day drills into
 * Day, and the header's view menu (or a pinch) switches between Month, Week, Day and Agenda.
 * Twin of iOS `CalendarView`; the screens live in [EventMonthGrid], [PhoneWeekRail] and
 * [PhoneDayTimeline], their rules in [PhoneCalendar].
 *
 * Events arrive over PowerSync through [CalendarModel], already ordered and labelled; every
 * view reads the same person-filtered index. Countdowns are REST and draw as all-day items.
 */
@Composable
fun CalendarScreen(
    model: CalendarModel,
    countdowns: CountdownsModel,
    api: CalendarApi,
    modifier: Modifier = Modifier,
    /** The Meals module flag: the Week cards close on tonight's dinner only when it is on. */
    mealsEnabled: Boolean = true,
) {
    val rows by model.rowsByDay.collectAsStateWithLifecycle()
    val members by model.members.collectAsStateWithLifecycle()
    val zone by model.zone.collectAsStateWithLifecycle()
    val weekStart by model.weekStart.collectAsStateWithLifecycle()
    val palette by model.palette.collectAsStateWithLifecycle()
    val loadError by model.loadError.collectAsStateWithLifecycle()
    val countdownItems by countdowns.byDateState.collectAsStateWithLifecycle()
    val sleeps by countdowns.sleepsState.collectAsStateWithLifecycle()

    val scope = rememberCoroutineScope()
    val prefs = LocalContext.current.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // Remembered across launches, so your preferred view sticks. Day is a drill-in on top.
    var root by rememberSaveable {
        mutableStateOf(CalMode.restored(stored = CalMode.fromWire(prefs.getString(MODE_KEY, null)) ?: CalMode.Month, override = null))
    }
    var showsDay by rememberSaveable { mutableStateOf(false) }
    val mode = if (showsDay) CalMode.Day else root
    var filterPerson by rememberSaveable { mutableStateOf<String?>(null) }
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
    // it lands — anchor on it rather than on the device day.
    LaunchedEffect(zone) {
        val today = model.today()
        monthAnchor = today
        selectedDay = today
    }

    // The root, not `mode`: remembering a tapped-open Day would reopen the tab on it.
    LaunchedEffect(root) { prefs.edit().putString(MODE_KEY, root.wire).apply() }

    // Month pages by `monthAnchor`, Week by `selectedDay`; switching carries the position
    // across so you land on the same stretch of time.
    fun show(target: CalMode) {
        if (target == CalMode.Day) {
            showsDay = true
            return
        }
        if (target == CalMode.Month && root != CalMode.Month) monthAnchor = selectedDay
        if (target == CalMode.Week && root == CalMode.Month && !showsDay) {
            selectedDay = PhoneCalendar.focusDay(selectedDay, monthAnchor, model.today())
        }
        if (showsDay) monthAnchor = selectedDay
        root = target
        showsDay = false
    }

    // Back from a Day you paged through lands on that day's month.
    BackHandler(enabled = showsDay) {
        showsDay = false
        monthAnchor = selectedDay
    }

    val visible = remember(rows, filterPerson) { model.filtered(filterPerson, rows) }
    val today = remember(zone) { model.today() }
    val openCountdown: (CalendarApi.Countdown) -> Unit = {
        open(it, rows, { c -> editingCountdown = c }, { r -> detailRow = r })
    }
    val onAdd = { editing = EditTarget.New(if (mode == CalMode.Agenda) model.today() else selectedDay) }

    val menu: @Composable () -> Unit = {
        ViewMenu(
            mode = mode,
            members = members,
            filterPerson = filterPerson,
            onShow = ::show,
            onFilter = { filterPerson = it },
        )
    }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .statusBarsPadding(),
    ) {
        loadError?.let {
            Box(Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) {
                DismissibleErrorBanner(message = it, onDismiss = model::clearLoadError)
            }
        }

        when {
            showsDay -> Column(Modifier.fillMaxSize().calendarPinchZoom { show(mode.zoomed(it)) }) {
                DayTopBar(
                    backLabel = WaffledDates.format(selectedDay.atStartOfDay(zone).toInstant(), "MMMM", zone),
                    onBack = {
                        showsDay = false
                        monthAnchor = selectedDay
                    },
                    menu = menu,
                    onAdd = onAdd,
                )
                PhoneDayTimeline(
                    day = selectedDay,
                    zone = zone,
                    rows = visible[selectedDay].orEmpty(),
                    countdowns = countdownItems[selectedDay.toString()].orEmpty(),
                    isToday = selectedDay == today,
                    style = palette.style,
                    onTapEvent = { detailRow = it },
                    onTapCountdown = openCountdown,
                    onAddAt = { hour -> editing = EditTarget.New(selectedDay, LocalTime.of(minOf(hour, 23), 0)) },
                    onSwipeDay = { selectedDay = selectedDay.plusDays(it.toLong()) },
                    modifier = Modifier.weight(1f),
                )
            }

            root == CalMode.Week -> Column(Modifier.fillMaxSize().calendarPinchZoom { show(mode.zoomed(it)) }) {
                val days = remember(selectedDay, weekStart) { PhoneCalendar.weekDays(selectedDay, weekStart) }
                CalendarHeader(menu = menu, onAdd = onAdd) {
                    Text(
                        text = PhoneCalendar.weekTitle(days),
                        style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                        maxLines = 1,
                    )
                }
                PhoneWeekRail(
                    selectedDay = selectedDay,
                    onSelect = { selectedDay = it },
                    weekStart = weekStart,
                    zone = zone,
                    today = today,
                    byDay = visible,
                    countdownsByDate = countdownItems,
                    style = palette.style,
                    mealsEnabled = mealsEnabled,
                    onEditEvent = { editing = EditTarget.Edit(it) },
                    onTapCountdown = openCountdown,
                    modifier = Modifier.weight(1f),
                )
            }

            root == CalMode.Agenda -> {
                CalendarHeader(menu = menu, onAdd = onAdd) {
                    Text(
                        text = WaffledDates.format(Instant.now(), "MMMM", zone),
                        style = WF.type.serif(30.sp),
                        color = WF.colors.ink,
                        maxLines = 1,
                    )
                }
                PersonFilterRow(members = members, selected = filterPerson, onSelect = { filterPerson = it })
                // One clock read per data change, not one per row.
                val now = remember(visible) { Instant.now() }
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 8.dp, bottom = WF.spacing.tabBarClearance),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    agendaContent(
                        groups = Agenda.upcoming(visible, today),
                        countdownsByDate = countdownItems,
                        today = today,
                        zone = zone,
                        now = now,
                        sleeps = sleeps,
                        onOpenEvent = { detailRow = it },
                        onOpenCountdown = openCountdown,
                    )
                }
            }

            else -> Column(Modifier.fillMaxSize().calendarPinchZoom { show(mode.zoomed(it)) }) {
                CalendarHeader(menu = menu, onAdd = onAdd) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = WaffledDates.format(monthAnchor.atStartOfDay(zone).toInstant(), "MMMM", zone),
                            modifier = Modifier.alignByBaseline(),
                            style = WF.type.serif(25.sp),
                            color = WF.colors.ink,
                            maxLines = 1,
                        )
                        Text(
                            text = "${monthAnchor.year}",
                            modifier = Modifier.alignByBaseline(),
                            style = WF.type.serif(25.sp, FontWeight.Normal),
                            color = WF.colors.ink3,
                            maxLines = 1,
                        )
                    }
                }
                val monthRows = remember(monthAnchor, weekStart) { PhoneCalendar.monthRows(monthAnchor, weekStart) }
                EventMonthGrid(
                    rows = monthRows,
                    weekStart = weekStart,
                    zone = zone,
                    byDay = visible,
                    countdownsByDate = countdownItems,
                    style = palette.style,
                    today = today,
                    selectedDay = selectedDay,
                    onPick = {
                        selectedDay = it
                        show(CalMode.Day)
                    },
                    modifier = Modifier
                        .weight(1f)
                        .calendarFlick { monthAnchor = monthAnchor.plusMonths(it.toLong()) },
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
            initialTime = (target as? EditTarget.New)?.time,
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
    data class New(val day: LocalDate, val time: LocalTime? = null) : EditTarget
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
// Header, view menu, add
// ---------------------------------------------------------------------------

@Composable
private fun CalendarHeader(
    menu: @Composable () -> Unit,
    onAdd: () -> Unit,
    title: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.weight(1f), content = title)
        menu()
        AddButton(onAdd)
    }
}

/** The pushed Day's bar: back to the month by name ("‹ September"), then the same actions. */
@Composable
private fun DayTopBar(backLabel: String, onBack: () -> Unit, menu: @Composable () -> Unit, onAdd: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .padding(start = 6.dp, end = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .clip(RoundedCornerShape(WF.radius.sm))
                .clickable(onClick = onBack)
                .padding(end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.ChevronLeft, contentDescription = null, tint = WF.colors.primary, modifier = Modifier.size(28.dp))
            Text(text = backLabel, style = TextStyle(fontSize = 17.sp), color = WF.colors.primary)
        }
        Spacer(Modifier.weight(1f))
        menu()
        AddButton(onAdd)
    }
}

private fun CalMode.icon(): ImageVector = when (this) {
    CalMode.Month -> Icons.Filled.CalendarMonth
    CalMode.Week -> Icons.Filled.ViewWeek
    CalMode.Day -> Icons.Filled.ViewDay
    CalMode.Agenda -> Icons.AutoMirrored.Filled.FormatListBulleted
}

/**
 * The view switcher: its icon names the current view, and the menu also holds the
 * per-person filter, marked by a dot while one is on. A Material `DropdownMenu` stands in
 * for the iOS inline-picker `Menu`.
 */
@Composable
private fun ViewMenu(
    mode: CalMode,
    members: List<Person>,
    filterPerson: String?,
    onShow: (CalMode) -> Unit,
    onFilter: (String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(WF.colors.card, CircleShape)
                .border(1.dp, WF.colors.hair, CircleShape)
                .clickable { open = true }
                .semantics {
                    contentDescription = "${mode.label} view"
                    stateDescription = if (filterPerson == null) "Everyone" else "Filtered to one person"
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(mode.icon(), contentDescription = null, tint = WF.colors.ink2, modifier = Modifier.size(17.dp))
        }
        if (filterPerson != null) {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .offset(x = 1.dp, y = (-1).dp)
                    .size(9.dp)
                    .background(WF.colors.canvas, CircleShape)
                    .padding(1.5.dp)
                    .background(WF.colors.primary, CircleShape),
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            MenuSection("View")
            for (m in CalMode.entries) {
                DropdownMenuItem(
                    text = { Text(m.label) },
                    leadingIcon = { Icon(m.icon(), contentDescription = null) },
                    trailingIcon = { if (m == mode) Icon(Icons.Filled.Check, contentDescription = "Selected") },
                    onClick = {
                        open = false
                        onShow(m)
                    },
                )
            }
            HorizontalDivider(color = WF.colors.hair)
            MenuSection("Show")
            DropdownMenuItem(
                text = { Text("Everyone") },
                leadingIcon = { Icon(Icons.Filled.Group, contentDescription = null) },
                trailingIcon = { if (filterPerson == null) Icon(Icons.Filled.Check, contentDescription = "Selected") },
                onClick = {
                    open = false
                    onFilter(null)
                },
            )
            for (member in members) {
                DropdownMenuItem(
                    text = { Text(member.name) },
                    trailingIcon = {
                        if (filterPerson == member.id) Icon(Icons.Filled.Check, contentDescription = "Selected")
                    },
                    onClick = {
                        open = false
                        onFilter(member.id)
                    },
                )
            }
        }
    }
}

@Composable
private fun MenuSection(title: String) {
    Text(
        text = title,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink3,
    )
}

@Composable
private fun AddButton(onAdd: () -> Unit) {
    Box(
        Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(WF.colors.primary, CircleShape)
            .clickable(onClick = onAdd)
            .semantics { contentDescription = "New event" },
        contentAlignment = Alignment.Center,
    ) {
        // White on the saturated coral fill, which stays coral in both themes.
        Icon(Icons.Filled.Add, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
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
