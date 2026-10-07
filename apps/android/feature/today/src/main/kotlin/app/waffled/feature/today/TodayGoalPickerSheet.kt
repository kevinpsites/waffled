package app.waffled.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.wfField

/**
 * The grouped goal chooser for the Today goals card: "Follow the spotlight" plus every
 * goal, grouped by list (My goals → shared groups I'm in → everyone else's → unlisted).
 *
 * [selectedId] of "" means auto (follow the spotlight); otherwise the pinned goal's id.
 * The pin itself is per-device state the caller owns.
 *
 * The goals **hero card** this configures belongs to the goals feature, not to Today — this
 * sheet is public so that module can present it. It also intentionally uses the brand
 * accent rather than iOS's per-category goal palette (`GoalStyle`): that palette lives in
 * the goals feature and inventing a second one here would put two different colours on the
 * same goal.
 *
 * A host holding the goals feature's own types maps them in field by field: build each
 * [TodayApi.Goal] with `participantCount` (no participant JSON needed) and each
 * [TodayApi.GoalList] from the list's id, name and members.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayGoalPickerSheet(
    goals: List<TodayApi.Goal>,
    myPersonId: String?,
    selectedId: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
    /** Fetches the goal lists that drive the grouping; failures just flatten the list. */
    loadLists: suspend () -> List<TodayApi.GoalList> = { emptyList() },
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var lists by remember { mutableStateOf<List<TodayApi.GoalList>>(emptyList()) }
    var collapsed by remember { mutableStateOf(setOf<String>()) }

    LaunchedEffect(Unit) { lists = runCatching { loadLists() }.getOrDefault(emptyList()) }

    val groups = remember(goals, lists, myPersonId) {
        TodayGoalGrouping.group(goals, lists, myPersonId)
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = WF.colors.canvas,
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = WF.spacing.xxxl),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.md),
        ) {
            item(key = "title") {
                Text("Show on Today", style = WF.type.title, color = WF.colors.ink)
            }

            item(key = "auto") {
                PickerRow(
                    emoji = "✨",
                    title = "Follow the spotlight",
                    subtitle = "Auto-picks your My / Family spotlight goal",
                    selected = selectedId.isEmpty(),
                    progress = null,
                    onClick = { onSelect(""); onDismiss() },
                )
            }

            groups.forEach { group ->
                val isOpen = group.id !in collapsed
                item(key = "h-${group.id}") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                collapsed = if (isOpen) collapsed + group.id else collapsed - group.id
                            }
                            .padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        DisclosureChevron(isOpen = isOpen)
                        Row(horizontalArrangement = Arrangement.spacedBy((-6).dp)) {
                            group.members.take(4).forEach { member ->
                                Box(
                                    modifier = Modifier
                                        .size(22.dp)
                                        .background(WF.colors.panel, CircleShape),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = member.avatarEmoji ?: "🙂",
                                        style = TextStyle(fontSize = 12.sp),
                                    )
                                }
                            }
                        }
                        Text(
                            text = group.title,
                            modifier = Modifier.weight(1f),
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black),
                            color = WF.colors.ink,
                        )
                        Text(
                            text = "${group.goals.size}",
                            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                            color = WF.colors.ink3,
                        )
                    }
                }

                if (isOpen) {
                    group.goals.forEach { goal ->
                        item(key = "g-${goal.id}") {
                            PickerRow(
                                emoji = goal.emoji ?: "🎯",
                                title = goal.title,
                                subtitle = goalDescriptor(goal),
                                selected = selectedId == goal.id,
                                progress = goal.fraction,
                                onClick = { onSelect(goal.id); onDismiss() },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** "4 of 10 books" / "12-day streak" / the goal's category — whatever we actually know. */
internal fun goalDescriptor(goal: TodayApi.Goal): String {
    val target = goal.displayTarget
    if (target != null && target > 0) {
        val unit = when {
            goal.goalType == "checklist" -> " steps"
            goal.periodLabel != null -> " ${goal.periodLabel}"
            else -> goal.unit?.takeIf { it.isNotBlank() }?.let { " $it" }.orEmpty()
        }
        return "${trimNumber(goal.displayProgress)} of ${trimNumber(target)}$unit"
    }
    if (goal.streakDays > 0) return "${goal.streakDays}-day streak"
    return goal.category?.replaceFirstChar(Char::uppercase) ?: "No target set"
}

/** 4.0 → "4", 4.5 → "4.5" — a whole number should not read as a decimal. */
private fun trimNumber(value: Double): String =
    if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()

@Composable
private fun PickerRow(
    emoji: String,
    title: String,
    subtitle: String,
    selected: Boolean,
    progress: Double?,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .wfField()
            .clickable(onClick = onClick)
            .padding(13.dp),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = emoji, size = 20.dp, frame = 42.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = title,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            progress?.let { ProgressBar(value = it, height = 6.dp) }
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
