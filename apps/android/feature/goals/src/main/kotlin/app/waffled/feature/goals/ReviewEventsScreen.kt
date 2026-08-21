package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Remove
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
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import java.time.ZoneId
import kotlinx.coroutines.launch

/**
 * The Today → "Review events" screen, and the whole client half of the goal↔calendar
 * bridge. The port of the iOS `ReviewEventsView`.
 *
 * Two queues, and the COLOUR encodes confidence:
 *  - **Confirmed** (`WF.colors.ai`, purple): the household already agreed this event ties
 *    to a goal, and it has now ended. Confirming logs progress with an editable amount and
 *    an editable "who"; skipping clears it without logging.
 *  - **Suggested** (`WF.colors.gold`, amber): an untagged event the matcher thinks MIGHT
 *    count. Link it, or dismiss it for good.
 *
 * Every write is idempotent on (event, occurrence, goal) server-side; the busy guard in
 * [ReviewEventsModel] is what stops a double-tap needing that dedupe in the first place.
 *
 * **Scope:** phone layout only.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReviewEventsScreen(
    model: ReviewEventsModel,
    /** Household members, for the "who gets credit" picker. */
    members: List<Person>,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault(),
) {
    val state by model.state.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var editingPeople by remember { mutableStateOf<GoalsApi.GoalRecapItem?>(null) }

    LaunchedEffect(Unit) { model.load() }

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
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
                tint = WF.colors.ink,
                modifier = Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .clickable(onClick = onBack)
                    .padding(4.dp),
            )
            Text("Review events", style = WF.type.sectionTitle, color = WF.colors.ink)
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WF.spacing.xxl)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.xxl),
        ) {
            Text(
                text = "Confirm linked events that have happened, and link any that look " +
                    "like they count.",
                style = WF.type.body,
                color = WF.colors.ink2,
            )

            if (state.error) {
                DismissibleErrorBanner(
                    message = "Couldn't reach the server.",
                    onDismiss = model::dismissError,
                )
            }

            if (state.isEmpty) {
                if (state.loading) {
                    WaffledLoading(top = 60.dp)
                } else {
                    WaffledEmptyState(
                        emoji = "🎉",
                        title = "You're all caught up",
                        message = "Nothing to review or link right now.",
                    )
                }
            }

            if (state.recap.isNotEmpty()) {
                QueueHeader(
                    tint = WF.colors.ai,
                    title = "Did these happen?",
                    subtitle = "Confirm each to log its progress — or mark it skipped.",
                    count = state.recap.size,
                )
                state.recap.forEach { item ->
                    RecapCard(
                        item = item,
                        draft = model.draft(item),
                        members = members,
                        busy = item.id in busy,
                        canConfirm = model.canConfirm(item),
                        zone = zone,
                        onAmount = { model.setAmount(item, it) },
                        onPickPeople = { editingPeople = item },
                        onSkip = { scope.launch { model.skip(item) } },
                        onConfirm = { scope.launch { model.confirm(item) } },
                    )
                }
            }

            if (state.suggestions.isNotEmpty()) {
                QueueHeader(
                    tint = WF.colors.gold,
                    title = "Might count toward a goal",
                    subtitle = "Link the ones that fit — or dismiss them.",
                    count = state.suggestions.size,
                )
                state.suggestions.forEach { item ->
                    SuggestionCard(
                        item = item,
                        busy = item.id in busy,
                        zone = zone,
                        onDismiss = { scope.launch { model.dismiss(item) } },
                        onLink = { scope.launch { model.link(item) } },
                    )
                }
            }
        }
    }

    editingPeople?.let { item ->
        ModalBottomSheet(
            onDismissRequest = { editingPeople = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            ReviewPeopleSheet(
                item = item,
                members = members,
                selected = model.draft(item).people,
                onDismiss = { editingPeople = null },
                onSave = { model.setPeople(item, it) },
            )
        }
    }
}

