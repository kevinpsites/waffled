package app.waffled.feature.planning.steps

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfField
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.EventEditSheet
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.PlanningConnectionApi
import app.waffled.feature.planning.api.PlanningConnectionSlot
import app.waffled.feature.planning.planningOptionChrome
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * Weekly Planning · step 5 "Connection" — "Who gets time with whom?" Port of iOS
 * `ConnectionStep.swift`. Nothing new is stored: a pairing is a query over event
 * participants, claiming a slot writes an ordinary calendar event through `EventEditSheet`,
 * and the one thing remembered is a POINTER (which event answers which pairing). The rows
 * are a prompt, not the list; "Make a pairing" is first-class beneath them.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ConnectionStepBody(props: PlanningStepProps) {
    val env = props.env
    val model = remember(env) { PlanningConnectionModel.from(PlanningConnectionApi(env.http)) }
    val calendarApi = remember(env) { CalendarApi(env.client, env.tokens) }
    val state by model.state.collectAsState()
    val members by env.sync.members.collectAsState()
    val zone by env.sync.householdZone.collectAsState()
    val scope = rememberCoroutineScope()

    var picking by remember { mutableStateOf<String?>(null) }
    var compose by remember { mutableStateOf<ConnectionCompose?>(null) }
    // The crumb carries `links`; pushing before the seed would hand the shell an empty map.
    var seeded by remember { mutableStateOf(false) }

    LaunchedEffect(props.weekStart) {
        model.seedLinks(props.step.data["links"], props.weekStart)
        seeded = true
        model.load(props.weekStart)
    }
    LaunchedEffect(seeded, state.links, state.added) {
        if (seeded) props.setDecisionData(state.decisionData)
    }
    // Lends nothing: a parked note has no pairing to belong to.
    DisposableEffect(Unit) {
        props.lendVerb(null)
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    fun link(key: String, eventId: String?) {
        picking = null
        scope.launch { model.link(key, eventId, props.sessionId) }
    }

    fun open(next: ConnectionCompose) {
        model.clearMadeNote()
        compose = next
    }

    fun slotCompose(slot: PlanningConnectionSlot, people: List<String>) =
        ConnectionCompose(parseDay(slot.date, props.weekStart), slotTime(slot, zone), people)

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val board = state.board
        if (state.failed && board != null) {
            DismissibleErrorBanner(message = ConnectionCopy.READ_FAILED, onDismiss = model::clearFailed)
        }
        when {
            board != null && board.pairings.isEmpty() ->
                WaffledEmptyState(emoji = "🫂", title = "Nobody to pair up yet", message = ConnectionCopy.NEEDS_TWO_PEOPLE)
            board != null -> {
                state.rows.forEach { row ->
                    WaffledCard {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Faces(row.personIds, members, size = 30, modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = row.who })
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text(row.who, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                                    Text(row.sentence, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink2)
                                }
                            }
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                // Time that already exists comes first, and names the event: a day and hour identify nothing.
                                row.oneTap?.let { tap ->
                                    ConnectionChip(
                                        text = "${if (row.oneTapChosen) "✓ " else ""}${tap.title} · ${tap.day.take(3)}",
                                        selected = row.oneTapChosen,
                                        tint = WF.colors.success,
                                        label = "${tap.title} on ${tap.`when`} " + if (row.oneTapChosen) "is your time together" else "already counts",
                                        enabled = !props.busy,
                                    ) { link(row.key, tap.id) }
                                }
                                if (row.showPicker) {
                                    ConnectionChip(
                                        text = if (row.answer == null) "Link a time" else "Change",
                                        selected = false,
                                        tint = WF.colors.primary,
                                        label = (if (row.answer == null) "Link a time" else "Change the time") + " for ${row.who}",
                                        enabled = !props.busy,
                                    ) { picking = if (picking == row.key) null else row.key }
                                }
                                row.slots.forEach { slot ->
                                    ConnectionChip(slot.label, false, WF.colors.primary, slot.label, !props.busy) {
                                        open(slotCompose(slot, row.personIds))
                                    }
                                }
                                ConnectionChip("＋ Another time", false, WF.colors.primary, "Another time for ${row.who}", !props.busy) {
                                    open(ConnectionCompose(parseDay(props.weekStart, props.weekStart), null, row.personIds))
                                }
                            }
                            // Named by WHEN: two dinners in one week need telling apart. Re-picking the linked one unlinks it.
                            if (picking == row.key) {
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    row.candidates.forEach { event ->
                                        val chosen = row.answer?.id == event.id
                                        Row(
                                            Modifier
                                                .fillMaxWidth()
                                                .planningOptionChrome(selected = chosen, tint = WF.colors.success)
                                                .clickable(enabled = !props.busy) { link(row.key, event.id) }
                                                .semantics { selected = chosen }
                                                .padding(horizontal = 11.dp, vertical = 9.dp),
                                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                                        ) {
                                            Text(event.title, modifier = Modifier.weight(1f), style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                                            Text(event.`when`, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                state.madeNote?.let {
                    Text(
                        it,
                        modifier = Modifier.fillMaxWidth().wfField(fill = WF.colors.panel).padding(horizontal = 12.dp, vertical = 8.dp),
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                }
                // A new identity per save: the bar's picks are its own state, and a made pairing must read as done.
                key(state.madeGeneration) {
                    MakePairing(model, props.weekStart, members, props.busy) { people, slot ->
                        open(
                            if (slot == null) ConnectionCompose(parseDay(props.weekStart, props.weekStart), null, people)
                            else slotCompose(slot, people),
                        )
                    }
                }
                Text(ConnectionCopy.NOTE, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
            }
            state.failed -> WaffledEmptyState(emoji = "📵", title = ConnectionCopy.READ_FAILED)
            !state.loaded -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                WaffledLoading(top = 24.dp)
                Text("Looking at who’s been where…", style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
            }
        }
    }

    compose?.let { c ->
        EventEditSheet(
            api = calendarApi,
            zone = zone,
            members = members,
            event = null,
            initialDate = c.day,
            initialTime = c.time,
            onDismiss = { compose = null },
            onSaved = {
                compose = null
                val names = c.participantIds.mapNotNull { id -> members.firstOrNull { it.id == id }?.name }
                // Re-read until the board includes what was just written (see the model's catch-up ladder).
                scope.launch { model.settleAfterSave(props.weekStart, props.sessionId, c.participantIds, names) }
                props.refresh()
            },
        )
    }
}

/** "＋ Make a pairing": choosing WHO feeds the slot query; what, when and the save belong to `EventEditSheet`. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MakePairing(
    model: PlanningConnectionModel,
    weekStart: String,
    members: List<Person>,
    busy: Boolean,
    onCompose: (people: List<String>, slot: PlanningConnectionSlot?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    var picked by remember { mutableStateOf(emptySet<String>()) }
    var slots by remember { mutableStateOf(emptyList<PlanningConnectionSlot>()) }
    var who by remember { mutableStateOf("") }
    // HOUSEHOLD order, not tap order, so the key the composer builds matches a row's.
    val chosen = members.filter { it.id in picked }.map { it.id }

    LaunchedEffect(chosen) {
        val result = if (chosen.size >= 2) model.slots(weekStart, chosen) else null
        slots = result?.slots.orEmpty()
        who = result?.who.orEmpty()
    }

    if (!open) {
        Row(
            Modifier
                .fillMaxWidth()
                .wfField(fill = WF.colors.panel)
                .clickable(enabled = !busy) {
                    model.clearMadeNote()
                    open = true
                }
                .padding(13.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("＋ Make a pairing — any two people, any time", modifier = Modifier.weight(1f), style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            Faces(members.map { it.id }, members, size = 24)
        }
        return
    }

    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionLabel("Who")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    members.forEach { member ->
                        val on = member.id in picked
                        Row(
                            Modifier
                                .wfChip(selected = on, tint = WF.colors.primary)
                                .clickable(enabled = !busy) { picked = if (on) picked - member.id else picked + member.id }
                                .semantics {
                                    selected = on
                                    contentDescription = if (on) "${member.name} — take out of the pairing" else "${member.name} — add to the pairing"
                                }
                                .padding(horizontal = 9.dp, vertical = 5.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            AvatarFromHex(colorHex = member.colorHex, emoji = member.avatarEmoji ?: "🙂", size = 22.dp)
                            Text(member.name, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold), color = if (on) WF.colors.primaryD else WF.colors.ink2)
                        }
                    }
                }
                Text(if (who.isEmpty()) "Tap two people — or three." else "$who · tap to add anyone else", style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionLabel("When")
                if (chosen.size < 2) {
                    Text("Their free evenings appear once there are two of them.", style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                } else {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        slots.take(PlanningConnectionCopy.SLOTS_PER_ROW + 1).forEach { slot ->
                            ConnectionChip(slot.label, false, WF.colors.primary, slot.label, !busy) { onCompose(chosen, slot) }
                        }
                        // "Any time" has to mean any time — this opens the sheet's own picker.
                        ConnectionChip("Pick a date and time", false, WF.colors.primary, "Pick a date and time", !busy) { onCompose(chosen, null) }
                    }
                }
            }
            Text(
                "Cancel",
                modifier = Modifier.clickable {
                    open = false
                    picked = emptySet()
                },
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
    }
}

@Composable
private fun Faces(personIds: List<String>, members: List<Person>, size: Int, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy((-6).dp)) {
        personIds.forEach { id ->
            val m = members.firstOrNull { it.id == id }
            AvatarFromHex(colorHex = m?.colorHex, emoji = m?.avatarEmoji ?: "🙂", size = size.dp)
        }
    }
}

@Composable
private fun ConnectionChip(text: String, selected: Boolean, tint: Color, label: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        text,
        modifier = Modifier
            .wfChip(selected = selected, tint = tint)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics {
                contentDescription = label
                this.selected = selected
            }
            .padding(horizontal = 11.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
        color = if (selected) tint else WF.colors.ink2,
    )
}

/** Day plus, only when there is one, the slot's start in the household's zone — a null start is the whole day free. */
private class ConnectionCompose(val day: LocalDate, val time: LocalTime?, val participantIds: List<String>)

private fun parseDay(iso: String, fallback: String): LocalDate =
    runCatching { LocalDate.parse(iso) }.getOrElse { LocalDate.parse(fallback) }

private fun slotTime(slot: PlanningConnectionSlot, zone: ZoneId): LocalTime? =
    WaffledDates.parseInstant(slot.startsAt, zone)?.atZone(zone)?.toLocalTime()

/** The step's fixed copy, in one place so a sentence can be asserted without a view. */
object ConnectionCopy {
    const val READ_FAILED = "Couldn’t read your week just now."
    const val NEEDS_TWO_PEOPLE =
        "This one needs more than one person in the household — add someone in Settings, and pairings appear here."
    const val NOTE =
        "The rows above are just the pairings the app can see — they aren’t the list. " +
            "Make a pairing takes any two people and any time, and the slots offered are the gaps the " +
            "week already left behind. Either way it ends up as a normal calendar event. Add a third " +
            "person and it still lands on the calendar — it just counts as time together rather than as " +
            "time with just the two of them."
}
