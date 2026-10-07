package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.Pill
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.wfField
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * The Goals tab — the phone port of the iOS `GoalsView`.
 *
 * The membership model from the web kiosk folded onto one screen: a horizontal list picker
 * (Family / each person) on top, an All/Shared/Each filter, the featured "spotlight" hero,
 * then the Pinned band and everything else A–Z. Tapping a card opens the goal; tapping Log
 * opens the log sheet.
 *
 * Online-only — goals are not a synced table, so this refetches rather than watching a
 * local mirror.
 *
 * **Scope:** phone layout only; the kiosk grid is a later phase.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalsScreen(
    model: GoalsModel,
    /** The signed-in person — the source of the `goal.manage` gate on this screen. */
    me: Person?,
    /** Household members, for the new-group sheet. */
    members: List<Person>,
    onOpenGoal: (GoalsApi.Goal) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val canManage = GoalsAccess.canManage(me)

    var logging by remember { mutableStateOf<GoalsApi.Goal?>(null) }
    var creating by remember { mutableStateOf(false) }
    var creatingList by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (state.lists.isEmpty()) model.loadLists()
    }

    // Re-fetch when something ELSE changed goals — the detail screen owns a separate
    // model, so logging progress or deleting a goal there leaves this list stale. iOS
    // reloads on nav pop; watching the bus is the Android equivalent, and `isStale()`
    // keeps this model's own writes from triggering a second, redundant fetch.
    val busState = remember(model) {
        model.refreshBus?.state ?: MutableStateFlow(emptyMap<RefreshDomain, Int>())
    }
    val revisions by busState.collectAsStateWithLifecycle()
    LaunchedEffect(revisions[RefreshDomain.Goals]) {
        if (model.isStale()) model.loadGoals()
    }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = WF.spacing.xxl, vertical = WF.spacing.lg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Goals", style = WF.type.hero, color = WF.colors.ink, modifier = Modifier.weight(1f))
            if (canManage) {
                Box(
                    Modifier
                        .size(36.dp)
                        .background(WF.colors.primary, RoundedCornerShape(WF.radius.pill))
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .clickable { creating = true },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = "New goal",
                        // White on a saturated coral fill is the correct exception.
                        tint = Color.White,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WF.spacing.xxl)
                // Screens scroll UNDER the tab bar.
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.xxl),
        ) {
            if (state.error) {
                DismissibleErrorBanner(
                    message = "Couldn't reach the server. Pull to refresh to try again.",
                    onDismiss = model::dismissError,
                )
            }

            ListPicker(
                lists = state.lists,
                selectedId = state.selectedList?.id,
                canManage = canManage,
                onSelect = { scope.launch { model.select(it) } },
                onNewGroup = { creatingList = true },
            )

            state.selectedList?.let { ListHead(it) }

            if (!state.isIndividual && state.selectedList != null) {
                FilterSegments(state.filter, model::setFilter)
            }

            state.spotlight?.let { hero ->
                SectionLabel("Spotlight")
                GoalHero(
                    goal = hero,
                    onOpen = { onOpenGoal(hero) },
                    onLog = { logging = hero },
                )
            }

            if (state.pinned.isNotEmpty()) {
                SectionLabel("Pinned")
                state.pinned.forEach { g ->
                    GoalCard(
                        goal = g,
                        pinned = true,
                        canManage = canManage,
                        onOpen = { onOpenGoal(g) },
                        onTogglePin = { scope.launch { model.togglePin(g) } },
                    )
                }
            }

            if (state.more.isNotEmpty()) {
                SectionLabel("More ${state.selectedList?.name.orEmpty()} goals · A–Z")
                state.more.forEach { g ->
                    GoalCard(
                        goal = g,
                        pinned = false,
                        canManage = canManage,
                        onOpen = { onOpenGoal(g) },
                        onTogglePin = { scope.launch { model.togglePin(g) } },
                    )
                }
            }

            if (state.loading && state.isEmpty) {
                WaffledLoading()
            } else if (state.isEmpty) {
                WaffledEmptyState(
                    emoji = if (state.error) "😕" else "🎯",
                    title = if (state.error) "Couldn't load goals" else "No goals here yet",
                    message = if (state.error) {
                        "Pull to refresh to try again."
                    } else if (canManage) {
                        "Add one with the ＋ button."
                    } else {
                        "A parent can add one."
                    },
                )
            }
        }
    }

    logging?.let { goal ->
        ModalBottomSheet(
            onDismissRequest = { logging = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            // This goal's own most-used notes, scoped to the logger so each member's box
            // learns their own history. Best-effort: a failure leaves the defaults.
            var noteSuggestions by remember(goal.id) { mutableStateOf(emptyList<String>()) }
            LaunchedEffect(goal.id, me?.id) {
                noteSuggestions = runCatching { model.api.noteSuggestions(goal.id, me?.id) }
                    .getOrDefault(emptyList())
            }
            // The card's goal may predate today's log; refetch who has ticked the habit off.
            var freshLoggedTodayBy by remember(goal.id) { mutableStateOf<List<String>?>(null) }
            LaunchedEffect(goal.id) {
                if (goal.goalType == "habit") {
                    freshLoggedTodayBy = runCatching { model.api.goalDetail(goal.id).loggedTodayBy }.getOrNull()
                }
            }
            GoalLogSheet(
                goal = goal,
                noteSuggestions = noteSuggestions,
                freshLoggedTodayBy = freshLoggedTodayBy,
                onDismiss = { logging = null },
                onSave = { amount, hours, minutes, ids, note, loggedOn ->
                    scope.launch {
                        model.log(goal.id, amount, ids, note, loggedOn, hours, minutes)
                    }
                },
            )
        }
    }

    if (creating) {
        ModalBottomSheet(
            onDismissRequest = { creating = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            GoalCreateSheet(
                lists = state.lists,
                initial = GoalDraft.new(defaultListId = state.selectedList?.id),
                onDismiss = { creating = false },
                onCreateList = { creatingList = true },
                onSubmit = { body, listId -> scope.launch { model.create(body, listId) } },
            )
        }
    }

    if (creatingList) {
        ModalBottomSheet(
            onDismissRequest = { creatingList = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            GoalListCreateSheet(
                api = model.api,
                members = members,
                onDismiss = { creatingList = false },
                onCreated = { id -> scope.launch { model.selectNewList(id) } },
            )
        }
    }
}

@Composable
private fun ListPicker(
    lists: List<GoalsApi.GoalList>,
    selectedId: String?,
    canManage: Boolean,
    onSelect: (String) -> Unit,
    onNewGroup: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
    ) {
        lists.forEach { list ->
            val on = list.id == selectedId
            val shape = RoundedCornerShape(WF.radius.pill)
            Row(
                Modifier
                    .background(if (on) WF.colors.card else WF.colors.card2, shape)
                    .border(
                        width = if (on) 1.5.dp else 1.dp,
                        color = if (on) WF.colors.ink.copy(alpha = 0.22f) else WF.colors.hair,
                        shape = shape,
                    )
                    .clip(shape)
                    .clickable { onSelect(list.id) }
                    .padding(start = WF.spacing.sm, end = WF.spacing.md, top = 7.dp, bottom = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AvatarStack(list.members, size = 22.dp)
                Text(
                    text = list.name,
                    style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
                    color = if (on) WF.colors.ink else WF.colors.ink2,
                    maxLines = 1,
                )
                Pill(text = list.goalCount.toString())
            }
        }
        if (canManage) {
            GoalChip(text = "＋ New group", selected = false, onClick = onNewGroup)
        }
    }
}

@Composable
private fun ListHead(list: GoalsApi.GoalList) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarStack(list.members, size = 30.dp)
        Column {
            Text(list.name, style = WF.type.title, color = WF.colors.ink)
            Text(
                text = "${list.goalCount} goals · ${listSubtitle(list)}",
                style = WF.type.caption,
                color = WF.colors.ink3,
            )
        }
    }
}