@Composable
private fun QueueHeader(tint: Color, title: String, subtitle: String, count: Int) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = "✨", size = 18.dp, frame = 34.dp, background = tint.copy(alpha = 0.14f))
        Column(Modifier.weight(1f)) {
            Text(title, style = WF.type.cardTitle, color = WF.colors.ink)
            Text(subtitle, style = WF.type.caption, color = WF.colors.ink3)
        }
        Box(
            Modifier
                .size(24.dp)
                .background(tint.copy(alpha = 0.14f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = count.toString(),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black),
                color = tint,
            )
        }
    }
}

@Composable
private fun RecapCard(
    item: GoalsApi.GoalRecapItem,
    draft: ReviewEventsModel.Draft,
    members: List<Person>,
    busy: Boolean,
    canConfirm: Boolean,
    zone: ZoneId,
    onAmount: (Double) -> Unit,
    onPickPeople: () -> Unit,
    onSkip: () -> Unit,
    onConfirm: () -> Unit,
) {
    QueueCard(borderTint = WF.colors.ai.copy(alpha = 0.22f)) {
        EventHead(
            emoji = item.goalEmoji ?: "🎯",
            title = item.title,
            when_ = eventWhen(item.startsAt, item.allDay, zone),
            chipEmoji = if (item.goalType == "checklist" && item.stepLabel != null) "✓" else item.goalEmoji,
            chipText = if (item.goalType == "checklist") item.stepLabel ?: item.goalTitle else item.goalTitle,
            chipDot = WF.colors.ai,
        )

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (item.isAmountBased) {
                val step = goalStepSize(item.unit)
                AmountStepper(
                    amount = draft.amount,
                    onChange = onAmount,
                    step = step,
                )
                Text(
                    text = goalUnitLabel(item.unit, draft.amount),
                    style = WF.type.label,
                    color = WF.colors.ink2,
                )
            }
            Spacer(Modifier.weight(1f))
            Row(
                Modifier
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable(onClick = onPickPeople)
                    .padding(horizontal = WF.spacing.xs, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("to", style = WF.type.bodySmall, color = WF.colors.ink3)
                val picked = draft.people.mapNotNull { id -> members.firstOrNull { it.id == id } }
                Row(horizontalArrangement = Arrangement.spacedBy((-6).dp)) {
                    picked.take(3).forEach { p ->
                        AvatarFromHex(colorHex = p.colorHex, emoji = p.displayEmoji, size = 22.dp)
                    }
                }
                Text(
                    text = peopleNames(picked) + creditSuffix(item, draft.people.size),
                    style = WF.type.label,
                    color = WF.colors.ink2,
                    maxLines = 1,
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
            Box(Modifier.weight(1f)) {
                WaffledSecondaryCTA(label = "Skip", isDisabled = busy, onClick = onSkip)
            }
            Box(Modifier.weight(1f)) {
                WaffledPrimaryCTA(
                    label = "Confirm",
                    isBusy = busy,
                    isDisabled = !canConfirm,
                    onClick = onConfirm,
                )
            }
        }
    }
}

@Composable
private fun SuggestionCard(
    item: GoalsApi.GoalSuggestionItem,
    busy: Boolean,
    zone: ZoneId,
    onDismiss: () -> Unit,
    onLink: () -> Unit,
) {
    QueueCard(borderTint = WF.colors.gold.copy(alpha = 0.40f)) {
        EventHead(
            emoji = item.goalEmoji ?: "🎯",
            title = item.title,
            when_ = eventWhen(item.startsAt, item.allDay, zone),
            chipEmoji = item.goalEmoji,
            chipText = item.goalTitle,
            chipDot = WF.colors.gold,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
            Box(Modifier.weight(1f)) {
                WaffledSecondaryCTA(label = "Dismiss", isDisabled = busy, onClick = onDismiss)
            }
            Box(Modifier.weight(1f)) {
                WaffledPrimaryCTA(label = "Link", isBusy = busy, onClick = onLink)
            }
        }
    }
}

@Composable
private fun QueueCard(borderTint: Color, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, borderTint, shape)
            .clip(shape)
            .padding(WF.spacing.xl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        content = content,
    )
}

@Composable
private fun EventHead(
    emoji: String,
    title: String,
    when_: String,
    chipEmoji: String?,
    chipText: String,
    chipDot: Color,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.Top,
    ) {
        WaffledEmojiTile(emoji = emoji, size = 21.dp, frame = 42.dp, background = WF.colors.card2)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = WF.type.cardTitle, color = WF.colors.ink)
            Text(when_, style = WF.type.caption, color = WF.colors.ink3)
            Row(
                Modifier
                    .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                    .padding(horizontal = 9.dp, vertical = 5.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(6.dp).background(chipDot, CircleShape))
                Text(
                    text = "${chipEmoji?.let { "$it " }.orEmpty()}$chipText",
                    style = WF.type.micro,
                    color = WF.colors.ink2,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun AmountStepper(amount: Double, step: Double, onChange: (Double) -> Unit) {
    Row(
        Modifier
            .background(WF.colors.card2, RoundedCornerShape(WF.radius.pill))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 5.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StepperButton(Icons.Filled.Remove, "Less", amount > 0) { onChange(amount - step) }
        Text(
            text = goalFmt(amount),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Black),
            color = WF.colors.ink,
            modifier = Modifier.width(38.dp),
        )
        StepperButton(Icons.Filled.Add, "More", true) { onChange(amount + step) }
    }
}

@Composable
private fun StepperButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(28.dp)
            .background(WF.colors.card, CircleShape)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = if (enabled) WF.colors.ink else WF.colors.ink3,
            modifier = Modifier.size(13.dp),
        )
    }
}

