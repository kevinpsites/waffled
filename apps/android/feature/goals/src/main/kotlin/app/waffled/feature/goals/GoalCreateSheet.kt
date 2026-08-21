package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import java.time.Instant
import java.time.ZoneOffset

/**
 * The new/edit goal form — the phone port of the iOS `GoalCreateSheet`.
 *
 * Every rule this renders lives in [GoalDraft] (the counting model, validation, the
 * milestone ladder, the request body). This file is a thin renderer over that state, which
 * is what keeps the interesting half testable without a device.
 *
 * **Deliberately not ported:** the Apple Health "auto-fill" section and its metric picker.
 * Health Connect is out of scope, so [HealthAutoFill.isAvailable] is false and the whole
 * section is gated off exactly as iOS gates on `isHealthDataAvailable()`. A goal already
 * linked on iOS keeps its link — the health fields are never written (see `GoalDraft.body`).
 *
 * **Scope:** phone layout only — the iPad two-pane form with its live-preview stage is a
 * later phase.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
fun GoalCreateSheet(
    lists: List<GoalsApi.GoalList>,
    initial: GoalDraft,
    onDismiss: () -> Unit,
    onCreateList: () -> Unit = {},
    /** (body, goalListId) — the body comes straight from [GoalDraft.body]. */
    onSubmit: (kotlinx.serialization.json.JsonObject, String?) -> Unit,
) {
    var draft by remember { mutableStateOf(initial) }
    var pickingDeadline by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp, vertical = WF.spacing.xxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xxl),
    ) {
        Text(
            text = if (draft.isEditing) "Edit goal" else "New goal",
            style = WF.type.title,
            color = WF.colors.ink,
        )

        FormSection("Name your goal") {
            WaffledTextField(
                value = draft.title,
                onValueChange = { draft = draft.copy(title = it) },
                placeholder = "1,000 Hours Outside",
            )
        }

        FormSection("Who's it for?", hint = "Pick a goal list — the people in it share this goal.") {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
            ) {
                lists.forEach { list ->
                    GoalChip(
                        text = list.name,
                        selected = draft.goalListId == list.id,
                        onClick = { draft = draft.copy(goalListId = list.id) },
                        leading = { AvatarStack(list.members, size = 20.dp) },
                    )
                }
                GoalChip(text = "＋ New group", selected = false, onClick = onCreateList)
            }
        }

        FormSection("How do you measure it?", hint = "This shapes how progress is logged and shown.") {
            Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
                MEASURES.forEach { measure ->
                    MeasureCard(
                        measure = measure,
                        selected = draft.goalType == measure.key,
                        onClick = { draft = draft.selectMeasure(measure.key) },
                    )
                }

                when {
                    draft.isChecklist -> StepsEditor(
                        steps = draft.steps,
                        onChange = { draft = draft.copy(steps = it) },
                    )

                    draft.isHabit -> Row(
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        WaffledTextField(
                            value = draft.habitPer,
                            onValueChange = { draft = draft.copy(habitPer = it).reDeriveIfUntouched() },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.width(80.dp),
                        )
                        Text("× a", style = WF.type.label, color = WF.colors.ink2)
                        listOf("day", "week", "month").forEach { period ->
                            GoalChip(
                                text = period,
                                selected = draft.habitPeriod == period,
                                onClick = { draft = draft.copy(habitPeriod = period) },
                            )
                        }
                    }

                    else -> Row(
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        WaffledTextField(
                            value = draft.target,
                            onValueChange = { draft = draft.copy(target = it).reDeriveIfUntouched() },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.width(110.dp),
                        )
                        WaffledTextField(
                            value = draft.unit,
                            onValueChange = { draft = draft.copy(unit = it) },
                            placeholder = "hours",
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                ToggleRow(
                    emoji = "📅",
                    title = when {
                        draft.isChecklist -> "Finish by a date"
                        draft.isHabit -> "Keep it up until"
                        else -> "Set a deadline"
                    },
                    subtitle = if (draft.hasDeadline) draft.deadline.toString() else "Optional",
                    checked = draft.hasDeadline,
                    onChange = { draft = draft.copy(hasDeadline = it) },
                )
                if (draft.hasDeadline) {
                    WaffledSecondaryCTA(
                        label = "Change date · ${draft.deadline}",
                        onClick = { pickingDeadline = true },
                    )
                }

                // Shared-vs-each only matters once a measure with a per-person dimension is
                // chosen, and never for a checklist.
                if (!draft.isChecklist && (draft.selectedListIn(lists)?.members?.size ?: 0) > 1) {
                    SegmentedPair(
                        leftLabel = if (draft.isHabit) "One shared streak" else "One shared total",
                        rightLabel = if (draft.isHabit) "Each keeps their own" else "Each tracks their own",
                        leftSelected = draft.shared,
                        onLeft = { draft = draft.setSharedMode() },
                        onRight = { draft = draft.setEachMode() },
                    )
                    CountReveal(draft = draft, lists = lists, onChoose = { draft = draft.setCountChoice(it) })
                }
            }
        }

        FormSection("Category", hint = "Where this counts toward a balanced life.") {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
            ) {
                GoalDraft.CATEGORIES.forEach { key ->
                    GoalChip(
                        text = "${goalCategoryEmoji(key)} ${GoalDraft.CATEGORY_LABELS[key] ?: key}",
                        selected = draft.category == key,
                        onClick = { draft = draft.copy(category = key) },
                        tint = goalCategoryColor(key),
                    )
                }
            }
        }

        FormSection("Extras", hint = "All optional. Turn on only what this goal needs.") {
            Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.lg)) {
                TierPicker(tier = draft.tier, onPick = { draft = draft.withTier(it) })

                ToggleRow(
                    emoji = "🏆",
                    title = "Milestones & rewards",
                    subtitle = "Bonus stars at thresholds you set",
                    checked = draft.hasRewards,
                    onChange = { draft = draft.copy(hasRewards = it).reDeriveIfUntouched() },
                )
                if (draft.hasRewards) {
                    MilestoneEditor(
                        draft = draft,
                        onChange = { draft = draft.copy(milestones = it) },
                    )
                }

                // A checklist's progress comes from ticking steps, never from an event.
                if (!draft.isChecklist) {
                    ToggleRow(
                        emoji = "📅",
                        title = "Auto-count from calendar",
                        subtitle = "Matching events add progress automatically",
                        checked = draft.autoFromCalendar,
                        onChange = { draft = draft.copy(autoFromCalendar = it) },
                    )
                }

                // The Apple Health auto-fill row is gated off for this port; see the KDoc.
                if (HealthAutoFill.isAvailable) {
                    Text(
                        text = "Auto-fill from health data",
                        style = WF.type.label,
                        color = WF.colors.ink2,
                    )
                }

                Text(
                    text = "Rewards are off by default — goals stay about growth, not points. " +
                        "Turn them on per goal when a little extra motivation helps.",
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                )
            }
        }

        WaffledPrimaryCTA(
            label = if (draft.isEditing) "Save changes" else "Create goal",
            isDisabled = !draft.canSave,
            onClick = {
                // Participants follow the chosen list. When that yields nothing — a goal
                // in no list, or a list this client hasn't fetched — `body()` falls back
                // to the goal's existing participants rather than un-assigning everyone.
                val memberIds = lists.firstOrNull { it.id == draft.goalListId }
                    ?.members?.map { it.personId }.orEmpty()
                onSubmit(draft.body(memberIds), draft.goalListId)
                onDismiss()
            },
        )
        WaffledSecondaryCTA(label = "Cancel", onClick = onDismiss)
        Spacer(Modifier.height(WF.spacing.sm))
    }

    if (pickingDeadline) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = draft.deadline.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { pickingDeadline = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { millis ->
                        // The picker works in UTC; read the day back in UTC too, or a
                        // negative-offset device lands on the previous date.
                        draft = draft.copy(
                            deadline = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate(),
                        )
                    }
                    pickingDeadline = false
                }) { Text("Done", color = WF.colors.primary) }
            },
            dismissButton = {
                TextButton(onClick = { pickingDeadline = false }) {
                    Text("Cancel", color = WF.colors.ink2)
                }
            },
        ) {
            DatePicker(state = state)
        }
    }
}

