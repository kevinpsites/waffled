package app.waffled.feature.planning.steps

import android.content.ClipData
import android.content.ClipDescription
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.draganddrop.dragAndDropSource
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.DragAndDropTransferData
import androidx.compose.ui.draganddrop.mimeTypes
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
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
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.wfField
import app.waffled.core.design.wfShadow1
import app.waffled.core.model.Capability
import app.waffled.core.network.RefreshDomain
import app.waffled.feature.chores.ChoreEditSheet
import app.waffled.feature.chores.ChoreEditorTarget
import app.waffled.feature.chores.ChoreRow
import app.waffled.feature.chores.ChoresApi
import app.waffled.feature.planning.PlanningHandoffVerb
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.PlanningApi
import app.waffled.feature.planning.api.PlanningTasksApi
import app.waffled.feature.planning.api.PlanningTasksBoard
import app.waffled.feature.planning.api.PlanningTasksChore
import app.waffled.feature.planning.api.PlanningTasksPerson
import app.waffled.feature.planning.api.PlanningTasksRhythm
import app.waffled.feature.planning.api.asChoreInstance
import kotlinx.coroutines.launch

/**
 * Weekly Planning · step 8 "Tasks" — "Who's doing what?" Port of iOS `TasksStepView`:
 * per-person blocks, an up-for-grabs strip, rhythms due this week, and the app's own
 * `ChoreEditSheet`. No lazy list or scroll here — the shell owns scrolling and insets.
 * The drag payload is local state under a non-text MIME type, so no field accepts it.
 */
