package app.waffled.feature.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.Avatar
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.LockNote
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfChip
import app.waffled.core.model.Person
import app.waffled.core.network.WaffledApiException
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * Whether the rich REST detail an edit depends on has arrived.
 *
 * Not cosmetic: the synced mirror knows neither who is on an event nor whether it repeats,
 * so a save issued before this resolves would strip participants and could target the wrong
 * row entirely.
 */
private sealed interface DetailState {
    data object Loading : DetailState
    data object Ready : DetailState

    /** Loaded and refused, or an id this server does not recognise. */
    data class Blocked(val reason: String) : DetailState
}

/** Which occurrences an edit to a recurring event applies to. */
enum class EditScope(val wire: String, val label: String) {
    This("this", "This event"),
    Following("following", "This and following"),
    All("all", "All events"),
}

/**
 * Create or edit a calendar event.
 *
 * ⚠️ The READ-ONLY GATE lives here, on the sheet, and not on the screens that present it.
 * The detail view is only one route in, and gating each call site is only ever as complete
 * as whoever enumerated them — that is exactly how a feed event stayed editable on iOS.
 *
 * Writes go over REST ([CalendarApi]), which is also where iOS routes anything recurring or
 * goal-linked; PowerSync down-syncs the result for display. See the port report for why the
 * local-mirror write path isn't available to a feature module yet.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EventEditSheet(
    api: CalendarApi,
    zone: ZoneId,
    members: List<Person>,
    /** The event being edited, or null to create one. */
    event: SyncedEvent?,
    /** The day a create starts on — the tapped cell, or today. */
    initialDate: LocalDate,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
    /** A create's start time — the tapped hour on the Day grid; the editor's default otherwise. */
    initialTime: LocalTime? = null,
) {
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val locked = EventOrigin.blocksEditing(event)

    var draft by remember {
        mutableStateOf(
            EventDraft.seed(event, initialDate, zone).let { seeded ->
                if (event == null && initialTime != null) seeded.copy(startTime = initialTime) else seeded
            },
        )
    }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf<WhenPick?>(null) }
    var askingScope by remember { mutableStateOf<ScopeQuestion?>(null) }
    // Creating an event needs no detail; editing one does.
    var detailState by remember(event?.id) {
        mutableStateOf<DetailState>(if (event == null) DetailState.Ready else DetailState.Loading)
    }

    // ⚠️ The synced mirror carries NO participants — nothing joins `event_participants` —
    // so an edit seeded from it alone would post an empty list and silently strip everyone
    // off the event. Only the rich REST detail knows who is on it, so Save stays blocked
    // until that detail lands. Refusing to save is the safe failure here; saving on a guess
    // is data loss that reports success.
    LaunchedEffect(event?.id) {
        val id = draft.editId ?: return@LaunchedEffect
        detailState = runCatching { api.eventDetail(id) }.fold(
            onSuccess = { detail ->
                val participants = detail.participants.map { it.id }
                    .ifEmpty { listOfNotNull(detail.personId) }
                draft = draft.copy(
                    personIds = participants,
                    repeat = Recurrence.parseRepeat(detail.rrule),
                    originalRrule = detail.rrule,
                    goalId = detail.goalId,
                    goalStepId = detail.goalStepId,
                    isRecurring = draft.isRecurring || !detail.rrule.isNullOrEmpty(),
                ).withSeriesBaseline(
                    // The baseline the scope rule compares against. Without it every edit
                    // looks series-changing and "just this one" is never offered.
                    RecurringEventSeriesFields(
                        allDay = detail.allDay,
                        isCountdown = draft.isCountdown,
                        participantIds = participants,
                        goalId = detail.goalId,
                        goalStepId = detail.goalStepId,
                        rrule = detail.rrule,
                        recurrenceEndAt = detail.recurrenceEndAt,
                    ),
                )
                DetailState.Ready
            },
            onFailure = { failure ->
                DetailState.Blocked(
                    (failure as? WaffledApiException)?.userMessage
                        ?: "Couldn't load this event's details, so it can't be edited safely right now.",
                )
            },
        )
    }

    fun save(editScope: EditScope?) {
        busy = true
        error = null
        scope.launch {
            val result = runCatching {
                val startIso = draft.startInstant(zone).toString()
                val endIso = draft.endInstant(zone)?.toString()
                val editId = draft.editId
                if (editId == null) {
                    val rrule = Recurrence.buildRrule(draft.repeat, draft.date)
                    api.createEvent(
                        title = draft.title.trim(),
                        startsAtIso = startIso,
                        endsAtIso = endIso,
                        allDay = draft.allDay,
                        location = draft.location.trim().takeIf { it.isNotEmpty() },
                        personIds = draft.personIds,
                        timezone = zone.id,
                        rrule = rrule,
                        isCountdown = draft.isCountdown,
                    )
                } else {
                    api.updateEvent(
                        id = editId,
                        title = draft.title.trim(),
                        startsAtIso = startIso,
                        endsAtIso = endIso,
                        allDay = draft.allDay,
                        location = draft.location.trim().takeIf { it.isNotEmpty() },
                        personIds = draft.personIds,
                        goalId = draft.goalId,
                        goalStepId = draft.goalStepId,
                        rrule = draft.seriesRrule(editScope),
                        clearRrule = draft.clearsRrule(editScope),
                        scope = editScope?.wire,
                        // The ORIGINAL start, never the edited one — it is how the
                        // server picks which occurrence to override.
                        occurrenceStart = editScope?.let { draft.occurrenceStartIso },
                        isCountdown = draft.isCountdown,
                    )
                }
            }
            result
                .onSuccess { onSaved() }
                .onFailure { failure ->
                    error = (failure as? WaffledApiException)?.userMessage
                        ?: "Couldn't save this event. Check your connection and try again."
                    busy = false
                }
        }
    }

    // A recurring delete without a scope drops the whole series, so it always asks first.
    fun delete(editScope: EditScope?) {
        val id = draft.editId ?: return
        busy = true
        error = null
        scope.launch {
            runCatching { api.deleteEvent(id, editScope?.wire, editScope?.let { draft.occurrenceStartIso }) }
                .onSuccess { onSaved() }
                .onFailure { failure ->
                    error = (failure as? WaffledApiException)?.userMessage
                        ?: "Couldn't delete this event."
                    busy = false
                }
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                text = if (event == null) "New event" else "Edit event",
                style = WF.type.title,
                color = WF.colors.ink,
            )

            if (locked) LockNote(text = EventOrigin.READ_ONLY_NOTE)

            error?.let { DismissibleErrorBanner(message = it, onDismiss = { error = null }) }

            WaffledFieldCard(title = "Title") {
                OutlinedTextField(
                    value = draft.title,
                    onValueChange = { draft = draft.copy(title = it) },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("e.g. Dentist") },
                    singleLine = true,
                    enabled = !locked,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
            }

            WaffledFieldCard(title = "When") {
                ToggleRow(
                    label = "All day",
                    checked = draft.allDay,
                    enabled = !locked,
                    onChange = { draft = draft.copy(allDay = it) },
                )
                // Starts and Ends share one shape: a day pill, plus a time pill when timed.
                val end = draft.timedEnd(zone)
                WhenRow(label = "Starts") {
                    ValueButton(EventEnd.dayLabel(draft.date), !locked, Modifier.weight(1f)) {
                        picking = WhenPick.StartDay
                    }
                    if (!draft.allDay) {
                        ValueButton(EventEnd.timeLabel(draft.startTime), !locked, Modifier.weight(1f)) {
                            picking = WhenPick.StartTime
                        }
                    }
                }
                WhenRow(label = "Ends") {
                    if (draft.allDay) {
                        ValueButton(EventEnd.dayLabel(draft.lastDay), !locked, Modifier.weight(1f)) {
                            picking = WhenPick.EndDay
                        }
                    } else {
                        ValueButton(EventEnd.dayLabel(end.toLocalDate()), !locked, Modifier.weight(1f)) {
                            picking = WhenPick.EndDay
                        }
                        ValueButton(EventEnd.timeLabel(end.toLocalTime()), !locked, Modifier.weight(1f)) {
                            picking = WhenPick.EndTime
                        }
                    }
                }
            }

            if (members.isNotEmpty()) {
                WaffledFieldCard(title = "Who") {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        for (member in members) {
                            PersonChip(
                                person = member,
                                selected = member.id in draft.personIds,
                                enabled = !locked,
                                onToggle = {
                                    draft = draft.copy(
                                        personIds = if (member.id in draft.personIds) {
                                            draft.personIds - member.id
                                        } else {
                                            draft.personIds + member.id
                                        },
                                    )
                                },
                            )
                        }
                    }
                }
            }

            WaffledFieldCard(title = "Where") {
                OutlinedTextField(
                    value = draft.location,
                    onValueChange = { draft = draft.copy(location = it) },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Optional") },
                    singleLine = true,
                    enabled = !locked,
                )
            }

            RepeatField(
                repeat = draft.repeat,
                start = draft.date,
                enabled = !locked,
                onChange = { draft = draft.copy(repeat = it) },
            )

            WaffledFieldCard(title = "Countdown") {
                ToggleRow(
                    label = "Show a countdown to this",
                    checked = draft.isCountdown,
                    enabled = !locked,
                    onChange = { draft = draft.copy(isCountdown = it) },
                )
            }

            (detailState as? DetailState.Blocked)?.let { LockNote(text = it.reason) }

            if (!locked) {
                WaffledPrimaryCTA(
                    label = when {
                        busy -> "Saving…"
                        detailState is DetailState.Loading -> "Loading…"
                        else -> "Save"
                    },
                    onClick = {
                        // A recurring occurrence needs to know WHICH occurrences to touch;
                        // a one-off can just save.
                        if (draft.isRecurring) askingScope = ScopeQuestion.Save else save(null)
                    },
                    isBusy = busy,
                    isDisabled = !draft.canSave || detailState !is DetailState.Ready,
                )
            }

            if (event != null && !locked && detailState is DetailState.Ready) {
                TextButton(
                    onClick = { if (draft.isRecurring) askingScope = ScopeQuestion.Delete else delete(null) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !busy,
                ) {
                    Icon(Icons.Filled.Delete, contentDescription = null, tint = WF.colors.danger)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "Delete event",
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.danger,
                    )
                }
            }
        }
    }

    val end = draft.timedEnd(zone)
    when (picking) {
        WhenPick.StartDay -> WaffledDatePickerDialog(
            initial = draft.date,
            onDismiss = { picking = null },
            onPick = {
                draft = draft.withDate(it)
                picking = null
            },
        )
        WhenPick.StartTime -> TimePickerDialog(
            initial = draft.startTime,
            onDismiss = { picking = null },
            onPick = {
                draft = draft.copy(startTime = it)
                picking = null
            },
        )
        WhenPick.EndDay -> WaffledDatePickerDialog(
            initial = if (draft.allDay) draft.lastDay else end.toLocalDate(),
            onDismiss = { picking = null },
            onPick = {
                draft = if (draft.allDay) draft.withLastDay(it) else draft.withTimedEnd(it, end.toLocalTime(), zone)
                picking = null
            },
        )
        WhenPick.EndTime -> TimePickerDialog(
            initial = end.toLocalTime(),
            onDismiss = { picking = null },
            onPick = {
                draft = draft.withTimedEnd(end.toLocalDate(), it, zone)
                picking = null
            },
        )
        null -> Unit
    }

    askingScope?.let { question ->
        ScopeDialog(
            // A per-occurrence override can only carry title/start/end/location, so once a
            // series field moved, "just this one" is not on the menu — offering it would
            // appear to save and then quietly not apply.
            allowSingle = question == ScopeQuestion.Delete || draft.seriesUnchanged(),
            deleting = question == ScopeQuestion.Delete,
            onDismiss = { askingScope = null },
            onPick = {
                askingScope = null
                if (question == ScopeQuestion.Delete) delete(it) else save(it)
            },
        )
    }
}