/** "Personal" / "Kevin & Kelly" / "Everyone · 4 people". */
internal fun listSubtitle(list: GoalsApi.GoalList): String = when (list.members.size) {
    0 -> "No members yet"
    1 -> "Personal"
    2 -> list.members.joinToString(" & ") { goalFirstName(it.name) }
    else -> "Everyone · ${list.members.size} people"
}

@Composable
private fun FilterSegments(selected: GoalsModel.Filter, onPick: (GoalsModel.Filter) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm)) {
        GoalsModel.Filter.entries.forEach { filter ->
            GoalChip(
                text = filter.name,
                selected = filter == selected,
                onClick = { onPick(filter) },
            )
        }
    }
}

/** The spotlight hero: a saturated card carrying the ring, the contributions and Log. */
@Composable
private fun GoalHero(goal: GoalsApi.Goal, onOpen: () -> Unit, onLog: () -> Unit) {
    val eachTracks = goal.trackingMode == "each_tracks"
    // Green for a shared pool, amber for "each tracks their own" — the same two hues iOS
    // uses, taken from the palette rather than fresh hexes.
    val base = if (eachTracks) WF.colors.gold else WF.colors.success
    // Each-tracks keeps the POOLED lifetime pair: the server's period count has no
    // per-person filter, so a per-person cadence beside it could read "6/5".
    val pooledTarget = GoalDisplay.pooledTarget(goal)
    val fraction = if (eachTracks) {
        pooledTarget?.takeIf { it > 0 }?.let { minOf(1.0, goal.totalProgress / it).toFloat() } ?: 0f
    } else {
        GoalDisplay.fraction(goal).toFloat()
    }
    val ringValue = if (eachTracks) goal.totalProgress else GoalDisplay.progress(goal)
    val ringCaption = if (eachTracks) {
        pooledTarget?.let { "of ${ringFmt(it)}${goal.unit?.let { u -> " $u" }.orEmpty()}" }
    } else {
        GoalDisplay.target(goal)?.let { GoalDisplay.targetCaption(goal, goal.unit, ::ringFmt) }
    }
    val biggest = maxOf(1.0, goal.participants.maxOfOrNull { it.progress } ?: 1.0)
    val shape = RoundedCornerShape(WF.radius.lg)

    Column(
        Modifier
            .fillMaxWidth()
            .background(goalHeroBrush(base), shape)
            .clip(shape)
            .clickable(onClick = onOpen)
            .padding(WF.spacing.xxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.xl),
            verticalAlignment = Alignment.Top,
        ) {
            GoalRing(
                value = fraction,
                size = 96.dp,
                lineWidth = 9.dp,
                stroke = Color.White,
                track = Color.White.copy(alpha = 0.25f),
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = ringFmt(ringValue),
                        style = TextStyle(fontSize = 23.sp, fontWeight = FontWeight.Black),
                        color = Color.White,
                        maxLines = 1,
                    )
                    if (ringCaption != null) {
                        Text(
                            text = ringCaption,
                            style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.Bold),
                            color = Color.White.copy(alpha = 0.85f),
                            maxLines = 1,
                        )
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.xs)) {
                GoalHeroPill(
                    if (eachTracks) "🌟 Spotlight · each tracks their own" else "🌟 Spotlight · shared total",
                )
                Text(goal.title, style = WF.type.hero, color = Color.White, maxLines = 2)
                Text(
                    text = if (eachTracks) {
                        "Everyone tracks their own"
                    } else {
                        "Everyone contributes to one pool"
                    },
                    style = WF.type.bodySmall,
                    color = Color.White.copy(alpha = 0.85f),
                )
            }
        }

        goal.participants.forEach { p ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "${p.avatarEmoji ?: "🙂"} ${goalFirstName(p.name)}",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                    color = Color.White,
                    maxLines = 1,
                    modifier = Modifier.width(84.dp),
                )
                GoalProgressBar(
                    value = (p.progress / maxOf(1.0, p.target ?: biggest)).toFloat(),
                    tint = Color.White,
                    track = Color.White.copy(alpha = 0.25f),
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "${goalFmt(p.progress)}${goal.unit?.let { " $it" }.orEmpty()}",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                    color = Color.White,
                    maxLines = 1,
                )
            }
        }

        val shapeSm = RoundedCornerShape(WF.radius.sm)
        Row(
            Modifier
                .fillMaxWidth()
                .background(Color.White, shapeSm)
                .clip(shapeSm)
                .clickable(onClick = onLog)
                .padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.Add,
                contentDescription = null,
                tint = base.deepened(),
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(WF.spacing.xs))
            Text(
                text = "Log ${goal.unit ?: "progress"}",
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                color = base.deepened(),
            )
        }
    }
}