@Composable
fun TasksStepBody(props: PlanningStepProps) {
    val env = props.env
    val choresApi = remember(env) { ChoresApi(env.client, env.tokens) }
    val model = remember(props.sessionId) {
        val api = PlanningTasksApi(env.http, choresApi)
        PlanningTasksModel(
            fetchBoard = { api.board(it) },
            handOut = { chore, personId -> api.handOut(chore, personId) },
            saveChore = { id, body -> if (id != null) choresApi.updateChore(id, body) else choresApi.createChore(body) },
            complete = { choresApi.complete(it) },
            settleRhythm = { id, sessionId -> PlanningApi(env.client, env.tokens).resolveLooseEnd("rhythm", id, "done", sessionId) },
        )
    }
    val state by model.state.collectAsState()
    val me by env.sync.currentPerson.collectAsState()
    val members by env.sync.members.collectAsState()
    var currencies by remember { mutableStateOf<List<ChoresApi.Currency>>(emptyList()) }
    val scope = rememberCoroutineScope()

    // Moving a task between people is `chore.manage`; don't offer a tap that 403s.
    val canAssign = me?.can(Capability.CHORE_MANAGE) == true
    val frozen = props.busy || state.savingChoreId != null
    val canDrop = canAssign && !frozen

    LaunchedEffect(props.weekStart) { model.load(props.weekStart) }
    LaunchedEffect(Unit) { runCatching { currencies = choresApi.currencies() } }
    // Both halves of the crumb: `rev` covers what's still up for grabs, `assigned` the tally.
    LaunchedEffect(state.rev, state.assigned) { if (state.board != null) props.setDecisionData(state.crumb) }
    LaunchedEffect(state.savingChoreId) { props.reportBusy(state.savingChoreId != null) }
    DisposableEffect(model) {
        props.lendVerb(PlanningHandoffVerb("Make a task") { note, done -> model.beginHandoff(note, done) })
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
            // A note still in an open composer is unfinished; the banner must be told so.
            model.abandonHandoff()
        }
    }

    fun reload() {
        scope.launch {
            model.load(props.weekStart)
            env.refreshBus.bump(RefreshDomain.Chores)
            props.refresh()
        }
    }

    fun give(chore: PlanningTasksChore, personId: String?) {
        scope.launch { if (model.give(chore, personId, props.weekStart)) props.refresh() }
    }

    fun drop(choreId: String, column: PlanningTaskColumn) {
        scope.launch { if (model.drop(choreId, column, props.weekStart)) props.refresh() }
    }

    var hovered by remember { mutableStateOf<PlanningTaskColumn?>(null) }
    val symbol: (String?) -> String = { key ->
        (key?.let { k -> currencies.firstOrNull { it.key == k } } ?: currencies.firstOrNull { it.isDefault })?.symbol ?: "⭐"
    }

    val ctx = TaskCardContext(
        state = state,
        canAssign = canAssign,
        frozen = frozen,
        symbol = symbol,
        onEdit = model::openEdit,
        onDone = { chore -> scope.launch { model.markDone(chore, props.weekStart) } },
        onGive = ::give,
    )

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }
        state.notice?.let {
            Text(
                it,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
        }
        val board = state.board
        when {
            board != null -> {
                UpForGrabsStrip(
                    board = board,
                    ctx = ctx,
                    busy = props.busy,
                    onAdd = { model.openAdd(null) },
                    modifier = Modifier.taskDropTarget(PlanningTaskColumn.UpForGrabs, canDrop, hovered, { hovered = it }, ::drop),
                )
                board.people.forEach { person ->
                    PersonBlock(
                        person = person,
                        board = board,
                        ctx = ctx,
                        busy = props.busy,
                        onAdd = { model.openAdd(person.id) },
                        modifier = Modifier.taskDropTarget(
                            PlanningTaskColumn.Person(person.id), canDrop, hovered, { hovered = it }, ::drop,
                        ),
                    )
                }
                if (board.rhythms.isNotEmpty()) {
                    RhythmsBlock(board.rhythms, frozen) { rhythm ->
                        scope.launch { model.settleRhythm(rhythm, props.sessionId, props.weekStart) }
                    }
                }
            }
            state.loaded -> WaffledEmptyState(
                emoji = "🧹",
                title = "Couldn't load the chores board",
                message = "Try again in a moment — nothing has been changed.",
            )
            else -> WaffledLoading()
        }
    }

    state.composer?.let { composer ->
        // Managers can assign to anyone; everyone else only to themselves (web parity).
        val assignable = if (canAssign) members else members.filter { it.id == me?.id }
        val target = remember(composer) {
            when (composer) {
                is PlanningTasksComposer.Add -> ChoreEditorTarget.New(composer.personId)
                is PlanningTasksComposer.Edit -> ChoreEditorTarget.Edit(
                    ChoreRow(composer.chore.asChoreInstance(composer.owner), null, null, null, null, null),
                )
            }
        }
        // The day the SERVER picked for this session, never this phone's today.
        val day = (composer as? PlanningTasksComposer.Edit)?.chore?.dueOn ?: state.newTaskDay ?: props.weekStart
        // The editor presents its own bottom sheet; a cancel and a save both arrive as onDismiss.
        ChoreEditSheet(
            target = target,
            assignableMembers = assignable,
            currencies = currencies,
            initialDate = day,
            onSave = { id, body -> model.saveFromComposer(id, body) },
            // This step asks who does what, not which chores should exist.
            onDelete = { _, _ -> "Deleting isn’t part of planning a week." },
            onDismiss = { if (model.composerDismissed()) reload() },
            initialTitle = (composer as? PlanningTasksComposer.Add)?.note,
            canDelete = false,
        )
    }
}

/** What every card needs from the step, bundled so the card functions stay short. */
private class TaskCardContext(
    val state: PlanningTasksState,
    val canAssign: Boolean,
    val frozen: Boolean,
    val symbol: (String?) -> String,
    val onEdit: (PlanningTasksChore, String?) -> Unit,
    val onDone: (PlanningTasksChore) -> Unit,
    val onGive: (PlanningTasksChore, String?) -> Unit,
)

