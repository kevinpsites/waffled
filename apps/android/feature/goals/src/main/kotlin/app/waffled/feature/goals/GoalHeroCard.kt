package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledTheme

/**
 * The Today "Family Goal" hero card — the phone port of the iOS `GoalHeroCard`.
 *
 * A green card carrying the featured goal's ring, each participant's contribution and a
 * prominent Log button, so a goal can be logged without leaving Today.
 *
 * Deliberately STATELESS: it owns no sheets and no writes. The iOS version presented its
 * own log sheet and goal picker; here the host does that, because the Today goal picker
 * already lives in `feature:today` and reimplementing it would be a second copy to keep in
 * sync. Pass [onSwitch] to surface the "show a different goal" affordance.
 *
 * [goal] being null renders the empty state.
 */
@Composable
fun GoalHeroCard(
    goal: GoalsApi.Goal?,
    goalsLoaded: Boolean,
    modifier: Modifier = Modifier,
    /** The household's member ids — decides whether this reads as a Family or Group goal. */
    householdMemberIds: Set<String> = emptySet(),
    /** The person using this device, for the "My Goal" label. */
    myPersonId: String? = null,
    onOpen: (GoalsApi.Goal) -> Unit = {},
    onSeeAll: () -> Unit = {},
    onLog: (GoalsApi.Goal) -> Unit = {},
    /** Null hides the switcher — there is nothing else to show. */
    onSwitch: (() -> Unit)? = null,
) {
    if (goal == null) {
        GoalHeroEmpty(goalsLoaded = goalsLoaded, onSeeAll = onSeeAll, modifier = modifier)
        return
    }

    val fraction = goal.target?.takeIf { it > 0 }?.let { (goal.totalProgress / it).toFloat() } ?: 0f
    val biggest = maxOf(1.0, goal.participants.maxOfOrNull { it.progress } ?: 1.0)
    val shape = RoundedCornerShape(WF.radius.lg)

    Column(
        modifier
            .fillMaxWidth()
            .background(goalHeroBrush(WF.colors.success), shape)
            .clip(shape)
            .clickable { onOpen(goal) }
            .padding(15.dp),
        verticalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = scopeLabel(goal, householdMemberIds, myPersonId),
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp),
                // White on a saturated fill is the documented exception to the onInk rule.
                color = Color.White.copy(alpha = 0.9f),
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = "All goals",
                tint = Color.White.copy(alpha = 0.9f),
                modifier = Modifier
                    .size(22.dp)
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable(onClick = onSeeAll),
            )
        }

        Row(
            horizontalArrangement = Arrangement.spacedBy(13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            GoalRing(
                value = fraction,
                size = 78.dp,
                lineWidth = 8.dp,
                stroke = Color.White,
                track = Color.White.copy(alpha = 0.25f),
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = goalFmt(goal.totalProgress),
                        style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Black),
                        color = Color.White,
                        maxLines = 1,
                    )
                    if (goal.target != null) {
                        Text(
                            text = "of ${goalFmt(goal.target)}${goal.unit?.let { " $it" }.orEmpty()}",
                            style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.Bold),
                            color = Color.White.copy(alpha = 0.85f),
                            maxLines = 1,
                        )
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = "${goal.emoji ?: "🎯"} ${goal.title}",
                    style = WF.type.serif(19.sp),
                    color = Color.White,
                    maxLines = 3,
                )
                if (goal.streakDays > 0) {
                    Text(
                        text = "🔥 ${goal.streakDays}-day streak",
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                        color = Color.White.copy(alpha = 0.9f),
                    )
                }
            }
        }

        goal.participants.forEach { p ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AvatarFromHex(colorHex = p.colorHex, emoji = p.avatarEmoji ?: "🙂", size = 26.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = p.name,
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                            color = Color.White,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                        )
                        Text(
                            text = buildString {
                                append(goalFmt(p.progress))
                                p.target?.let { append(" / ${goalFmt(it)}") }
                                goal.unit?.let { append(" $it") }
                            },
                            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black),
                            color = Color.White,
                            maxLines = 1,
                        )
                    }
                    GoalProgressBar(
                        value = (p.progress / maxOf(1.0, p.target ?: biggest)).toFloat(),
                        tint = Color.White,
                        track = Color.White.copy(alpha = 0.25f),
                        height = 6.dp,
                    )
                }
            }
        }

        val pill = RoundedCornerShape(WF.radius.pill)
        Row(
            Modifier
                .fillMaxWidth()
                .background(Color.White, pill)
                .clip(pill)
                .clickable { onLog(goal) }
                .padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.Add,
                contentDescription = null,
                tint = WF.colors.success.deepened(),
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(WF.spacing.xs))
            Text(
                text = "Log ${goal.unit ?: "progress"}",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.success.deepened(),
            )
        }

        if (onSwitch != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Color.White.copy(alpha = 0.16f), pill)
                    .border(1.dp, Color.White.copy(alpha = 0.4f), pill)
                    .clip(pill)
                    .clickable(onClick = onSwitch)
                    .padding(vertical = 9.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.SwapHoriz,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(15.dp),
                )
                Spacer(Modifier.width(7.dp))
                Text(
                    text = "Show a different goal",
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                    color = Color.White,
                )
            }
        }
    }
}

