package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TimeInput
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import app.waffled.feature.calendar.EventPalette
import app.waffled.feature.familynight.FamilyNightApi
import app.waffled.feature.familynight.FamilyNightBodies
import app.waffled.feature.familynight.FamilyNightFormat
import app.waffled.feature.planning.PlanningEventChip
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.PlanningFamilyNightApi
import app.waffled.feature.planning.api.PlanningFamilyNightBoard
import app.waffled.feature.planning.api.PlanningFamilyNightMember
import app.waffled.feature.planning.api.PlanningFamilyNightPart
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Weekly Planning · step 4 "Family night" — "Accept the rotation, or change it?" Port of
 * iOS `FamilyNightStepView`. The affirmative writes nothing; every decision goes through
 * the familyNight module's OCCURRENCE endpoint: a face pins a part for THIS week, the
 * theme and each part's "what" save on focus loss, and Skip calls off the gathering —
 * never the recurring event. Skip sits in the body so it and its Undo stay together.
 */
@Composable
fun FamilyNightStepBody(props: PlanningStepProps) {
    val model = remember(props.env) {
        PlanningFamilyNightModel(
            PlanningFamilyNightApi(props.env.http),
            FamilyNightApi(props.env.client, props.env.tokens),
        )
    }
    val state by model.state.collectAsStateWithLifecycle()
    val members by props.env.sync.members.collectAsStateWithLifecycle()
    val zone by props.env.sync.householdZone.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var picking by remember { mutableStateOf(false) }
    var addingEvent by remember { mutableStateOf(false) }
    val disabled = props.busy || state.busy

    LaunchedEffect(props.weekStart) { model.load(props.weekStart) }
    // Kept in step with every read and write, so the affirmative writes back what is true.
    LaunchedEffect(state.rev) { if (state.rev > 0) props.setDecisionData(state.crumb) }
    LaunchedEffect(state.busy) { props.reportBusy(state.busy) }
    DisposableEffect(Unit) {
        props.lendVerb(null)
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    fun save(body: JsonObject) {
        scope.launch { if (model.write(body, props.weekStart)) props.refresh() }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }
        val board = state.board
        when {
            board != null -> {
                Gathering(
                    board = board,
                    state = state,
                    disabled = disabled,
                    picking = picking,
                    palette = remember(members) { EventPalette(memberIds = members.mapTo(mutableSetOf()) { it.id }) },
                    zone = zone,
                    weekStart = props.weekStart,
                    save = ::save,
                    onAdd = {
                        picking = false
                        addingEvent = true
                    },
                    onTogglePicker = {
                        picking = !picking
                        if (picking) scope.launch { model.loadWeekEvents(props.weekStart) }
                    },
                    onPicked = { picking = false },
                )
                if (board.isSkipped) {
                    SkipBar(board, disabled) { save(FamilyNightBodies.setStatus(board.date, "planned")) }
                } else {
                    Text(
                        "These are rotation suggestions — each part taken in turn, in your family's order. Leave them and they stand; tap a face and it's pinned for this week only, which is what shifts next week's turn.",
                        style = TextStyle(fontSize = 12.5.sp),
                        color = WF.colors.ink3,
                    )
                    FnGhostButton("Skip this week", disabled) { save(FamilyNightBodies.setStatus(board.date, "skipped")) }
                }
                if (addingEvent) {
                    FamilyNightEventSheet(board, onDismiss = { addingEvent = false }) { body ->
                        addingEvent = false
                        save(body)
                    }
                }
            }
            state.loaded -> WaffledEmptyState(
                emoji = "🏡",
                title = "Couldn't read this week's family night",
                message = "Reload and try again — nothing has been changed.",
                top = 24.dp,
            )
            else -> WaffledLoading()
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Gathering(
    board: PlanningFamilyNightBoard,
    state: FamilyNightStepState,
    disabled: Boolean,
    picking: Boolean,
    palette: EventPalette,
    zone: java.time.ZoneId,
    weekStart: String,
    save: (JsonObject) -> Unit,
    onAdd: () -> Unit,
    onTogglePicker: () -> Unit,
    onPicked: () -> Unit,
) {
    val locked = disabled || board.isSkipped
    // Called off, not deleted: the week stays legible so Undo has something to undo.
    WaffledCard(modifier = Modifier.alpha(if (board.isSkipped) 0.5f else 1f), padding = 16.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("🏡 Family Night", Modifier.weight(1f), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink)
                    Text(state.recurrence, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                }
                Text(state.whenLabel, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
            }

            // '' clears; leaving the key out would mean "keep whatever is there".
            CommitLine(
                label = "Theme",
                value = board.theme.orEmpty(),
                placeholder = "optional — \"pizza and the new Lego set\"",
                limit = 120,
                // Skipped only, never busy: disabling a focused field drops its focus
                // mid-write, and the commit guard would then discard the typed words.
                disabled = board.isSkipped,
            ) { save(FamilyNightBodies.setTheme(board.date, it)) }

            state.rows.forEach { row -> PartRow(row, board, locked, save) }

            if (board.members.isEmpty()) {
                Text("Add family members and the rotation has somebody to offer.", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
            }

            CalendarLine(board, state, locked, disabled, picking, palette, zone, weekStart, save, onAdd, onTogglePicker, onPicked)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PartRow(row: FamilyNightPartRow, board: PlanningFamilyNightBoard, locked: Boolean, save: (JsonObject) -> Unit) {
    val part = row.part
    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WaffledEmojiTile(emoji = part.emoji, size = 19.dp, frame = 36.dp, cornerRadius = 11.dp)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(part.label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                Text(row.suggestion, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = if (part.pinned) WF.colors.ink2 else WF.colors.ink3)
            }
        }
        if (board.members.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                board.members.forEach { m -> Face(m, part, locked) { save(FamilyNightBodies.pin(board.date, part.partId, m.id)) } }
            }
        }
        // WHAT the part is, not whose turn: sent WITHOUT a personId key.
        CommitLine(
            label = "What",
            value = part.detail.orEmpty(),
            placeholder = row.detailHint,
            limit = 200,
            disabled = board.isSkipped,
            description = row.detailDescription,
        ) { save(FamilyNightBodies.setDetail(board.date, part.partId, it)) }
    }
}

/** Tapping the suggested person is a real action, so the accessible name is the action. */
@Composable
private fun Face(member: PlanningFamilyNightMember, part: PlanningFamilyNightPart, locked: Boolean, onClick: () -> Unit) {
    val current = member.id == part.personId
    Box(
        Modifier
            .alpha(if (current) 1f else 0.55f)
            .clip(CircleShape)
            .border(2.dp, if (current) WF.colors.primary else Color.Transparent, CircleShape)
            .clickable(enabled = !locked, onClick = onClick)
            .semantics {
                contentDescription = "Pin ${part.label} to ${member.name}"
                // Only a PIN is a selected state; the rotation's suggestion is merely current.
                selected = part.pinned && current
            },
    ) {
        AvatarFromHex(colorHex = member.colorHex, emoji = member.avatarEmoji ?: "🙂", size = 38.dp)
    }
}

/**
 * Two different things live here: `onCalendar` is the STANDING series set in Settings;
 * `eventId` is THIS gathering's own event. "Add to calendar" confirms in a sheet, then ONE
 * server call creates and links it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CalendarLine(
    board: PlanningFamilyNightBoard,
    state: FamilyNightStepState,
    locked: Boolean,
    disabled: Boolean,
    picking: Boolean,
    palette: EventPalette,
    zone: java.time.ZoneId,
    weekStart: String,
    save: (JsonObject) -> Unit,
    onAdd: () -> Unit,
    onTogglePicker: () -> Unit,
    onPicked: () -> Unit,
) {
    Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("📅", style = TextStyle(fontSize = 17.sp))
        if (board.eventId != null) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(board.eventTitle ?: "On the calendar", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                Text("${board.eventWhen.orEmpty()} · on the calendar for this week", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
            }
            // Unlinks ONLY: "this isn't family night after all" must never delete the event.
            FnGhostButton("Unlink", locked) { save(FamilyNightBodies.linkEvent(board.date, null)) }
        } else {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Not on the calendar this week", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                Text(
                    if (board.onCalendar) {
                        "The standing weekly event still stands — this is for a one-off, or to point at something already on the week."
                    } else {
                        "Add it as an event, or point at something already on the week."
                    },
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FnGhostButton("Add to calendar", locked, onAdd)
                    FnGhostButton(if (picking) "Never mind" else "Link an event", locked, onTogglePicker)
                }
                if (picking) {
                    Column(
                        Modifier.semantics { contentDescription = "Events on this week" },
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        val caption = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        when {
                            !state.weekEventsLoaded -> Text("Reading this week's calendar…", style = caption, color = WF.colors.ink3)
                            state.weekEvents.isEmpty() -> Text("Nothing on the week to point at yet.", style = caption, color = WF.colors.ink3)
                            else -> {
                                val days = remember(state.weekEvents, zone, weekStart) {
                                    PlanningFamilyNightFormat.weekEventDays(state.weekEvents, weekStart, zone)
                                }
                                days.forEach { day ->
                                    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                        Text(day.label, style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink3)
                                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                            day.events.forEach { row ->
                                                PlanningEventChip(
                                                    event = row.event,
                                                    palette = palette,
                                                    owner = row.owner,
                                                    zone = zone,
                                                    modifier = Modifier
                                                        .clickable(enabled = !disabled) {
                                                            onPicked()
                                                            save(FamilyNightBodies.linkEvent(board.date, row.event.id))
                                                        }
                                                        .semantics { contentDescription = "Link ${row.event.title}" },
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SkipBar(board: PlanningFamilyNightBoard, disabled: Boolean, onUndo: () -> Unit) {
    WaffledCard(padding = 14.dp) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("⏭", style = TextStyle(fontSize = 17.sp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("Skipped this week", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                // The rotation advancing on a skipped week is INTENDED, so the copy says so.
                val series = if (board.onCalendar) ", and the recurring calendar event is left alone" else ""
                Text(
                    "The gathering is marked skipped$series. Everyone's turn still moves on, so next week is the next person up.",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            FnGhostButton("Undo", disabled, onUndo)
        }
    }
}

/**
 * A free-text line saved on FOCUS LOSS (and on Done), not per keystroke: Done alone would
 * drop a theme typed just before tapping a face. A read landing mid-sentence never
 * clobbers the draft.
 */
@Composable
private fun CommitLine(
    label: String,
    value: String,
    placeholder: String,
    limit: Int,
    disabled: Boolean,
    description: String? = null,
    onCommit: (String) -> Unit,
) {
    var draft by remember { mutableStateOf(value) }
    var focused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    LaunchedEffect(value) { if (!focused) draft = value }

    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        SectionLabel(label)
        WaffledTextField(
            value = draft,
            onValueChange = { draft = it.take(limit) },
            placeholder = placeholder,
            enabled = !disabled,
            modifier = Modifier
                .onFocusChanged { f ->
                    val was = focused
                    focused = f.hasFocus
                    if (was && !f.hasFocus) {
                        val trimmed = draft.trim()
                        if (!disabled && trimmed != value) onCommit(trimmed)
                    }
                }
                .semantics { contentDescription = description ?: label },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() }),
        )
    }
}

