package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.model.WaffledModule
import app.waffled.core.network.RefreshDomain
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.EventChipPaint
import app.waffled.feature.calendar.EventEditSheet
import app.waffled.feature.calendar.EventPalette
import app.waffled.feature.calendar.color
import app.waffled.feature.chores.ChoreEditSheet
import app.waffled.feature.chores.ChoreEditorTarget
import app.waffled.feature.chores.ChoresApi
import app.waffled.feature.planning.PlanningFormat
import app.waffled.feature.planning.PlanningPillButton
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.PlanningRecapApi
import app.waffled.feature.planning.api.PlanningRecapGroup
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * Weekly Planning · step 10 "Recap" — port of iOS `RecapStepView`, and also the body of the
 * saved-week record. THE BODY COMPUTES NOTHING: every headline and tally arrives resolved;
 * this file decides layout, seven day rows, and paints events through the calendar's own
 * palette. Its only writes answer a parked note; the tense comes off the payload's `savedAt`.
 */
@Composable
fun RecapStepBody(props: PlanningStepProps) {
    val env = props.env
    val model = remember(env) {
        val api = PlanningRecapApi(env.http)
        val chores = ChoresApi(env.client, env.tokens)
        PlanningRecapModel(
            fetchRecap = { s, w -> api.recap(s, w) },
            // Step 1's resolver owns parked notes; this step grows no second way to answer one.
            dropNote = { id, s -> env.api.resolveLooseEnd("parked", id, "drop", s) },
            settleNote = { id, s -> env.api.resolveLooseEnd("parked", id, "done", s) },
            saveChore = {
                chores.createChore(it)
                // Chores are REST-only; screens watching them re-fetch on this bump.
                env.refreshBus.bump(RefreshDomain.Chores)
            },
        )
    }
    val state by model.state.collectAsStateWithLifecycle()
    val members by env.sync.members.collectAsStateWithLifecycle()
    val modules by env.sync.modules.collectAsStateWithLifecycle()
    val zone by env.sync.householdZone.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val calendar = remember(env) { CalendarApi(env.client, env.tokens) }
    var display by remember { mutableStateOf(CalendarApi.HouseholdDisplay()) }
    val palette = remember(members, display) {
        EventPalette(memberIds = members.mapTo(mutableSetOf()) { it.id }, familyHex = display.familyHex, style = display.style)
    }

    LaunchedEffect(props.sessionId) { model.load(props.sessionId, props.weekStart) }
    // The household's solid-vs-tinted style and family colour, so the strip matches the calendar.
    LaunchedEffect(calendar) {
        try {
            display = calendar.householdDisplay()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }
    // Never a null: a failed fetch's null is the wipe, since `decideStep` replaces the row.
    LaunchedEffect(state.rev) { state.crumb?.let(props.setDecisionData) }
    LaunchedEffect(state.working) { props.reportBusy(state.working != null) }
    DisposableEffect(Unit) {
        props.lendVerb(null)
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }
        when {
            !state.loaded && state.view == null -> WaffledLoading()
            state.view == null -> WaffledEmptyState(
                emoji = "🗒️",
                title = "Couldn’t read the week back",
                message = "The week itself is unaffected — saving still records it.",
                top = 24.dp,
            )
            else -> {
                Week(state, palette)
                Changed(state, props.goToStep)
                Targets(state)
                LastCall(
                    state = state,
                    disabled = props.busy || state.working != null,
                    choresOn = modules.isOn(WaffledModule.Chores),
                    onKeep = model::keepParked,
                    onDrop = { id -> scope.launch { model.drop(id, props.sessionId) } },
                    onTask = model::makeTask,
                    onEvent = model::makeEvent,
                )
                LeftAlone(state)
                Text(PlanningRecapText.footNote(state.saved), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
            }
        }
    }

    state.composer?.let { composer ->
        // Never a day already past: planning mid-week, or reading a saved week later.
        val today = LocalDate.now(zone)
        val day = PlanningFormat.parseDay(props.weekStart)?.takeIf { it.isAfter(today) } ?: today
        val dismissed = { scope.launch { model.composerDismissed(props.sessionId) }; Unit }
        when (composer) {
            is RecapNoteComposer.Task -> {
                val chores = remember(env) { ChoresApi(env.client, env.tokens) }
                var currencies by remember { mutableStateOf<List<ChoresApi.Currency>>(emptyList()) }
                LaunchedEffect(chores) {
                    currencies = try {
                        chores.currencies()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        emptyList()
                    }
                }
                val me = env.sync.currentPersonId.value
                // Assignment is manage-gated: without chore.manage the sheet offers only you.
                val assignable = if (env.sync.can("chore.manage")) members else members.filter { it.id == me }
                ChoreEditSheet(
                    target = ChoreEditorTarget.New(personId = null),
                    assignableMembers = assignable,
                    currencies = currencies,
                    initialDate = day.toString(),
                    onSave = { _, body -> model.saveChoreFromNote(body) },
                    onDelete = { _, _ -> "Deleting isn’t part of planning a week." },
                    onDismiss = dismissed,
                    initialTitle = composer.note,
                    canDelete = false,
                )
            }
            is RecapNoteComposer.Event -> EventEditSheet(
                api = calendar,
                zone = zone,
                members = members,
                event = null,
                initialDate = day,
                initialTitle = composer.note,
                onDismiss = dismissed,
                onSaved = {
                    model.eventSaved()
                    dismissed()
                },
            )
        }
    }
}

// ---- The week, one last time ----

@Composable
private fun Week(state: RecapStepState, palette: EventPalette) {
    var open by remember { mutableStateOf(emptySet<String>()) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("The week, one last time")
        state.days.forEach { row ->
            val isOpen = row.date in open
            WaffledCard(padding = 12.dp) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.width(34.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(row.dayName, style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.4.sp), color = WF.colors.ink3)
                        Text(row.dayNumber, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        row.mealLine?.let {
                            Text(it, style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                        }
                        (if (isOpen) row.events + row.hidden else row.events).forEach { EventChip(it, palette) }
                        if (row.more > 0 && !isOpen) {
                            // Busy days open in place when the server sent what it held back.
                            val more = Modifier.let { m -> if (row.hidden.isEmpty()) m else m.clickable { open = open + row.date } }
                            Text("+${row.more} more", modifier = more, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                        }
                        if (row.mealLine == null && row.events.isEmpty() && row.more == 0) {
                            Text("Nothing on", style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
                        }
                    }
                }
            }
        }
    }
}

/** Painted by the event's owner through the household palette, as the calendar paints it. */
@Composable
private fun EventChip(event: PlanningRecapEventRow, palette: EventPalette) {
    val paint = EventChipPaint.of(
        color = palette.color(event.people, fallback = WF.colors.ink3),
        style = palette.style,
        ink = WF.colors.ink,
        isDark = WF.colors.isDark,
    )
    Text(
        event.title,
        modifier = Modifier
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(paint.background)
            .padding(horizontal = 9.dp, vertical = 4.dp)
            .semantics { contentDescription = "${event.title}, ${event.`when`}" },
        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
        color = paint.foreground,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

// ---- What tonight changed ----

@Composable
private fun Changed(state: RecapStepState, goToStep: (String) -> Unit) {
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(PlanningRecapText.changedTitle(state.saved), Modifier.weight(1f), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                WaffledStatusBadge(text = PlanningRecapText.decisionsLabel(state.counts.decisions), color = WF.colors.primary)
            }
            state.groups.forEach { group ->
                // A row that names a step IS the door to it; goToStep doesn't move the session pointer.
                val key = group.stepKey
                val mod = if (key != null) {
                    Modifier.clickable { goToStep(key) }.semantics { contentDescription = "${group.label}: ${group.headline}. Opens ${group.label}" }
                } else {
                    Modifier
                }
                GroupRow(group, tappable = key != null, modifier = mod)
            }
            if (state.nothingDecided) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("Nothing was decided in this session", style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                    Text(PlanningRecapText.nothingDecidedDetail(state.saved), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                }
            }
            if (state.groups.isNotEmpty()) {
                Text("Every line is live in the module it names — tap one to go there.", style = TextStyle(fontSize = 11.5.sp), color = WF.colors.ink3)
            }
        }
    }
}

@Composable
private fun GroupRow(group: PlanningRecapGroup, tappable: Boolean, modifier: Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(group.label.uppercase(), Modifier.weight(1f), style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.4.sp), color = WF.colors.ink3)
            WaffledStatusBadge(text = "${group.count}", color = WF.colors.ink2, weight = FontWeight.ExtraBold)
            if (tappable) DisclosureChevron(isOpen = false)
        }
        Text(group.headline, style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        if (group.detail.isNotEmpty()) Text(group.detail, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
    }
}

@Composable
private fun Targets(state: RecapStepState) {
    if (state.lastWeekTargets.isEmpty()) return
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Last week’s targets", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            state.lastWeekTargets.forEach { t ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("${t.emoji?.let { "$it " }.orEmpty()}${t.title}", style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                        Text(PlanningRecapText.targetLine(t), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                    }
                    val met = t.done >= t.target
                    WaffledStatusBadge(text = if (met) "met" else "short", color = if (met) WF.colors.success else WF.colors.ink3)
                }
            }
        }
    }
}

