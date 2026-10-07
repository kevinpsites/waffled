package app.waffled.feature.planning.steps

import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.wfField
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.calendar.Agenda
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CalendarWeeksGrid
import app.waffled.feature.calendar.CountdownCard
import app.waffled.feature.calendar.CountdownsModel
import app.waffled.feature.calendar.EventCard
import app.waffled.feature.calendar.EventEditSheet
import app.waffled.feature.planning.PlanningHandoffVerb
import app.waffled.feature.planning.PlanningHorizonWindow
import app.waffled.feature.planning.PlanningParkedNoteEditor
import app.waffled.feature.planning.PlanningParkedTag
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.PlanningTagChip
import app.waffled.feature.planning.api.PlanningHorizonApi
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The month grid's 21dp weekday header plus four 72dp week rows: `PhoneMonthGrid` splits the height it is given. */
private val HORIZON_GRID_HEIGHT = 21.dp + 72.dp * PlanningHorizonWindow.WEEKS

/**
 * Weekly Planning · step 3 "Horizon scan" — the next four weeks plus one bar that parks a
 * NOTE (never a calendar entry) tagged for a step still ahead. Port of iOS
 * `HorizonStep.swift`. The ＋ writes a real event through `EventEditSheet`; the bar only
 * parks; nothing navigates. Content-sized: the shell scrolls.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HorizonStepBody(props: PlanningStepProps) {
    val env = props.env
    val calendar = rememberPlanningCalendarModel(env)
    val calendarApi = remember(env) { CalendarApi(env.client, env.tokens) }
    val countdowns = remember(env) { CountdownsModel.backedBy(calendarApi) }
    val model = remember(env) { PlanningHorizonModel.from(PlanningHorizonApi(env.http), env.api) }
    val state by model.state.collectAsState()
    val rowsByDay by calendar.rowsByDay.collectAsState()
    val countdownsByDate by countdowns.byDateState.collectAsState()
    val sleeps by countdowns.sleepsState.collectAsState()
    val zone by env.sync.householdZone.collectAsState()
    val members by env.sync.members.collectAsState()
    val events by env.sync.visibleEvents.collectAsState()
    val scope = rememberCoroutineScope()

    var ahead by rememberSaveable(props.weekStart) { mutableIntStateOf(0) }
    val windowStart = PlanningHorizonWindow.start(props.weekStart, ahead) ?: props.weekStart
    val windowDay = runCatching { LocalDate.parse(windowStart) }.getOrElse { LocalDate.now(zone) }
    var selectedDay by remember(windowDay) { mutableStateOf(windowDay) }
    var note by rememberSaveable { mutableStateOf("") }
    var editing by remember { mutableStateOf<String?>(null) }
    var composer by remember { mutableStateOf<HorizonComposer?>(null) }
    val focus = remember { FocusRequester() }
    val currentDay by rememberUpdatedState(selectedDay)

    val disabled = props.busy || state.parking
    val trimmed = note.trim()

    LaunchedEffect(props.sessionId) { model.load(props.sessionId) }
    LaunchedEffect(countdowns) { countdowns.load() }
    LaunchedEffect(state.loaded, state.added, state.parked.size) {
        if (state.loaded) props.setDecisionData(state.decisionData)
    }
    LaunchedEffect(state.parking) { props.reportBusy(state.parking) }
    DisposableEffect(Unit) {
        // `EventEditSheet` has no title prefill yet, so the note's words aren't carried into it.
        props.lendVerb(PlanningHandoffVerb("Make an event") { _, done -> composer = HorizonComposer(null, currentDay, done) })
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    fun park() {
        if (trimmed.isEmpty() || disabled) return
        val text = trimmed
        scope.launch {
            if (model.park(text, props.sessionId)) {
                note = ""
                // Parking is a burst, so the cursor goes back rather than making you re-aim.
                runCatching { focus.requestFocus() }
                props.refresh()
            }
        }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            val canBack = ahead > 0 && !props.busy
            Text(
                "‹",
                modifier = Modifier
                    .clickable(enabled = canBack) { ahead = maxOf(0, ahead - 1) }
                    .semantics { contentDescription = "Previous 4 weeks" },
                style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Black),
                color = if (ahead == 0) WF.colors.ink3.copy(alpha = 0.4f) else WF.colors.ink2,
            )
            Text(PlanningHorizonWindow.label(windowStart, Locale.US), style = WF.type.serif(20.sp), color = WF.colors.ink)
            Text(
                "›",
                modifier = Modifier
                    .clickable(enabled = !props.busy) { ahead += 1 }
                    .semantics { contentDescription = "Next 4 weeks" },
                style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Black),
                color = WF.colors.ink2,
            )
        }

        val shape = RoundedCornerShape(WF.radius.lg)
        // The Calendar tab's own grid, so a change there reaches this step. Fixed height: it
        // splits what it is given across its rows, and this body sits inside the shell's scroll.
        CalendarWeeksGrid(
            model = calendar,
            countdowns = countdowns,
            start = windowDay,
            weeks = PlanningHorizonWindow.WEEKS,
            selectedDay = selectedDay,
            onPick = { selectedDay = it },
            modifier = Modifier
                .fillMaxWidth()
                .background(WF.colors.card, shape)
                .border(1.dp, WF.colors.hair, shape)
                .padding(vertical = 6.dp)
                .height(HORIZON_GRID_HEIGHT),
        )

        // The selected day.
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(relativeLabel(selectedDay, LocalDate.now(zone)), style = WF.type.serif(18.sp), color = WF.colors.ink)
                Text(selectedDay.format(DATE_LABEL), style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
            }
            rowsByDay[selectedDay].orEmpty().forEach { row ->
                EventCard(row = row, isPast = Agenda.isPast(row, zone), onClick = {
                    composer = HorizonComposer(row.event, eventDay(row.event, zone) ?: selectedDay, null)
                })
            }
            countdownsByDate[selectedDay.toString()].orEmpty().forEach { c ->
                CountdownCard(countdown = c, sleeps = sleeps, onClick = {
                    // An event-backed countdown opens its event in place; the rest are managed where they live.
                    if (c.source == "event") {
                        events.firstOrNull { it.id == c.id }?.let { ev -> composer = HorizonComposer(ev, eventDay(ev, zone) ?: selectedDay, null) }
                    }
                })
            }
            Text(
                "+ Add an event on this day",
                modifier = Modifier.clickable(enabled = !props.busy) { composer = HorizonComposer(null, selectedDay, null) }.padding(vertical = 8.dp),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ai,
            )
        }

        PlanningCaptureBar(
            value = note,
            onValueChange = { note = it },
            placeholder = "Park a note — “we’re going camping, we need to pack”",
            glyph = "📌",
            onSubmit = ::park,
            focus = focus,
        ) {
            if (trimmed.isEmpty()) {
                Text("a note, not a calendar entry", style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
            } else {
                PlanningTextAction("Park it", enabled = !disabled, tint = WF.colors.primary, onClick = ::park)
            }
        }

        // Below the bar, not inside it: five-to-seven chips make a capture line a cramped scroll.
        if (trimmed.isNotEmpty()) {
            FlowRow(
                Modifier.semantics { contentDescription = "Which step should look at this?" },
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                state.tags.forEach { t ->
                    PlanningTagChip(t.label, state.chosenStepKey == t.stepKey, { model.choose(PlanningTagChoice.Step(t.stepKey)) }, disabled)
                }
                PlanningTagChip("No tag", state.chosenStepKey == null, { model.choose(PlanningTagChoice.NoTag) }, disabled)
            }
            val label = state.chosenLabel
            Text(
                buildAnnotatedString {
                    if (label != null) {
                        append("Comes back at ")
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(label) }
                        append(", later in this session.")
                    } else {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("No step will raise it.") }
                        append(" It stays on the board — in tonight’s recap, and waiting at Loose ends next session.")
                    }
                },
                style = TextStyle(fontSize = 12.5.sp),
                color = WF.colors.ink2,
            )
        }

        // Not while a board row is open: the editor shows the refusal itself.
        if (editing == null) state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::clearError) }

        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Know the day it lands?") }
                append(" Tap that day on the calendar above and add it — you get a real calendar event. ")
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Only know it’s coming?") }
                append(" Park it in the bar: it stays off the calendar, and comes back at whichever step you tag it for — all of them still ahead of you tonight.")
            },
            style = TextStyle(fontSize = 12.sp),
            color = WF.colors.ink3,
        )

        // Named: the read returns every note parked this session, whichever bar wrote it.
        if (state.parked.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("Parked in this session")
                state.parked.forEach { n ->
                    Column(Modifier.fillMaxWidth().wfField(fill = WF.colors.panel).padding(11.dp)) {
                        if (editing == n.id) {
                            PlanningParkedNoteEditor(
                                note = n.note,
                                stepKey = n.stepKey,
                                tags = state.tags.map { PlanningParkedTag(it.stepKey, it.label, it.hint) },
                                onCancel = {
                                    editing = null
                                    model.clearError()
                                },
                                onSave = { text, tag ->
                                    val took = model.update(n.id, text, tag, props.sessionId)
                                    if (took) props.refresh()
                                    took
                                },
                                busy = props.busy,
                                errorMessage = state.errorMessage,
                            )
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(n.note, modifier = Modifier.weight(1f), style = TextStyle(fontSize = 13.5.sp), color = WF.colors.ink)
                                n.stepLabel?.let { WaffledStatusBadge(it, WF.colors.ai) } ?: WaffledStatusBadge("No tag", WF.colors.ink3)
                                Text(
                                    "Edit",
                                    modifier = Modifier
                                        .clickable(enabled = !disabled) {
                                            model.clearError()
                                            editing = n.id
                                        }
                                        .semantics { contentDescription = "Edit “${n.note}”" },
                                    style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.Bold),
                                    color = if (disabled) WF.colors.ink3 else WF.colors.ai,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    composer?.let { c ->
        EventEditSheet(
            api = calendarApi,
            zone = zone,
            members = members,
            event = c.event,
            initialDate = c.day,
            // A cancelled composer reports false, or a parked note is settled on a box opened and closed.
            onDismiss = {
                composer = null
                c.done?.invoke(false)
            },
            onSaved = {
                composer = null
                val created = c.event == null
                if (created) model.recordEventAdded()
                props.refresh()
                c.done?.invoke(created)
            },
        )
    }
}

/** What the sheet opens on; [done] is the banner's completion when its verb opened this. */
private class HorizonComposer(val event: SyncedEvent?, val day: LocalDate, val done: ((Boolean) -> Unit)?)

private val DATE_LABEL = DateTimeFormatter.ofPattern("EEE · MMM d", Locale.US)
private val WEEKDAY = DateTimeFormatter.ofPattern("EEEE", Locale.US)

private fun relativeLabel(day: LocalDate, today: LocalDate): String = when (day) {
    today -> "Today"
    today.plusDays(1) -> "Tomorrow"
    else -> day.format(WEEKDAY)
}