/** Which action the "which occurrences?" dialog is scoping. */
private enum class ScopeQuestion { Save, Delete }

/** Which When pill has its picker open. */
private enum class WhenPick { StartDay, StartTime, EndDay, EndTime }

@Composable
private fun WhenRow(label: String, pills: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = label,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), content = pills)
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 15.sp),
            color = WF.colors.ink,
        )
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

/**
 * A tappable value in a field card.
 *
 * Hand-rolled over `TextButton` because the value must read as INK (it is content, not an
 * action) and stay left-aligned inside the field's fill — a text button centres its label
 * and tints it with the theme's primary, which would make the date read as a link.
 */
@Composable
private fun ValueButton(
    text: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.sm)
    Box(
        modifier = modifier
            .background(WF.colors.panel, shape)
            .clip(shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Text(
            text = text,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = if (enabled) WF.colors.ink else WF.colors.ink3,
        )
    }
}

@Composable
private fun PersonChip(person: Person, selected: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .wfChip(selected = selected, tint = colorFromHex(person.colorHex) ?: WF.colors.primary)
            .clickable(enabled = enabled, onClick = onToggle)
            .padding(start = 5.dp, end = 12.dp, top = 5.dp, bottom = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(
            emoji = person.displayEmoji,
            tint = colorFromHex(person.colorHex)?.copy(alpha = 0.16f) ?: WF.colors.panel,
            size = 24.dp,
        )
        Text(
            text = person.name,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = if (selected) WF.colors.ink else WF.colors.ink2,
        )
    }
}