// ---- Still on the board (the last call) ----

@Composable
private fun LastCall(
    state: RecapStepState,
    disabled: Boolean,
    choresOn: Boolean,
    onKeep: (String) -> Unit,
    onDrop: (String) -> Unit,
    onTask: (app.waffled.feature.planning.api.PlanningRecapLastCall) -> Unit,
    onEvent: (app.waffled.feature.planning.api.PlanningRecapLastCall) -> Unit,
) {
    val open = state.openLastCall
    val more = state.view?.lastCallMore ?: 0
    if (open.isEmpty() && more <= 0) return
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Still on the board", Modifier.weight(1f), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                WaffledStatusBadge(text = "last call", color = WF.colors.warn)
            }
            open.forEach { note ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(WF.radius.md))
                        .background(WF.colors.panel)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(note.note, style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                            note.detail?.takeIf { it.isNotEmpty() }?.let {
                                Text(it, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                            }
                        }
                        if (state.working == note.id) {
                            CircularProgressIndicator(Modifier.size(16.dp), color = WF.colors.ink3, strokeWidth = 2.dp)
                        }
                        QuietMenu(disabled, onKeep = { onKeep(note.id) }, onDrop = { onDrop(note.id) })
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (choresOn) PlanningPillButton("Make a task", onClick = { onTask(note) }, disabled = disabled)
                        PlanningPillButton("Make an event", onClick = { onEvent(note) }, disabled = disabled)
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
            if (more > 0) Text(PlanningRecapText.lastCallMoreLabel(more), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
    }
}