private fun GoalDraft.selectedListIn(lists: List<GoalsApi.GoalList>): GoalsApi.GoalList? =
    lists.firstOrNull { it.id == goalListId }

private data class Measure(val key: String, val emoji: String, val title: String, val description: String)

private val MEASURES = listOf(
    Measure("total", "⏱️", "Total amount", "Adds up — can split (hours, miles)"),
    Measure("count", "🔢", "Count", "Whole things (books, parks)"),
    Measure("habit", "🔁", "Habit", "Once a day, on a cadence"),
    Measure("checklist", "🪜", "Checklist", "Named steps you tick off"),
)

@Composable
private fun FormSection(
    title: String,
    hint: String? = null,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.lg)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair2))
        Text(text = title, style = WF.type.cardTitle, color = WF.colors.ink)
        if (hint != null) {
            Text(text = hint, style = WF.type.caption, color = WF.colors.ink3)
        }
        content()
    }
}

@Composable
private fun MeasureCard(measure: Measure, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected) WF.colors.primary.copy(alpha = 0.08f) else WF.colors.card, shape)
            .border(if (selected) 1.5.dp else 1.dp, if (selected) WF.colors.primary else WF.colors.hair, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(WF.spacing.lg),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = measure.emoji)
        Column(Modifier.weight(1f)) {
            Text(measure.title, style = WF.type.label, color = WF.colors.ink)
            Text(measure.description, style = WF.type.caption, color = WF.colors.ink3)
        }
        if (selected) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = "Selected",
                tint = WF.colors.primary,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun ToggleRow(
    emoji: String,
    title: String,
    subtitle: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = emoji, size = 17.dp, frame = 34.dp, cornerRadius = 10.dp)
        Column(Modifier.weight(1f)) {
            Text(title, style = WF.type.label, color = WF.colors.ink)
            Text(subtitle, style = WF.type.caption, color = WF.colors.ink3)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = FamilyColor.Person3.solid,
                uncheckedThumbColor = WF.colors.card,
                uncheckedTrackColor = WF.colors.panel,
                uncheckedBorderColor = WF.colors.hair,
            ),
        )
    }
}

