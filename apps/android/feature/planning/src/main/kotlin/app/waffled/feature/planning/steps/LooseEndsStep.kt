package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfField
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.LooseEnd
import app.waffled.feature.planning.api.LooseEndOwner
import app.waffled.feature.planning.api.LooseEndRoute
import app.waffled.feature.planning.api.PlanningLooseEndsApi
import kotlinx.coroutines.launch

/**
 * Weekly Planning · step 1 "Loose ends" — what is still open and what somebody parked, each
 * routed to the later step that will handle it. Port of iOS `LooseEndsStep.swift`; state,
 * copy and the choice table are in `LooseEndsModel.kt`. Content-sized: the shell scrolls.
 */
@Composable
fun LooseEndsStepBody(props: PlanningStepProps) {
    val env = props.env
    val model = remember(env) { PlanningLooseEndsModel.from(PlanningLooseEndsApi(env.http), env.api) }
    val state by model.state.collectAsState()
    val me by env.sync.currentPerson.collectAsState()
    val scope = rememberCoroutineScope()

    var group by rememberSaveable { mutableStateOf(LooseEndGroup.NotDone) }
    var seeAll by rememberSaveable { mutableStateOf(false) }
    var chooser by remember { mutableStateOf(false) }
    var ruling by remember { mutableStateOf<String?>(null) }
    // The crumb carries `routes`, so nothing is pushed until the seed has landed.
    var seeded by remember { mutableStateOf(false) }

    LaunchedEffect(props.sessionId, props.weekStart) {
        model.resetForWeek()
        model.seedRoutes(props.step.data["routes"])
        seeded = true
        model.load(props.weekStart, props.sessionId)
    }
    LaunchedEffect(seeded, state.routes, state.answered, state.openNotDone.size, state.openParked.size) {
        if (seeded) props.setDecisionData(state.decisionData)
    }
    LaunchedEffect(state.working) { props.reportBusy(state.working) }
    // Lends nothing: this step's own bar PARKS notes, so a verb that parked a parked note is circular.
    DisposableEffect(Unit) {
        props.lendVerb(null)
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    val disabled = props.busy || state.working

    fun refreshAfter(work: suspend () -> Boolean) {
        scope.launch { if (work()) props.refresh() }
    }

    val perform: (LooseEndChoice, LooseEnd, LooseEndGroup) -> Unit = { choice, item, g ->
        when (val act = choice.act) {
            is LooseEndChoice.Act.Route -> refreshAfter { model.send(item, g, act.to, props.sessionId) }
            is LooseEndChoice.Act.Settle -> refreshAfter { model.settle(item, act.action, props.weekStart, props.sessionId) }
            LooseEndChoice.Act.Leave -> model.leave(item)
        }
    }

    val canManage = me?.can("planning.manage") == true
    val showChooser = canManage && state.listCandidates.isNotEmpty() && (seeAll || group == LooseEndGroup.NotDone)

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        LooseEndsBar(state, group, seeAll, onGroup = { group = it; model.clearError() }, onToggleSeeAll = { seeAll = !seeAll })

        if (!seeAll) {
            Text(group.note, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
        }
        if (showChooser) {
            val all = state.listCandidates
            val on = all.count { it.relevant }
            Row(
                Modifier.clickable { chooser = true },
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Which lists?", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = WF.colors.ai)
                Text(
                    if (on == all.size) "asking about all ${all.size}" else "asking about $on of ${all.size}",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
        state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::clearError) }

        val capture: @Composable () -> Unit = {
            LooseEndsCaptureBar(disabled) { text, done ->
                scope.launch {
                    val ok = model.park(text, props.weekStart, props.sessionId)
                    done(ok)
                    if (ok) props.refresh()
                }
            }
        }

        when {
            !state.loaded -> WaffledLoading(top = 24.dp)
            state.view == null -> WaffledEmptyState(
                emoji = "🌐",
                title = "Couldn’t read your loose ends",
                message = "Check your connection and try again.",
                top = 24.dp,
            )
            seeAll -> SeeAllList(state, disabled, capture, perform)
            state.open(group).isNotEmpty() -> Deck(state, group, state.open(group).first(), disabled, perform)
            else -> Cleared(state, group) { group = it }
        }

        Trail(state, disabled) { route -> refreshAfter { model.undo(route, props.sessionId) } }

        if (group == LooseEndGroup.Parked && !seeAll) capture()
    }

    if (chooser) {
        ListsSheet(state, disabled, ruling, onDismiss = { chooser = false }) { id, on ->
            if (ruling == null) {
                ruling = id
                scope.launch {
                    model.ruleList(id, on, props.weekStart, props.sessionId)
                    ruling = null
                }
            }
        }
    }
}

@Composable
private fun LooseEndsBar(
    state: LooseEndsState,
    group: LooseEndGroup,
    seeAll: Boolean,
    onGroup: (LooseEndGroup) -> Unit,
    onToggleSeeAll: () -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (seeAll) {
            Text("Everything still open", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
        } else {
            // The switch carries both counts, so you know what is left in the group you aren't looking at.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LooseEndGroup.entries.forEach { g ->
                    val on = g == group
                    val left = state.remaining(g)
                    Row(
                        Modifier
                            .wfChip(selected = on)
                            .clickable { onGroup(g) }
                            .semantics { selected = on }
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(g.label, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = if (on) WF.colors.ink else WF.colors.ink2)
                        Text(
                            if (left == 0) "✓" else "$left",
                            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black),
                            color = if (on) WF.colors.primary else WF.colors.ink3,
                        )
                    }
                }
            }
        }
        Spacer(Modifier.weight(1f))
        Text(
            if (seeAll) "One at a time" else "See all",
            modifier = Modifier.clickable(onClick = onToggleSeeAll),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ai,
        )
    }
}