/** A goal row in the Pinned band or the A–Z list. */
@Composable
private fun GoalCard(
    goal: GoalsApi.Goal,
    pinned: Boolean,
    canManage: Boolean,
    onOpen: () -> Unit,
    onTogglePin: () -> Unit,
) {
    val tint = goalCategoryColor(goal.category)
    val fraction = GoalDisplay.fraction(goal).toFloat()
    val shape = RoundedCornerShape(WF.radius.md)

    Column(
        Modifier
            .fillMaxWidth()
            .wfField()
            .then(
                if (pinned) Modifier.border(1.5.dp, WF.colors.warn.copy(alpha = 0.5f), shape) else Modifier,
            )
            .clickable(onClick = onOpen)
            .padding(WF.spacing.xl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.lg),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            app.waffled.core.design.WaffledEmojiTile(
                emoji = goal.emoji ?: goalCategoryEmoji(goal.category),
                size = 20.dp,
                background = tint.copy(alpha = 0.14f),
            )
            Column(Modifier.weight(1f)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = goal.title,
                        style = WF.type.label,
                        color = WF.colors.ink,
                        maxLines = 1,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (pinned) WaffledStatusBadge(text = "📌 PINNED", color = WF.colors.warn, size = 9.sp)
                }
                Text(
                    text = goalDescriptor(goal),
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                    maxLines = 1,
                )
            }
            Text(
                text = "${goalFmt(GoalDisplay.progress(goal))}/${goalFmt(GoalDisplay.target(goal))}",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black),
                color = WF.colors.ink,
            )
            if (canManage) {
                Icon(
                    imageVector = Icons.Filled.PushPin,
                    contentDescription = if (goal.isFeatured) "Unpin ${goal.title}" else "Pin ${goal.title}",
                    tint = if (goal.isFeatured) WF.colors.primary else WF.colors.ink3.copy(alpha = 0.55f),
                    modifier = Modifier
                        .size(26.dp)
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .clickable(onClick = onTogglePin)
                        .padding(4.dp),
                )
            }
        }

        GoalProgressBar(value = fraction, tint = tint, track = WF.colors.hair)

        if (goal.streakDays > 0) {
            Text(
                text = "🔥 ${goal.streakDays}-day streak",
                style = WF.type.micro,
                color = WF.colors.ink2,
            )
        }
    }
}