@Composable
private fun SegmentedPair(
    leftLabel: String,
    rightLabel: String,
    leftSelected: Boolean,
    onLeft: () -> Unit,
    onRight: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        SegmentButton(leftLabel, leftSelected, Modifier.weight(1f), onLeft)
        SegmentButton(rightLabel, !leftSelected, Modifier.weight(1f), onRight)
    }
}

@Composable
private fun SegmentButton(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier
            .background(if (selected) WF.colors.card else Color.Transparent, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = TextStyle(
                fontSize = 12.5.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold,
            ),
            color = if (selected) WF.colors.ink else WF.colors.ink2,
            maxLines = 1,
        )
    }
}

/** The measure-aware "how does a group entry add up?" choice. */
@Composable
private fun CountReveal(
    draft: GoalDraft,
    lists: List<GoalsApi.GoalList>,
    onChoose: (String) -> Unit,
) {
    if (!draft.shared) return
    if (draft.goalType != "total" && draft.goalType != "count") return
    val people = draft.selectedListIn(lists)?.members?.size ?: 0

    val options = if (draft.goalType == "total") {
        listOf("full" to "👥 Everyone's counts fully", "split" to "➗ Split across who took part")
    } else {
        listOf("each" to "👥 Count it for each person", "once" to "✅ Count the activity once")
    }

    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
        Text(
            text = "When a shared activity includes more than one person…",
            style = WF.type.label,
            color = WF.colors.ink,
        )
        options.forEach { (key, label) ->
            val selected = draft.countChoice == key
            val shape = RoundedCornerShape(WF.radius.md)
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(WF.colors.card, shape)
                    .border(if (selected) 1.5.dp else 1.dp, if (selected) WF.colors.primary else WF.colors.hair, shape)
                    .clip(shape)
                    .clickable { onChoose(key) }
                    .padding(WF.spacing.xl),
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(label, style = WF.type.label, color = WF.colors.ink)
                    Text(
                        text = countExample(draft, key, people),
                        style = WF.type.caption,
                        color = WF.colors.ink2,
                    )
                }
                if (selected) {
                    Icon(
                        imageVector = Icons.Filled.CheckCircle,
                        contentDescription = "Selected",
                        tint = WF.colors.primary,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

/** The worked example under each counting choice, in the goal's own unit. */
internal fun countExample(draft: GoalDraft, choice: String, people: Int): String {
    val unit = draft.unit.trim().ifEmpty { if (draft.goalType == "total") "hr" else "visit" }
    val singular = if (unit.length > 1 && unit.endsWith("s")) unit.dropLast(1) else unit
    val n = maxOf(2, people)
    return when (choice) {
        "full" -> "2 people, 1 $singular each → +2 $unit"
        "split" -> "1 $singular together, 2 people → +1 $singular, ½ each"
        "each" -> "$n at once → +$n (one each)"
        else -> "$n at once → +1, they're just who came"
    }
}

@Composable
private fun TierPicker(tier: GoalDraft.Tier, onPick: (GoalDraft.Tier) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
        SectionLabel("Spotlight & pinned")
        Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm)) {
            GoalChip("🌟 Spotlight", tier == GoalDraft.Tier.Spotlight, { onPick(GoalDraft.Tier.Spotlight) })
            GoalChip("📌 Pinned", tier == GoalDraft.Tier.Pinned, { onPick(GoalDraft.Tier.Pinned) })
            GoalChip("Normal", tier == GoalDraft.Tier.Normal, { onPick(GoalDraft.Tier.Normal) })
        }
        Text(
            text = when (tier) {
                GoalDraft.Tier.Spotlight ->
                    "The one big hero card for this list — only one goal can be the spotlight."

                GoalDraft.Tier.Pinned -> "Pinned to the top of the goals list, above the rest."
                GoalDraft.Tier.Normal -> "Lives in the goals list with everything else."
            },
            style = WF.type.caption,
            color = WF.colors.ink3,
        )
    }
}