/**
 * A column as a drop target, with the ring that says so. Disabled attaches no target at
 * all, rather than one that refuses on arrival. A drop always reports success: a card
 * dropped where it already sits is harmless, not a rejection.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Modifier.taskDropTarget(
    column: PlanningTaskColumn,
    enabled: Boolean,
    hovered: PlanningTaskColumn?,
    setHovered: (PlanningTaskColumn?) -> Unit,
    onDrop: (String, PlanningTaskColumn) -> Unit,
): Modifier {
    if (!enabled) return this
    val latestDrop by rememberUpdatedState(onDrop)
    val latestHover by rememberUpdatedState(setHovered)
    val target = remember(column) {
        object : DragAndDropTarget {
            override fun onDrop(event: DragAndDropEvent): Boolean {
                latestHover(null)
                val id = PlanningTaskDrag.choreId(event.toAndroidDragEvent().localState) ?: return false
                latestDrop(id, column)
                return true
            }

            override fun onEntered(event: DragAndDropEvent) = latestHover(column)
            override fun onExited(event: DragAndDropEvent) = latestHover(null)
            override fun onEnded(event: DragAndDropEvent) = latestHover(null)
        }
    }
    val shape = RoundedCornerShape(WF.radius.lg)
    return this
        .border(2.dp, if (hovered == column) WF.colors.primary else Color.Transparent, shape)
        .dragAndDropTarget(
            shouldStartDragAndDrop = { it.mimeTypes().contains(PlanningTaskDrag.MIME_TYPE) },
            target = target,
        )
}

@Composable
private fun UpForGrabsStrip(
    board: PlanningTasksBoard,
    ctx: TaskCardContext,
    busy: Boolean,
    onAdd: () -> Unit,
    modifier: Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        Modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            // The Chores board's own up-for-grabs tint, as tokens so dark mode comes free.
            .background(Brush.linearGradient(listOf(WF.colors.aiT, WF.colors.infoT)), shape)
            .clip(shape)
            .then(modifier)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(34.dp).background(WF.colors.card.copy(alpha = 0.6f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Text("🙌", fontSize = 17.sp) }
                Text("Up for grabs", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            }
            // The drag hint is in the copy because a drag is otherwise undiscoverable.
            Text(
                when {
                    board.unassigned.isEmpty() -> "✓ Everything's handed out."
                    ctx.canAssign -> "Tap a face (or long-press a card's grip and drag) to hand one over. Leaving one up for grabs is a real answer — whoever does it gets the stars."
                    else -> "Whoever does one gets the stars."
                },
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
        }
        board.unassigned.forEach { ChoreCard(it, owner = null, board = board, ctx = ctx) }
        AddButton("Add a task", busy, onAdd)
    }
}

@Composable
private fun PersonBlock(
    person: PlanningTasksPerson,
    board: PlanningTasksBoard,
    ctx: TaskCardContext,
    busy: Boolean,
    onAdd: () -> Unit,
    modifier: Modifier,
) {
    WaffledCard(modifier = modifier, padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                AvatarFromHex(colorHex = person.colorHex, emoji = person.avatarEmoji ?: "🙂", size = 34.dp)
                Text(
                    person.name,
                    modifier = Modifier.weight(1f),
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Text(
                    "${person.chores.size} this week",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            if (person.chores.isEmpty()) {
                Text("Nothing on ${person.name}'s week yet.", style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
            } else {
                person.chores.forEach { ChoreCard(it, owner = person.id, board = board, ctx = ctx) }
            }
            AddButton("Add for ${person.name}", busy, onAdd)
            Text(
                ctx.state.carries[person.id].orEmpty(),
                style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
    }
}

/** Rhythms needing attention in the planned week. Done only where the server says it applies. */
@Composable
private fun RhythmsBlock(rhythms: List<PlanningTasksRhythm>, frozen: Boolean, onDone: (PlanningTasksRhythm) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(text = "Rhythms this week")
        rhythms.forEach { rhythm ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
                    .padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    (rhythm.emoji?.let { "$it " } ?: "") + rhythm.title,
                    modifier = Modifier.weight(1f),
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                TaskChip(rhythm.detail, unset = false)
                if (rhythm.canComplete) {
                    TaskChip(
                        "✓ Done",
                        unset = false,
                        modifier = Modifier
                            .clickable(enabled = !frozen) { onDone(rhythm) }
                            .semantics { contentDescription = "Mark ${rhythm.title} done" },
                    )
                }
            }
        }
    }
}