@Composable
internal fun PlanningOwnerChip(owner: LooseEndOwner) {
    Row(
        Modifier.semantics(mergeDescendants = true) { contentDescription = "${owner.name} has this" },
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarFromHex(colorHex = owner.colorHex, emoji = owner.avatarEmoji ?: "🙂", size = 18.dp)
        Text(owner.name, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2, maxLines = 1)
    }
}

@Composable
private fun Deck(
    state: LooseEndsState,
    group: LooseEndGroup,
    item: LooseEnd,
    disabled: Boolean,
    perform: (LooseEndChoice, LooseEnd, LooseEndGroup) -> Unit,
) {
    val total = state.total(group)
    val position = total - state.remaining(group) + 1
    val built = remember(item, group, state.view) { LooseEndChoice.build(item, group, state.destinations(group)) }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("$position of $total", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black), color = WF.colors.ink3)
        Box {
            // Two ghost cards peeking out below read as "a deck", not a single item.
            val shape = RoundedCornerShape(WF.radius.lg)
            Box(Modifier.fillMaxWidth().padding(horizontal = 18.dp).offset(y = 12.dp).height(40.dp).alpha(0.5f).background(WF.colors.card, shape))
            Box(Modifier.fillMaxWidth().padding(horizontal = 9.dp).offset(y = 6.dp).height(40.dp).alpha(0.75f).background(WF.colors.card, shape))
            WaffledCard(padding = 16.dp) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        SectionLabel(LooseEndCopy.kindLabel(item.kind))
                        item.owner?.let { PlanningOwnerChip(it) }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        item.emoji?.takeIf { it.isNotEmpty() }?.let { Text(it, style = TextStyle(fontSize = 20.sp)) }
                        Text(item.title, style = WF.type.serif(20.sp), color = WF.colors.ink)
                    }
                    item.detail?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
                    }
                    Column(Modifier.padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        built.choices.forEach { choice -> ChoiceButton(choice, disabled) { perform(choice, item, group) } }
                    }
                    if (built.quiet.isNotEmpty()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            built.quiet.forEach { choice ->
                                Text(
                                    choice.label,
                                    modifier = Modifier.clickable(enabled = !disabled) { perform(choice, item, group) },
                                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                                    color = WF.colors.ink2,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Full width: at phone width four destinations would each be a truncated column, and the hint is half the choice. */
@Composable
private fun ChoiceButton(choice: LooseEndChoice, disabled: Boolean, onClick: () -> Unit) {
    // A primary fills with ink, so its text takes onInk — white would vanish once ink flips in dark.
    val fg = if (choice.isPrimary) WF.colors.onInk else WF.colors.ink
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (disabled) 0.6f else 1f)
            .background(if (choice.isPrimary) WF.colors.ink else WF.colors.panel, shape)
            .clickable(enabled = !disabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(choice.label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = fg)
            Text(choice.hint, style = TextStyle(fontSize = 12.sp), color = if (choice.isPrimary) fg.copy(alpha = 0.75f) else WF.colors.ink3)
        }
        if (choice.act is LooseEndChoice.Act.Route) {
            Text("→", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black), color = if (choice.isPrimary) fg.copy(alpha = 0.8f) else WF.colors.ink3)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SeeAllList(
    state: LooseEndsState,
    disabled: Boolean,
    capture: @Composable () -> Unit,
    perform: (LooseEndChoice, LooseEnd, LooseEndGroup) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(
            LooseEndCopy.DISCLAIMER,
            modifier = Modifier.fillMaxWidth().wfField(fill = WF.colors.panel).padding(11.dp),
            style = TextStyle(fontSize = 12.5.sp),
            color = WF.colors.ink2,
        )
        LooseEndGroup.entries.forEach { g ->
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(g.label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                    val left = state.remaining(g)
                    Text(if (left == 0) "✓" else "$left", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black), color = WF.colors.primary)
                    Text("· ${g.caption}", style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                }
                val open = state.open(g)
                if (open.isEmpty()) {
                    Text(
                        if (g == LooseEndGroup.Parked) "Nothing parked is waiting." else "Nothing left open.",
                        style = TextStyle(fontSize = 13.sp),
                        color = WF.colors.ink3,
                    )
                } else {
                    open.forEach { item -> SeeAllRow(state, item, g, disabled, perform) }
                }
                // Reachable in both modes: "See all" must not be the one place you can't write something down.
                if (g == LooseEndGroup.Parked) capture()
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SeeAllRow(
    state: LooseEndsState,
    item: LooseEnd,
    g: LooseEndGroup,
    disabled: Boolean,
    perform: (LooseEndChoice, LooseEnd, LooseEndGroup) -> Unit,
) {
    val built = remember(item, g, state.view) { LooseEndChoice.build(item, g, state.destinations(g)) }
    // Every destination and every writing answer as a pill; "leave it" has no row form.
    val pills = (built.choices + built.quiet).filter { it.act !is LooseEndChoice.Act.Leave }
    WaffledCard(padding = 12.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(item.emoji?.takeIf { it.isNotEmpty() } ?: "•", style = TextStyle(fontSize = 15.sp))
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(item.title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(
                            LooseEndCopy.kindLabel(item.kind).uppercase(),
                            style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp),
                            color = WF.colors.ink3,
                        )
                        item.detail?.takeIf { it.isNotEmpty() }?.let { Text(it, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3) }
                        item.owner?.let { PlanningOwnerChip(it) }
                    }
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                pills.forEach { choice ->
                    val shape = RoundedCornerShape(WF.radius.pill)
                    Text(
                        choice.label,
                        modifier = Modifier
                            .alpha(if (disabled) 0.6f else 1f)
                            .background(if (choice.isPrimary) WF.colors.ink else WF.colors.panel, shape)
                            .clickable(enabled = !disabled) { perform(choice, item, g) }
                            .padding(horizontal = 11.dp, vertical = 6.dp),
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                        color = if (choice.isPrimary) WF.colors.onInk else WF.colors.ink2,
                    )
                }
            }
        }
    }
}

@Composable
private fun Cleared(state: LooseEndsState, group: LooseEndGroup, onGo: (LooseEndGroup) -> Unit) {
    val other = group.other
    val waiting = state.remaining(other)
    Column(
        Modifier.fillMaxWidth().padding(vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("✓", style = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Black), color = WF.colors.success)
        Text(LooseEndCopy.clearedTitle(group), style = WF.type.serif(20.sp), color = WF.colors.ink)
        Text(
            LooseEndCopy.clearedSubtitle(group, state.view?.sources.orEmpty(), waiting),
            style = TextStyle(fontSize = 13.sp),
            color = WF.colors.ink3,
            textAlign = TextAlign.Center,
        )
        if (waiting > 0) {
            WaffledPrimaryCTA(label = "Go to ${other.label}", onClick = { onGo(other) }, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
private fun Trail(state: LooseEndsState, disabled: Boolean, onUndo: (LooseEndRoute) -> Unit) {
    val items = state.trail
    if (items.isEmpty()) return
    var open by rememberSaveable { mutableStateOf(false) }
    val shown = if (open) items else items.take(3)
    Column(
        Modifier.fillMaxWidth().wfField(fill = WF.colors.panel).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(LooseEndCopy.TRAIL_CAPTION, style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
        shown.forEachIndexed { index, route ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    route.title,
                    modifier = Modifier.weight(1f, fill = false),
                    style = TextStyle(fontSize = 13.sp, fontWeight = if (index == 0) FontWeight.Bold else FontWeight.SemiBold),
                    color = if (index == 0) WF.colors.ink else WF.colors.ink2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text("→", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink3)
                Text(state.stepName(route.to), style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
                Spacer(Modifier.weight(1f))
                Text(
                    "Undo",
                    modifier = Modifier
                        .clickable(enabled = !disabled) { onUndo(route) }
                        .semantics { contentDescription = "Undo sending ${route.title}" },
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ai,
                )
            }
        }
        if (!open && items.size > 3) {
            PlanningTextAction("Show all ${items.size}", enabled = true, tint = WF.colors.ai) { open = true }
        }
    }
}

/** [onPark] reports whether the note landed, so the field is cleared only then. */
@Composable
private fun LooseEndsCaptureBar(disabled: Boolean, onPark: (String, (Boolean) -> Unit) -> Unit) {
    var note by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val canPark = !disabled && note.isNotBlank()
    fun park() {
        if (!canPark) return
        onPark(note) { ok ->
            if (ok) {
                note = ""
                // Parking is a burst, so the cursor goes back rather than making you re-aim.
                runCatching { focus.requestFocus() }
            }
        }
    }
    PlanningCaptureBar(
        value = note,
        onValueChange = { note = it },
        placeholder = LooseEndCopy.CAPTURE_PLACEHOLDER,
        glyph = "＋",
        onSubmit = ::park,
        focus = focus,
    ) {
        PlanningTextAction("Park it", enabled = canPark, tint = WF.colors.primary, onClick = ::park)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ListsSheet(
    state: LooseEndsState,
    disabled: Boolean,
    ruling: String?,
    onDismiss: () -> Unit,
    onRule: (String, Boolean) -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Lists it asks about", modifier = Modifier.weight(1f), style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                PlanningTextAction("Done", enabled = true, tint = WF.colors.primary, onClick = onDismiss)
            }
            Text(
                "This step asks about anything still unchecked from before this week. Turn off a list that’s meant to stay open — a someday list, a wishlist — and it stops coming up every session. Your grocery list is never asked about: it rebuilds itself from the meal plan.",
                style = TextStyle(fontSize = 12.5.sp),
                color = WF.colors.ink3,
            )
            WaffledCard(padding = 4.dp) {
                state.listCandidates.forEachIndexed { i, list ->
                    if (i > 0) HorizontalDivider(color = WF.colors.hair)
                    Row(
                        Modifier.fillMaxWidth().alpha(if (ruling == list.id) 0.5f else 1f).padding(11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            listOfNotNull(list.emoji, list.name).joinToString(" "),
                            modifier = Modifier.weight(1f),
                            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                        )
                        Switch(
                            checked = list.relevant,
                            onCheckedChange = { onRule(list.id, it) },
                            enabled = !disabled && ruling == null,
                            modifier = Modifier.semantics { contentDescription = "Ask about ${list.name} in the weekly planning session" },
                            colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
                        )
                    }
                }
            }
        }
    }
}