@Composable
private fun StepsEditor(steps: List<GoalDraft.StepDraft>, onChange: (List<GoalDraft.StepDraft>) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.sm)) {
        steps.forEachIndexed { index, step ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(width = 26.dp, height = 38.dp)
                        .background(WF.colors.panel, RoundedCornerShape(WF.radius.sm)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("${index + 1}", style = WF.type.micro, color = WF.colors.ink3)
                }
                WaffledTextField(
                    value = step.label,
                    onValueChange = { label ->
                        onChange(steps.mapIndexed { i, s -> if (i == index) s.copy(label = label) else s })
                    },
                    placeholder = "Step ${index + 1}",
                    modifier = Modifier.weight(1f),
                )
                if (steps.size > 1) {
                    Icon(
                        imageVector = Icons.Filled.RemoveCircle,
                        contentDescription = "Remove step ${index + 1}",
                        tint = WF.colors.ink3,
                        modifier = Modifier
                            .size(20.dp)
                            .clickable { onChange(steps.filterIndexed { i, _ -> i != index }) },
                    )
                }
            }
        }
        AddRowButton("Add step") { onChange(steps + GoalDraft.StepDraft()) }
    }
}

@Composable
private fun MilestoneEditor(draft: GoalDraft, onChange: (List<GoalDraft.MilestoneDraft>) -> Unit) {
    val hint = when (draft.goalType) {
        "habit" -> "Number = 🔥 streak days (e.g. 30 → reward at a 30-day streak)"
        "checklist" -> "Number = % complete — enter 80 for 80% (100 = all steps done)"
        else -> {
            val unit = draft.unit.trim()
            val noun = unit.ifEmpty { "amount" }
            val example = if (unit.isEmpty()) "500" else "500 $unit"
            "Number = $noun reached (e.g. 500 → reward at $example)"
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.sm)) {
        Text(hint, style = WF.type.caption, color = WF.colors.ink3)
        draft.milestones.forEachIndexed { index, m ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WaffledTextField(
                    value = m.emoji,
                    onValueChange = { emoji ->
                        onChange(draft.milestones.mapIndexed { i, x -> if (i == index) x.copy(emoji = emoji) else x })
                    },
                    modifier = Modifier.width(58.dp),
                )
                WaffledTextField(
                    value = m.threshold,
                    onValueChange = { t ->
                        onChange(draft.milestones.mapIndexed { i, x -> if (i == index) x.copy(threshold = t) else x })
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.width(78.dp),
                )
                WaffledTextField(
                    value = m.reward,
                    onValueChange = { r ->
                        onChange(draft.milestones.mapIndexed { i, x -> if (i == index) x.copy(reward = r) else x })
                    },
                    placeholder = "reward",
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = Icons.Filled.RemoveCircle,
                    contentDescription = "Remove milestone",
                    tint = WF.colors.ink3,
                    modifier = Modifier
                        .size(20.dp)
                        .clickable { onChange(draft.milestones.filterIndexed { i, _ -> i != index }) },
                )
            }
        }
        AddRowButton("Add milestone") {
            onChange(draft.milestones + GoalDraft.MilestoneDraft(threshold = "0"))
        }
    }
}

@Composable
private fun AddRowButton(label: String, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(WF.radius.pill))
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp, horizontal = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.Add,
            contentDescription = null,
            tint = WF.colors.ai,
            modifier = Modifier.size(14.dp),
        )
        Text(label, style = WF.type.bodySmall, color = WF.colors.ai)
    }
}