/**
 * The "Repeats" picker: the four presets plus a live plain-English summary.
 *
 * The custom builder's full surface (every N days/weeks/months, weekday chips, nth-weekday)
 * is deliberately not on the phone sheet — `Recurrence` parses and PRESERVES any rule it
 * can't offer, so an event made custom-recurring elsewhere round-trips through this editor
 * untouched rather than being flattened on save.
 */
@Composable
private fun RepeatField(
    repeat: RepeatState,
    start: LocalDate,
    enabled: Boolean,
    onChange: (RepeatState) -> Unit,
) {
    val presets = listOf(
        RepeatFreq.None to "Never",
        RepeatFreq.Daily to "Daily",
        RepeatFreq.Weekdays to "Weekdays",
        RepeatFreq.Weekly to "Weekly",
        RepeatFreq.Monthly to "Monthly",
    )
    WaffledFieldCard(title = "Repeats") {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((freq, label) in presets) {
                Text(
                    text = label,
                    modifier = Modifier
                        .weight(1f)
                        .wfChip(selected = repeat.freq == freq)
                        .clickable(enabled = enabled) { onChange(RepeatState(freq = freq)) }
                        .padding(vertical = 7.dp),
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                    color = if (repeat.freq == freq) WF.colors.ink else WF.colors.ink2,
                )
            }
        }
        Text(
            text = Recurrence.describeRrule(Recurrence.buildRrule(repeat, start), start),
            style = TextStyle(fontSize = 12.sp),
            color = WF.colors.ink3,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimePickerDialog(initial: LocalTime, onDismiss: () -> Unit, onPick: (LocalTime) -> Unit) {
    val state = rememberTimePickerState(initialHour = initial.hour, initialMinute = initial.minute)
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = { onPick(LocalTime.of(state.hour, state.minute)) }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        text = { TimePicker(state = state) },
    )
}

/** Which occurrences to apply an edit to. */
@Composable
private fun ScopeDialog(
    allowSingle: Boolean,
    deleting: Boolean,
    onDismiss: () -> Unit,
    onPick: (EditScope) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("This is a repeating event") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = if (deleting) {
                        "Which occurrences should be deleted?"
                    } else if (allowSingle) {
                        "Which occurrences should change?"
                    } else {
                        "You changed something that applies to the whole series, so this can't be saved for one occurrence only."
                    },
                    style = TextStyle(fontSize = 14.sp),
                    color = WF.colors.ink2,
                )
                for (option in EditScope.entries) {
                    if (option == EditScope.This && !allowSingle) continue
                    Text(
                        text = option.label,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(option) }
                            .padding(vertical = 12.dp),
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
