package app.waffled.feature.rhythms

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircleOutline
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.EditCalendar
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.Update
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.model.Person
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The rhythms register — every rhythm, what state it is in, and where new ones are made.
 * Port of iOS `RhythmsView`, grouped by WHEN (Needs you now / Coming up / Steady), not by
 * shape; the shapes survive in each row's own words and verb.
 *
 * Edit, pause, push, book, skip and retire all live in the row's ··· menu. iOS also puts
 * some on swipes; a swipe is invisible until tried, so the menu is the path that matters.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RhythmsScreen(
    model: RhythmsModel,
    /** The household's members — whose rhythm it is, and who the editor can assign. */
    members: List<Person>,
    modifier: Modifier = Modifier,
    refreshKey: Any? = Unit,
    onBack: (() -> Unit)? = null,
    /** Pull-to-refresh also re-reads the module flags, so a switched-off module is noticed. */
    onRefreshModules: suspend () -> Unit = {},
    /** After any successful write — bump the countdown chips, which read completion rhythms. */
    onChanged: () -> Unit = {},
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<RhythmsApi.Rhythm?>(null) }
    var booking by remember { mutableStateOf<RhythmsApi.AttentionItem?>(null) }
    var backdating by remember { mutableStateOf<RhythmsApi.Rhythm?>(null) }
    var confirmingDelete by remember { mutableStateOf<RhythmsApi.Rhythm?>(null) }
    var showPaused by remember { mutableStateOf(false) }
    var busyId by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    // Keyed on the member list too: members arrive over sync on their own schedule.
    LaunchedEffect(members) { model.setPersonNames(members.associate { it.id to it.name }) }
    LaunchedEffect(refreshKey) {
        model.loadAll()
        model.loadAttention()
    }

    fun run(id: String, work: suspend () -> Unit) {
        if (busyId != null) return
        busyId = id
        confirmingDelete = null
        scope.launch {
            try {
                work()
                onChanged()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = errorText(e)
            } finally {
                busyId = null
            }
        }
    }

    val actions = RowActions(
        busyId = busyId,
        onDone = { r -> run(r.id) { model.markDone(r.id) } },
        onBook = { booking = it },
        onSkip = { item -> run(item.rhythm.id) { model.skipPeriod(item) } },
        onBackdate = { backdating = it },
        onPush = { r -> run(r.id) { model.pushOut(r) } },
        onEdit = { editing = it },
        onToggleActive = { r -> run(r.id) { model.setActive(r.id, !r.isActive) } },
        onRetire = { confirmingDelete = it },
    )

    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = WF.colors.ink)
                }
            }
            Text(
                "Rhythms",
                style = WF.type.title,
                color = WF.colors.ink,
                modifier = Modifier.weight(1f).padding(start = if (onBack == null) 8.dp else 0.dp),
            )
            IconButton(onClick = { creating = true }) {
                Icon(Icons.Filled.Add, contentDescription = "New rhythm", tint = WF.colors.ink)
            }
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    try {
                        onRefreshModules()
                        model.loadAll()
                        model.loadAttention()
                    } finally {
                        refreshing = false
                    }
                }
            },
            modifier = Modifier.weight(1f),
        ) {
            // Every state lives in the one scrolling list, so pull-to-refresh works in all of them.
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = WF.spacing.tabBarClearance),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                when {
                    !state.listLoaded -> item("loading") { WaffledLoading() }
                    // A failed load and an empty household are not the same statement.
                    state.rhythms.isEmpty() -> item("empty") {
                        WaffledEmptyState(
                            emoji = if (state.listFailed) "😕" else "🔁",
                            title = if (state.listFailed) "Couldn’t load your rhythms" else "Nothing here yet",
                            message = if (state.listFailed) {
                                "Check your connection and pull to refresh. If Rhythms was just switched off in Settings → Modules, that would do it too."
                            } else {
                                "A rhythm is a standing intention with a cadence — trash weekly, the air filter every three months, a temple visit each quarter."
                            },
                        )
                    }
                    state.listFailed -> item("stale") {
                        Text(
                            "Showing what loaded last — the latest fetch didn’t come back.",
                            style = TextStyle(fontSize = 12.sp),
                            color = WF.colors.ink3,
                            modifier = Modifier.padding(horizontal = 4.dp),
                        )
                    }
                }

                for (band in state.bands) {
                    item("band-${band.title}") {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            BandHeader(band.title, band.hint, band.rhythms.size)
                            RowGroup(band.rhythms, band.urgency, state, model, actions)
                        }
                    }
                }

                if (state.paused.isNotEmpty()) {
                    item("paused") {
                        WaffledCard(padding = 0.dp) {
                            // Named, not counted: "2 paused" alone makes you open it to find out which.
                            Row(
                                Modifier.fillMaxWidth().clickable { showPaused = !showPaused }.padding(14.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                DisclosureChevron(isOpen = showPaused, size = 12.dp)
                                Text(
                                    "${state.paused.size} paused — ${state.paused.joinToString(", ") { it.title }}",
                                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                                    color = WF.colors.ink3,
                                )
                            }
                            if (showPaused) {
                                for (r in state.paused) {
                                    HorizontalDivider(color = WF.colors.hair)
                                    RegisterRow(r, RhythmFormat.Urgency.Paused, state, model, actions)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (creating) {
        RhythmEditorSheet(model, members, onDismiss = { creating = false }, onSaved = onChanged)
    }
    editing?.let { r ->
        RhythmEditorSheet(model, members, onDismiss = { editing = null }, editing = r, onSaved = onChanged)
    }
    booking?.let { item ->
        BookRhythmSheet(item, model, onDismiss = { booking = null }, onBooked = onChanged)
    }
    backdating?.let { r ->
        BackdateCompletionSheet(r, model, onDismiss = { backdating = null }, onLogged = onChanged)
    }
    confirmingDelete?.let { r ->
        AlertDialog(
            onDismissRequest = { confirmingDelete = null },
            title = { Text("Delete this rhythm?") },
            text = { Text("It stops surfacing everywhere. Pausing is the reversible option.") },
            confirmButton = {
                TextButton(onClick = { run(r.id) { model.delete(r.id) } }) { Text("Delete", color = WF.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmingDelete = null }) { Text("Cancel", color = WF.colors.ink2) } },
            containerColor = WF.colors.card,
            titleContentColor = WF.colors.ink,
            textContentColor = WF.colors.ink2,
        )
    }
    RhythmErrorDialog(error) { error = null }
}

private class RowActions(
    val busyId: String?,
    val onDone: (RhythmsApi.Rhythm) -> Unit,
    val onBook: (RhythmsApi.AttentionItem) -> Unit,
    val onSkip: (RhythmsApi.AttentionItem) -> Unit,
    val onBackdate: (RhythmsApi.Rhythm) -> Unit,
    val onPush: (RhythmsApi.Rhythm) -> Unit,
    val onEdit: (RhythmsApi.Rhythm) -> Unit,
    val onToggleActive: (RhythmsApi.Rhythm) -> Unit,
    val onRetire: (RhythmsApi.Rhythm) -> Unit,
)

@Composable
private fun BandHeader(title: String, hint: String, count: Int) {
    Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            SectionLabel(title)
            Text("$count", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink3)
        }
        Text(hint, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
    }
}

@Composable
private fun RowGroup(
    rhythms: List<RhythmsApi.Rhythm>,
    urgency: RhythmFormat.Urgency,
    state: RhythmsState,
    model: RhythmsModel,
    actions: RowActions,
) {
    WaffledCard(padding = 0.dp) {
        rhythms.forEachIndexed { i, r ->
            if (i > 0) HorizontalDivider(color = WF.colors.hair)
            RegisterRow(r, urgency, state, model, actions)
        }
    }
}

@Composable
private fun RegisterRow(
    r: RhythmsApi.Rhythm,
    urgency: RhythmFormat.Urgency,
    state: RhythmsState,
    model: RhythmsModel,
    actions: RowActions,
) {
    val doneToday = remember(r.lastCompletedAt, r.satisfiedBy) {
        r.shape == RhythmShape.Completion && RhythmFormat.wasCompletedToday(r.lastCompletedAt, model.now(), model.zone())
    }
    // Only Needs-you-now and Coming-up carry a verb, plus a just-done row acknowledging its tap.
    val showAction = urgency == RhythmFormat.Urgency.Now || urgency == RhythmFormat.Urgency.Soon || doneToday
    val countdown = state.countdowns[r.id]
    Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RhythmGlyph(r)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(r.title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                Text(state.detailLines[r.id].orEmpty(), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                state.progress[r.id]?.let { pct ->
                    RhythmProgressBar(pct, late = countdown?.tone == RhythmFormat.Countdown.Tone.Late, modifier = Modifier.padding(top = 4.dp))
                }
            }
            when {
                countdown != null -> RhythmCountdownLabel(countdown, muted = !r.isActive)
                !r.isActive -> WaffledStatusBadge(text = "Paused", color = WF.colors.ink3)
            }
            RowMenu(r, urgency, model, actions)
        }
        if (showAction) Verb(r, doneToday, primary = urgency == RhythmFormat.Urgency.Now, actions)
    }
}

/** Filled when late or out of time, quiet when merely coming up. */
@Composable
private fun Verb(r: RhythmsApi.Rhythm, doneToday: Boolean, primary: Boolean, actions: RowActions) {
    val fill: Color = if (primary) WF.colors.primary else WF.colors.panel
    val ink: Color = if (primary) Color.White else WF.colors.ink
    if (r.shape == RhythmShape.Completion) {
        RhythmActionButton(
            label = RhythmFormat.completionAction(doneToday, due = primary),
            tint = if (doneToday) WF.colors.successT else fill,
            labelColor = if (doneToday) WF.colors.success else ink,
            onClick = { actions.onDone(r) },
            busy = actions.busyId == r.id,
            disabled = doneToday,
            fullWidth = true,
        )
    } else {
        val item = RhythmsModel.openPeriod(r) ?: return
        RhythmActionButton(
            label = if (RhythmsModel.needsSeriesBack(r)) "Put it back" else "Book a time",
            tint = fill,
            labelColor = ink,
            onClick = { actions.onBook(item) },
            fullWidth = true,
        )
    }
}

/**
 * Push only while the rhythm is actually asking (Needs you now) — there is nothing to
 * defer on a Steady row. Completion shape only; Skip is the booking shape's version.
 */
private fun canPush(r: RhythmsApi.Rhythm, urgency: RhythmFormat.Urgency): Boolean =
    r.shape == RhythmShape.Completion && r.isActive && r.nextDueAt != null && urgency == RhythmFormat.Urgency.Now

@Composable
private fun RowMenu(r: RhythmsApi.Rhythm, urgency: RhythmFormat.Urgency, model: RhythmsModel, actions: RowActions) {
    var open by remember { mutableStateOf(false) }
    val period = RhythmsModel.openPeriod(r)
    Box {
        IconButton(onClick = { open = true }, enabled = actions.busyId != r.id, modifier = Modifier.size(28.dp)) {
            Icon(Icons.Filled.MoreHoriz, contentDescription = "More options for ${r.title}", tint = WF.colors.ink3)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = WF.colors.card) {
            fun pick(action: () -> Unit) {
                open = false
                action()
            }
            if (r.shape == RhythmShape.Completion) {
                MenuItem("Log it for another day", Icons.Filled.EditCalendar) { pick { actions.onBackdate(r) } }
                if (canPush(r, urgency)) MenuItem("Push it out a week", Icons.Filled.Update) { pick { actions.onPush(r) } }
            }
            if (period != null) {
                // Booking before the runway opens — `/attention` can't report that case.
                if (model.attentionItem(r) == null) {
                    MenuItem(
                        if (RhythmsModel.needsSeriesBack(r)) "Put it back on the calendar" else "Book a time",
                        Icons.Filled.EventAvailable,
                    ) { pick { actions.onBook(period) } }
                }
                // Never beside the verb: the rarer answer, and the one you can't take back.
                MenuItem("Mark handled", Icons.Filled.CheckCircleOutline) { pick { actions.onSkip(period) } }
            }
            MenuItem("Edit", Icons.Filled.Edit) { pick { actions.onEdit(r) } }
            MenuItem(
                if (r.isActive) "Pause" else "Resume",
                if (r.isActive) Icons.Filled.PauseCircle else Icons.Filled.PlayCircle,
            ) { pick { actions.onToggleActive(r) } }
            MenuItem("Retire", Icons.Filled.Delete, destructive = true) { pick { actions.onRetire(r) } }
        }
    }
}

@Composable
private fun MenuItem(text: String, icon: ImageVector, destructive: Boolean = false, onClick: () -> Unit) {
    val color = if (destructive) WF.colors.danger else WF.colors.ink
    DropdownMenuItem(
        text = { Text(text, color = color) },
        leadingIcon = { Icon(icon, contentDescription = null, tint = color) },
        onClick = onClick,
    )
}
