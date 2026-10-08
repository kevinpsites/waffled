package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfField
import app.waffled.feature.goals.GoalCreateSheet
import app.waffled.feature.goals.GoalDisplay
import app.waffled.feature.goals.GoalDraft
import app.waffled.feature.goals.GoalProgressBar
import app.waffled.feature.goals.GoalsAccess
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.goals.goalCategoryColor
import app.waffled.feature.goals.goalCategoryEmoji
import app.waffled.feature.goals.goalFmt
import app.waffled.feature.planning.PlanningPaceTone
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.PlanningGoalGoal
import app.waffled.feature.planning.api.PlanningGoalGroup
import app.waffled.feature.planning.api.PlanningGoalMember
import app.waffled.feature.planning.api.PlanningGoalsApi
import app.waffled.feature.planning.api.asGoalList
import app.waffled.feature.planning.planningOptionChrome
import kotlinx.coroutines.launch

/**
 * Weekly Planning · step 6 "Goals" — "What's each group's focus this week?" Port of iOS
 * `GoalsStepView`. The tabs are the `goal_lists` that already exist; picking a goal sets
 * the goals module's own `is_featured`, and picking NOTHING settles the group the same.
 *
 * The crumb MIRRORS server state after every read and write (the affirmative REPLACES the
 * step's data), and is never pushed as null: a nil here is the wipe, not "no news".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalsStepBody(props: PlanningStepProps) {
    val model = remember(props.sessionId) {
        PlanningGoalsStepModel(PlanningGoalsApi(props.env.http), GoalsApi(props.env.client, props.env.tokens))
    }
    val state by model.state.collectAsState()
    val me by props.env.sync.currentPerson.collectAsState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(props.sessionId) { model.load(props.sessionId) }
    LaunchedEffect(state.rev) { state.crumb?.let(props.setDecisionData) }
    LaunchedEffect(state.savingListId, state.creating) {
        props.reportBusy(state.savingListId != null || state.creating)
    }
    DisposableEffect(Unit) {
        props.lendVerb(null)
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            !state.loaded -> WaffledLoading()
            state.view == null -> WaffledEmptyState(
                emoji = "🎯",
                title = "Couldn’t read your goals",
                message = "Reload, or skip this step — skipping is a real answer.",
            )
            state.groups.isEmpty() -> WaffledEmptyState(
                emoji = "🎯",
                title = "No goal groups yet",
                message = "Make one on the Goals screen and this step will have something to ask about. Skipping is a real answer in the meantime.",
            )
            else -> {
                GoalTabs(state, onSelect = model::selectTab)
                state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }
                state.active?.let { g ->
                    val frozen = state.isFrozen(props.busy)
                    GroupCard(
                        g = g,
                        frozen = frozen,
                        canAdd = PlanningGoalsStepModel.canTarget(g, GoalsAccess.canManage(me), me?.id),
                        onPick = { goalId ->
                            if (!state.isFrozen(props.busy)) {
                                scope.launch {
                                    model.pick(props.sessionId, g.listId, goalId)
                                    props.refresh()
                                }
                            }
                        },
                        onTarget = { goalId, target ->
                            if (!model.current.isFrozen(props.busy)) {
                                scope.launch { model.setWeekTarget(props.sessionId, goalId, target) }
                            }
                        },
                        onNewGoal = model::openNewGoal,
                    )
                }
            }
        }
    }

    state.newGoalGroup?.let { g ->
        ModalBottomSheet(
            onDismissRequest = model::closeNewGoal,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            GoalCreateSheet(
                lists = listOf(g.asGoalList()),
                // Pinned on the way in, so the server adopts it as the group's lone pin.
                initial = GoalDraft.new(defaultListId = g.listId).copy(isFeatured = true),
                onDismiss = model::closeNewGoal,
                lockedGroupId = g.listId,
                allowNewGroup = false,
                onSubmit = { body, _ ->
                    // The GROUP IS CAPTURED HERE: the editor closes itself on submit.
                    val target = g.listId
                    scope.launch {
                        // Only refresh on a real save: a refresh greys the step out, a second
                        // false failure on top of the banner.
                        if (model.submitNewGoal(props.sessionId, target, body)) props.refresh()
                    }
                },
            )
        }
    }
}

@Composable
private fun GoalTabs(state: PlanningGoalsStepState, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Row(
            Modifier
                .horizontalScroll(rememberScrollState())
                .padding(2.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            state.groups.forEach { g ->
                val on = g.listId == state.active?.listId
                Row(
                    Modifier
                        .wfChip(selected = on)
                        .clickable { onSelect(g.listId) }
                        .semantics {
                            selected = on
                            contentDescription = if (g.settled) "${g.name}, settled" else g.name
                        }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(g.emoji ?: "🎯", fontSize = 14.sp)
                    Text(
                        g.name,
                        style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold),
                        color = if (on) WF.colors.ink else WF.colors.ink2,
                        maxLines = 1,
                    )
                    if (g.isPrivate) Text("🔒", fontSize = 10.sp)
                    if (g.settled) Text("★", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = WF.colors.gold)
                }
            }
        }
        Text(
            "${state.settledCount} of ${state.groups.size} settled",
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
    }
}

@Composable
private fun GroupCard(
    g: PlanningGoalGroup,
    frozen: Boolean,
    canAdd: Boolean,
    onPick: (String?) -> Unit,
    onTarget: (String, Double?) -> Unit,
    onNewGoal: () -> Unit,
) {
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            GroupHeader(g)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                g.goals.forEach { item ->
                    // The target row shares the goal's frame, so it can't read as the next goal's.
                    Column(Modifier.fillMaxWidth().planningOptionChrome(selected = g.focusGoalId == item.goal.id)) {
                        GoalOption(item, checked = g.focusGoalId == item.goal.id, frozen = frozen) { onPick(item.goal.id) }
                        if (item.weekTargetable) {
                            Box(Modifier.padding(horizontal = 10.dp).fillMaxWidth().height(1.dp).background(WF.colors.hair))
                            WeekTargetRow(item, frozen) { onTarget(item.id, it) }
                        }
                    }
                }
                NothingOption(g, frozen) { onPick(null) }
            }
            Text(
                PlanningGoalsText.verdict(g),
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = if (g.settled && g.focusGoalId != null) WF.colors.ink else WF.colors.ink3,
            )
            NewGoalButton(g, off = frozen || !canAdd, allowed = canAdd, onClick = onNewGoal)
        }
    }
}

@Composable
private fun NewGoalButton(g: PlanningGoalGroup, off: Boolean, allowed: Boolean, onClick: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            "＋ New goal for this week",
            modifier = Modifier.clickable(enabled = !off, onClick = onClick),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            color = if (off) WF.colors.ink3 else WF.colors.primary,
        )
        if (!allowed) {
            Text(
                "Adding a goal to ${g.name} needs permission to manage goals",
                style = TextStyle(fontSize = 11.5.sp),
                color = WF.colors.ink3,
            )
        }
    }
}

@Composable
private fun GroupHeader(g: PlanningGoalGroup) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        WaffledEmojiTile(emoji = g.emoji ?: "🎯")
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(g.name, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                if (g.isPrivate) Text("🔒", fontSize = 11.sp)
            }
            Text(PlanningGoalsText.groupSubtitle(g), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
        MemberStack(g.members)
    }
}

@Composable
private fun MemberStack(members: List<PlanningGoalMember>) {
    // A negative gap is the overlap; the card ring keeps neighbours apart.
    Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
        members.take(4).forEach { m ->
            Box(
                Modifier
                    .background(WF.colors.card, androidx.compose.foundation.shape.CircleShape)
                    .padding(1.5.dp)
                    .semantics { contentDescription = m.name },
            ) {
                AvatarFromHex(colorHex = m.colorHex, emoji = m.avatarEmoji ?: "🙂", size = 23.dp)
            }
        }
    }
}

@Composable
private fun GoalOption(item: PlanningGoalGoal, checked: Boolean, frozen: Boolean, onClick: () -> Unit) {
    val g = item.goal
    // ALWAYS through the shared helper; an inline `totalProgress` is the bug it prevents.
    val progress = GoalDisplay.progress(g)
    val target = GoalDisplay.target(g)
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (frozen) 0.6f else 1f)
            .clickable(enabled = !frozen, onClick = onClick)
            .semantics { selected = checked }
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(g.emoji ?: goalCategoryEmoji(g.category), fontSize = 19.sp, modifier = Modifier.width(26.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(g.title, style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    PlanningGoalsText.kindLabel(g),
                    style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
                item.pace?.let { pace ->
                    Text("·", fontSize = 11.5.sp, color = WF.colors.ink3)
                    Text(
                        pace.text,
                        style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                        color = PlanningPaceTone.color(pace.tone),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            GoalProgressBar(
                value = GoalDisplay.fraction(g).toFloat(),
                tint = goalCategoryColor(g.category),
                track = WF.colors.panel,
                height = 6.dp,
            )
        }
        Column(Modifier.widthIn(min = 54.dp), horizontalAlignment = Alignment.End) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(goalFmt(progress), style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink)
                if (target != null) {
                    Text(
                        "/ ${goalFmt(target)}",
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
            Text(
                PlanningGoalsText.axisLabel(g),
                style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
                maxLines = 1,
            )
        }
        Star(checked)
    }
}

@Composable
private fun Star(on: Boolean) {
    Text(
        if (on) "★" else "",
        modifier = Modifier.width(14.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.gold,
    )
}

@Composable
private fun NothingOption(g: PlanningGoalGroup, frozen: Boolean, onClick: () -> Unit) {
    val checked = g.settled && g.focusGoalId == null
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (frozen) 0.6f else 1f)
            .planningOptionChrome(selected = checked)
            .clickable(enabled = !frozen, onClick = onClick)
            .semantics { selected = checked }
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("🤍", fontSize = 19.sp, modifier = Modifier.width(26.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("Nothing this week", style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(
                if (g.goals.isEmpty()) "This group has no goals yet." else "No goal needs the spotlight — leave the week clear.",
                style = TextStyle(fontSize = 11.5.sp),
                color = WF.colors.ink3,
            )
        }
        Star(checked)
    }
}

/** This week's slice of a goal, under its option. Saved when the box is left or on Done. */
@Composable
private fun WeekTargetRow(item: PlanningGoalGoal, frozen: Boolean, onSave: (Double?) -> Unit) {
    var text by remember(item.weekTarget) { mutableStateOf(PlanningGoalsText.targetText(item.weekTarget)) }
    var focused by remember { mutableStateOf(false) }

    fun commit() {
        when (val entry = PlanningGoalsText.parseTarget(text)) {
            PlanningGoalsText.TargetEntry.Clear -> if (item.weekTarget != null) onSave(null)
            is PlanningGoalsText.TargetEntry.Set -> if (entry.value != item.weekTarget) onSave(entry.value)
            PlanningGoalsText.TargetEntry.Invalid -> text = PlanningGoalsText.targetText(item.weekTarget)
        }
    }

    Row(
        // Lined up under the goal's title: the option's 10dp inset, 26dp emoji and 10dp gap.
        Modifier.padding(start = 46.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("This week’s target", style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
            Text(
                PlanningGoalsText.weekLine(item),
                style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        Spacer(Modifier.width(0.dp))
        BasicTextField(
            value = text,
            onValueChange = { text = it },
            enabled = !frozen,
            singleLine = true,
            textStyle = TextStyle(
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = WF.colors.ink,
                textAlign = TextAlign.Center,
            ),
            cursorBrush = SolidColor(WF.colors.primary),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { commit() }),
            modifier = Modifier
                .width(88.dp)
                .wfField()
                .padding(horizontal = 10.dp, vertical = 9.dp)
                .onFocusChanged { f ->
                    if (focused && !f.isFocused) commit()
                    focused = f.isFocused
                }
                .semantics { contentDescription = "This week’s target for ${item.goal.title}" },
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.Center) {
                    if (text.isEmpty()) Text("—", fontSize = 16.sp, color = WF.colors.ink3)
                    inner()
                }
            },
        )
    }
}