/**
 * Confirms what the week's event will say before the server makes it — title, time and
 * length — then hands back `FamilyNightBodies.addEvent`.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun FamilyNightEventSheet(board: PlanningFamilyNightBoard, onDismiss: () -> Unit, onAdd: (JsonObject) -> Unit) {
    var title by remember { mutableStateOf(FamilyNightBodies.defaultEventTitle(board.theme)) }
    val start = remember { FamilyNightFormat.minutes(board.time) }
    val time = rememberTimePickerState(initialHour = start / 60, initialMinute = start % 60, is24Hour = false)
    var duration by remember { mutableIntStateOf(60) }
    val trimmed = title.trim()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Add family night", style = WF.type.sectionTitle, color = WF.colors.ink)
            WaffledFieldCard(title = "Title") {
                WaffledTextField(
                    value = title,
                    onValueChange = { title = FamilyNightBodies.limitEventTitle(it) },
                    placeholder = "🏡 Family Night",
                )
            }
            WaffledFieldCard(title = "When") {
                Text(PlanningFamilyNightFormat.longDate(board.date), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                TimeInput(state = time)
                SectionLabel("Duration")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    DURATIONS.forEach { m ->
                        val on = m == duration
                        Text(
                            durationLabel(m),
                            modifier = Modifier
                                .wfChip(selected = on)
                                .clickable { duration = m }
                                .semantics { selected = on }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                            color = if (on) WF.colors.ink else WF.colors.ink2,
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Cancel",
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(WF.radius.md))
                        .background(WF.colors.panel)
                        .clickable(onClick = onDismiss)
                        .padding(vertical = 14.dp),
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold, textAlign = androidx.compose.ui.text.style.TextAlign.Center),
                    color = WF.colors.ink2,
                )
                WaffledPrimaryCTA(
                    label = "Add",
                    modifier = Modifier.weight(1f),
                    isDisabled = trimmed.isEmpty(),
                    onClick = {
                        onAdd(FamilyNightBodies.addEvent(board.date, trimmed, FamilyNightFormat.hhmm(time.hour * 60 + time.minute), duration))
                    },
                )
            }
        }
    }
}

private val DURATIONS = listOf(30, 60, 90, 120, 180)

private fun durationLabel(m: Int): String = when {
    m < 60 -> "$m min"
    m % 60 == 0 -> "${m / 60} hr"
    else -> "${m / 60} hr ${m % 60} min"
}

/** The quiet panel capsule iOS uses for a step's own control; no shared equivalent exists. */
@Composable
private fun FnGhostButton(label: String, disabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        modifier = Modifier
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(WF.colors.panel)
            .clickable(enabled = !disabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
        color = if (disabled) WF.colors.ink3 else WF.colors.ink2,
    )
}