// A card has sibling regions — grip, title block, day chip, Done, faces, reward badge —
// so no tap has to be stopped from reaching a parent. The grip, not the card, is the drag
// source, so a drag never fights the taps beside it.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChoreCard(chore: PlanningTasksChore, owner: String?, board: PlanningTasksBoard, ctx: TaskCardContext) {
    val s = ctx.state
    val unset = s.dayUnset[chore.id] ?: false
    // Unset AND settable reads as an invitation; unset otherwise stays a statement of fact.
    val settable = ctx.canAssign && (s.daySettable[chore.id] ?: false)
    val chipText = if (unset && settable) "Set a day" else s.dayChip[chore.id].orEmpty()

    Column(
        Modifier
            .fillMaxWidth()
            .alpha(if (s.savingChoreId == chore.id) 0.55f else 1f)
            .wfField(radius = WF.radius.md, fill = WF.colors.panel)
            .padding(11.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            // The PERMISSION only, never `frozen`: freezing mid-drag would delete the source.
            if (ctx.canAssign) Grip(chore)
            val titleModifier = if (ctx.canAssign) {
                Modifier
                    .clickable(enabled = !ctx.frozen) { ctx.onEdit(chore, owner) }
                    .semantics { contentDescription = "Edit ${chore.title}" }
            } else {
                Modifier
            }
            Column(titleModifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    (chore.emoji?.let { "$it " } ?: "") + chore.title,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Text(
                    s.provenance[chore.id].orEmpty(),
                    style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TaskChip(
                chipText,
                unset = unset,
                modifier = if (settable) {
                    Modifier
                        .clickable(enabled = !ctx.frozen) { ctx.onEdit(chore, owner) }
                        .semantics { contentDescription = "Set the day for ${chore.title}" }
                } else {
                    Modifier
                },
            )
            // Not gated on chore.manage: any member may finish a task, the server's rule.
            if (chore.completableInstanceId != null) {
                TaskChip(
                    "✓ Done",
                    unset = false,
                    modifier = Modifier
                        .clickable(enabled = !ctx.frozen) { ctx.onDone(chore) }
                        .semantics { contentDescription = "Mark ${chore.title} done" },
                )
            }
            Spacer(Modifier.weight(1f))
            if (chore.rewardAmount > 0) {
                WaffledStatusBadge(text = "${ctx.symbol(chore.rewardCurrency)} ${rewardText(chore.rewardAmount)}", color = WF.colors.gold)
            }
        }
        if (ctx.canAssign && board.people.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                // 🙌 is the undo, only on a card somebody is holding.
                if (owner != null) {
                    Box(
                        Modifier
                            .size(36.dp)
                            .background(WF.colors.card, CircleShape)
                            .border(1.dp, WF.colors.hair, CircleShape)
                            .clip(CircleShape)
                            .clickable(enabled = !ctx.frozen) { ctx.onGive(chore, null) }
                            .semantics { contentDescription = "Put ${chore.title} back up for grabs" },
                        contentAlignment = Alignment.Center,
                    ) { Text("🙌", fontSize = 17.sp) }
                }
                board.people.filter { it.id != owner }.forEach { person ->
                    AvatarFromHex(
                        colorHex = person.colorHex,
                        emoji = person.avatarEmoji ?: "🙂",
                        size = 36.dp,
                        modifier = Modifier
                            .clip(CircleShape)
                            .clickable(enabled = !ctx.frozen) { ctx.onGive(chore, person.id) }
                            .semantics { contentDescription = "Give ${chore.title} to ${person.name}" },
                    )
                }
            }
        }
    }
}

/**
 * The drag handle; a long press starts the drag. Hidden from accessibility on purpose:
 * a drag is not a gesture TalkBack can perform, and the faces do exactly the same thing.
 */
@Composable
private fun Grip(chore: PlanningTasksChore) {
    Box(
        Modifier
            .width(22.dp)
            .padding(vertical = 6.dp)
            .semantics { hideFromAccessibility() }
            .dragAndDropSource { _ ->
                DragAndDropTransferData(
                    clipData = ClipData(
                        ClipDescription(chore.title, arrayOf(PlanningTaskDrag.MIME_TYPE)),
                        ClipData.Item(chore.id),
                    ),
                    localState = PlanningTaskDrag(chore.id),
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Text("≡", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink3)
    }
}

@Composable
private fun TaskChip(text: String, unset: Boolean, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Text(
        text,
        modifier = Modifier
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .then(modifier)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
        color = if (unset) WF.colors.ink3 else WF.colors.ink2,
        maxLines = 1,
    )
}

@Composable
private fun AddButton(label: String, busy: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Text(
        "＋ $label",
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .clickable(enabled = !busy, onClick = onClick)
            .padding(vertical = 10.dp),
        style = TextStyle(
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        ),
        color = if (busy) WF.colors.ink3 else WF.colors.ink2,
    )
}

/** "3", not "3.0" — a whole number of stars unless the server really sent a fraction. */
private fun rewardText(amount: Double): String =
    if (amount == Math.rint(amount)) amount.toLong().toString() else String.format(java.util.Locale.US, "%.1f", amount)