/** A compact people picker for one recap row — who among the goal's participants counts. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReviewPeopleSheet(
    item: GoalsApi.GoalRecapItem,
    members: List<Person>,
    selected: List<String>,
    onDismiss: () -> Unit,
    onSave: (List<String>) -> Unit,
) {
    var picked by remember { mutableStateOf(selected.toSet()) }
    // Only the goal's own participants are eligible; if the payload named none, everyone is.
    val eligible = remember(item, members) {
        val ids = item.goalParticipantIds.toSet()
        members.filter { it.id in ids }.ifEmpty { members }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(WF.spacing.xxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xxl),
    ) {
        Text("Who gets credit?", style = WF.type.title, color = WF.colors.ink)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
        ) {
            eligible.forEach { m ->
                GoalPersonChip(
                    name = m.name,
                    colorHex = m.colorHex,
                    emoji = m.displayEmoji,
                    selected = m.id in picked,
                    onClick = { picked = if (m.id in picked) picked - m.id else picked + m.id },
                )
            }
        }
        WaffledPrimaryCTA(
            label = "Done",
            isDisabled = picked.isEmpty(),
            onClick = {
                // Preserve the goal's own participant order rather than tap order.
                onSave(eligible.map { it.id }.filter { it in picked })
                onDismiss()
            },
        )
        WaffledSecondaryCTA(label = "Cancel", onClick = onDismiss)
    }
}

/** "Kevin", "Kevin & Kelly", "3 people" — or "anyone" when nobody is picked. */
internal fun peopleNames(members: List<Person>): String = when (members.size) {
    0 -> "anyone"
    1 -> goalFirstName(members[0].name)
    2 -> "${goalFirstName(members[0].name)} & ${goalFirstName(members[1].name)}"
    else -> "${members.size} people"
}

/** How a multi-person confirm will count: a shared pool splits, each_tracks credits each. */
internal fun creditSuffix(item: GoalsApi.GoalRecapItem, pickedCount: Int): String = when {
    pickedCount <= 1 -> ""
    item.trackingMode == "shared_total" -> " · split"
    else -> " · each"
}

/** "Fri, Jul 17 · 5:00 PM", in the household's zone rather than UTC. */
internal fun eventWhen(iso: String, allDay: Boolean, zone: ZoneId): String {
    val instant = WaffledDates.parseInstant(iso, zone) ?: return iso.take(10)
    val pattern = if (allDay) "EEE, MMM d" else "EEE, MMM d · h:mm a"
    return WaffledDates.format(instant, pattern, zone)
}