/** The quiet answers — keep it parked (writes nothing) or drop it — behind a ⋯. */
@Composable
private fun QuietMenu(disabled: Boolean, onKeep: () -> Unit, onDrop: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier
                .size(30.dp)
                .clip(RoundedCornerShape(WF.radius.pill))
                .clickable(enabled = !disabled) { expanded = true }
                .semantics { contentDescription = "Keep or drop this note" },
            contentAlignment = Alignment.Center,
        ) {
            Text("⋯", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink3)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, containerColor = WF.colors.card) {
            DropdownMenuItem(
                text = { Text("Keep it parked", color = WF.colors.ink) },
                onClick = {
                    expanded = false
                    onKeep()
                },
            )
            DropdownMenuItem(
                text = { Text("Drop it", color = WF.colors.danger) },
                onClick = {
                    expanded = false
                    onDrop()
                },
            )
        }
    }
}

// ---- Left alone on purpose ----

@Composable
private fun LeftAlone(state: RecapStepState) {
    if (state.leftAlone.isEmpty()) return
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Left alone on purpose", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            state.leftAlone.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(row.label, style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                        Text(row.detail, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                    }
                    WaffledStatusBadge(text = row.badge, color = badgeColor(row.badge))
                }
            }
        }
    }
}

/** An unrecognised badge reads NEUTRAL: the catalog is server-owned. */
@Composable
private fun badgeColor(badge: String): Color = when (badge) {
    "skipped" -> WF.colors.ink2
    "none" -> WF.colors.info
    "parked" -> WF.colors.warn
    else -> WF.colors.ink3
}