@Composable
private fun GoalHeroEmpty(goalsLoaded: Boolean, onSeeAll: () -> Unit, modifier: Modifier) {
    WaffledCard(modifier = modifier.clickable(onClick = onSeeAll), padding = 15.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "Goals",
                style = WF.type.micro,
                color = WF.colors.ink2,
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = WF.colors.ink3,
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.size(WF.spacing.md))
        Text(
            text = if (goalsLoaded) "No goals yet — add one on the Goals page." else "Loading…",
            style = WF.type.bodySmall,
            color = WF.colors.ink3,
        )
    }
}

/**
 * Whose goal this is, so the card doesn't always claim "Family".
 *
 * The whole household → "Family Goal"; exactly one person → "My Goal" or "<Name>'s Goal";
 * any other subset → "Group Goal".
 */
internal fun scopeLabel(
    goal: GoalsApi.Goal,
    householdMemberIds: Set<String>,
    myPersonId: String?,
): String {
    val participants = goal.participants.map { it.personId }.toSet()
    if (householdMemberIds.size > 1 && participants.containsAll(householdMemberIds)) return "Family Goal"
    if (participants.size == 1) {
        if (myPersonId != null && participants == setOf(myPersonId)) return "My Goal"
        goal.participants.firstOrNull()?.let { return "${it.name}'s Goal" }
    }
    return if (participants.isEmpty()) "Goal" else "Group Goal"
}

@Preview(name = "Today goal hero", showBackground = true)
@Composable
private fun GoalHeroCardPreview() {
    WaffledTheme {
        Box(Modifier.background(WF.colors.canvas).padding(WF.spacing.xxl)) {
            GoalHeroCard(
                goal = GoalsApi.Goal(
                    id = "g1",
                    title = "1,000 Hours Outside",
                    emoji = "🌳",
                    unit = "hours",
                    target = 1000.0,
                    totalProgress = 221.5,
                    streakDays = 4,
                    participants = listOf(
                        GoalsApi.Participant("p1", "Kevin", "#2F7FED", "🧔", progress = 120.5),
                        GoalsApi.Participant("p2", "Kelly", "#E0548B", "👩", progress = 101.0),
                    ),
                ),
                goalsLoaded = true,
                householdMemberIds = setOf("p1", "p2"),
                myPersonId = "p1",
                onSwitch = {},
            )
        }
    }
}

@Preview(name = "Today goal hero · empty", showBackground = true)
@Composable
private fun GoalHeroCardEmptyPreview() {
    WaffledTheme {
        Box(Modifier.background(WF.colors.canvas).padding(WF.spacing.xxl)) {
            GoalHeroCard(goal = null, goalsLoaded = true)
        }
    }
}
