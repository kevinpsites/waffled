package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Edit
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
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledTheme
import app.waffled.core.design.wfField
import app.waffled.core.model.GoalPoint
import app.waffled.core.model.GoalSeries
import app.waffled.core.model.Person
import java.time.LocalDate
import kotlinx.coroutines.launch

/**
 * One goal's detail — the hero ring, the primary actions, the checklist steps, the data
 * view, the milestone ladder, the recent-activity log and delete. The phone port of the
 * iOS `GoalDetailView`.
 *
 * ## The data-view slot
 *
 * The eight visualisations live in `feature:goalcharts`, which this module does not depend
 * on. They meet at [GoalSeries] in `core:model`: this screen DERIVES the series (see
 * [GoalSeriesBuilder]) and hands it to a host-supplied slot —
 *
 * ```
 * dataView: @Composable (GoalSeries) -> Unit
 * ```
 *
 * — so the integrator passes the real switcher and this module's own previews pass a
 * placeholder. The series is computed once per load in [GoalDetailModel], never in a
 * render pass.
 *
 * **Scope:** phone layout only.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalDetailScreen(
    model: GoalDetailModel,
    /** The signed-in person — the source of the `goal.manage` gate. */
    me: Person?,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    /** Open the calendar's event editor pre-linked to this goal. */
    onScheduleEvent: ((goalId: String, participantIds: List<String>) -> Unit)? = null,
    /** The host-supplied visualisation. Defaults to nothing at all. */
    dataView: @Composable (GoalSeries) -> Unit = {},
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val canManage = GoalsAccess.canManage(me)

    var logging by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var editEntry by remember { mutableStateOf<GoalsApi.GoalDetail.LogEntry?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }

    LaunchedEffect(model.goal.id) { model.load() }

    val detail = state.detail
    val goalType = detail?.goalType ?: model.goal.goalType
    val isChecklist = goalType == "checklist"
    val unit = model.unit
    val target = model.target
    val progress = model.progress

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
            Text(
                text = model.goal.title,
                style = WF.type.sectionTitle,
                color = WF.colors.ink,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            if (canManage && detail != null) {
                Icon(
                    imageVector = Icons.Filled.Edit,
                    contentDescription = "Edit goal",
                    tint = WF.colors.ink2,
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .clickable { editing = true }
                        .padding(5.dp),
                )
            }
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WF.spacing.xxl)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.xxl),
        ) {
            if (state.error) {
                DismissibleErrorBanner(
                    message = "Couldn't reach the server.",
                    onDismiss = model::dismissError,
                )
            }

            DetailHero(
                title = model.goal.title,
                category = detail?.category,
                displayed = model.displayed,
                unit = unit,
                thisWeek = detail?.thisWeek ?: 0.0,
                subtitle = heroSubtitle(detail, model.goal),
            )

            // Logging is the primary action, so it gets a full-width button rather than
            // hiding in the header.
            PrimaryAction(
                label = "Log progress",
                icon = Icons.Filled.Add,
                fill = WF.colors.success,
                onClick = { logging = true },
            )

            if (detail?.autoFromCalendar == true && onScheduleEvent != null) {
                SecondaryAction(
                    label = if (isHourUnit(unit)) {
                        "Plan time on the calendar"
                    } else {
                        "Schedule on the calendar"
                    },
                    onClick = { onScheduleEvent(model.goal.id, model.participants.map { it.personId }) },
                )
            }

            if (isChecklist && !detail?.steps.isNullOrEmpty()) {
                DetailCard {
                    SectionLabel("Steps")
                    detail.steps.forEach { step ->
                        StepRow(step) { scope.launch { model.tickStep(step.id, !step.done) } }
                    }
                }
            }

            // The host's visualisation, fed the already-derived series.
            dataView(state.series)

            if (!detail?.milestones.isNullOrEmpty()) {
                MilestoneCard(milestones = detail.milestones, displayed = model.displayed)
            }

            RecentActivityCard(
                entries = detail?.recent.orEmpty(),
                unit = unit,
                // A checklist's "entries" are step ticks, managed by the step rows above.
                canEdit = !isChecklist,
                onEdit = { editEntry = it },
            )

            if (state.loading && detail == null) WaffledLoading()

            if (canManage) {
                Text(
                    text = if (confirmDelete) "Tap again to delete this goal" else "Delete goal",
                    style = WF.type.label,
                    color = if (confirmDelete) WF.colors.primary else WF.colors.ink3,
                    modifier = Modifier
                        .clip(RoundedCornerShape(WF.radius.sm))
                        .clickable {
                            if (confirmDelete) {
                                scope.launch { if (model.delete()) onBack() }
                            } else {
                                confirmDelete = true
                            }
                        }
                        .padding(vertical = WF.spacing.sm, horizontal = WF.spacing.xxs),
                )
            }
        }
    }

    if (logging) {
        // Hand the sheet the freshly-loaded participants and unit: the screen can be
        // reached from a lightweight goal (the person spotlight carries neither).
        val logGoal = model.goal.copy(
            unit = unit,
            target = target,
            totalProgress = progress,
            participants = model.participants,
            participantMode = detail?.participantMode ?: model.goal.participantMode,
            trackingMode = detail?.trackingMode ?: model.goal.trackingMode,
            targetBasis = detail?.targetBasis ?: model.goal.targetBasis,
            habitPeriod = detail?.habitPeriod ?: model.goal.habitPeriod,
            habitTargetPerPeriod = detail?.habitTargetPerPeriod ?: model.goal.habitTargetPerPeriod,
            goalType = goalType,
            // The detail's own axes, so the sheet judges the habit on today's numbers.
            periodDone = detail?.periodDone ?: model.goal.periodDone,
            stepTotal = detail?.stepTotal ?: model.goal.stepTotal,
            stepDone = detail?.stepDone ?: model.goal.stepDone,
            loggedTodayBy = detail?.loggedTodayBy ?: model.goal.loggedTodayBy,
        )
        ModalBottomSheet(
            onDismissRequest = { logging = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            // This goal's own most-used notes, scoped to the logger so each member's box
            // learns their own history. Best-effort: a failure leaves the defaults.
            var noteSuggestions by remember(model.goal.id) { mutableStateOf(emptyList<String>()) }
            LaunchedEffect(model.goal.id, me?.id) {
                noteSuggestions = runCatching { model.api.noteSuggestions(model.goal.id, me?.id) }
                    .getOrDefault(emptyList())
            }
            GoalLogSheet(
                goal = logGoal,
                // The household's today, off the series the server built — not the
                // DEVICE's date, which drifts across a timezone boundary.
                today = state.series.today ?: LocalDate.now(),
                noteSuggestions = noteSuggestions,
                steps = detail?.steps.orEmpty(),
                stepsLoaded = detail != null,
                onTickStep = { step, done -> scope.launch { model.tickStep(step.id, done) } },
                onDismiss = { logging = false },
                onSave = { amount, hours, minutes, ids, note, loggedOn ->
                    scope.launch { model.log(amount, ids, note, loggedOn, hours, minutes) }
                },
            )
        }
    }

    if (editing && detail != null) {
        ModalBottomSheet(
            onDismissRequest = { editing = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            GoalCreateSheet(
                lists = state.lists,
                initial = GoalDraft.from(detail),
                onDismiss = { editing = false },
                onSubmit = { body, _ -> scope.launch { model.update(body) } },
            )
        }
    }

    editEntry?.let { entry ->
        ModalBottomSheet(
            onDismissRequest = { editEntry = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            GoalEntryEditSheet(
                entry = entry,
                today = state.series.today ?: LocalDate.now(),
                participants = model.participants,
                goalType = goalType,
                unit = unit,
                onDismiss = { editEntry = null },
                onSave = { p -> model.editEntry(entry.id, p.amount, p.personIds, p.note, p.loggedOn) },
                onDelete = { model.deleteEntry(entry.id) },
            )
        }
    }
}

/** "Started Jan 1 · 22% complete · 🔥 4-day streak · by Dec 31". */
internal fun heroSubtitle(detail: GoalsApi.GoalDetail?, fallback: GoalsApi.Goal): String {
    val parts = mutableListOf<String>()
    detail?.createdAt?.takeIf { it.isNotBlank() }?.let { parts.add("Started ${monthDay(it)}") }
    val displayed: GoalDisplayable = detail ?: fallback
    val pct = (GoalDisplay.fraction(displayed) * 100).toInt()
    // A habit's percent is of THIS period's cadence, so say which window.
    parts.add("$pct% ${GoalDisplay.periodLabel(displayed) ?: "complete"}")
    val streak = detail?.streakDays ?: fallback.streakDays
    if (streak > 0) parts.add("🔥 $streak-day streak")
    (detail?.deadline ?: fallback.deadline)?.let { parts.add("by ${monthDay(it)}") }
    // Surface that this goal fills itself from health data configured on another platform.
    HealthAutoFill.linkedBadge(detail?.healthMetric ?: fallback.healthMetric)?.let(parts::add)
    return parts.joinToString(" · ")
}

/** "Jan 1" from an ISO timestamp or a bare day. Falls back to nothing worth showing. */
private fun monthDay(iso: String): String {
    val day = runCatching { GoalDateKey.parse(iso) }.getOrNull() ?: return ""
    val month = day.month.getDisplayName(
        java.time.format.TextStyle.SHORT,
        java.util.Locale.getDefault(),
    )
    return "$month ${day.dayOfMonth}"
}

@Composable
private fun DetailHero(
    title: String,
    category: String?,
    displayed: GoalDisplayable,
    unit: String?,
    thisWeek: Double,
    subtitle: String,
) {
    val fraction = GoalDisplay.fraction(displayed).toFloat()
    val shape = RoundedCornerShape(WF.radius.lg)
    Row(
        Modifier
            .fillMaxWidth()
            .background(goalHeroBrush(WF.colors.success), shape)
            .clip(shape)
            .padding(WF.spacing.xxl),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.xl),
        verticalAlignment = Alignment.Top,
    ) {
        GoalRing(
            value = fraction,
            size = 104.dp,
            lineWidth = 9.dp,
            stroke = Color.White,
            track = Color.White.copy(alpha = 0.25f),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = ringFmt(GoalDisplay.progress(displayed)),
                    style = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Black),
                    color = Color.White,
                    maxLines = 1,
                )
                Text(
                    text = GoalDisplay.targetCaption(displayed, unit, ::ringFmt),
                    style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.Bold),
                    color = Color.White.copy(alpha = 0.85f),
                    maxLines = 1,
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.xs)) {
            GoalHeroPill(
                category?.let { "${goalCategoryEmoji(it)} ${it.replaceFirstChar(Char::uppercase)}" }
                    ?: "⭐ Featured",
            )
            Text(title, style = WF.type.sectionTitle, color = Color.White, maxLines = 3)
            Text(
                text = subtitle,
                style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                color = Color.White.copy(alpha = 0.9f),
            )
            Spacer(Modifier.height(WF.spacing.xxs))
            Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxs)) {
                Text(
                    text = "THIS WEEK",
                    style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.Black),
                    color = Color.White.copy(alpha = 0.8f),
                )
                Text(
                    text = "${goalFmt(thisWeek)}${unit?.let { " $it" }.orEmpty()}",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black),
                    color = Color.White,
                )
            }
        }
    }
}

@Composable
private fun PrimaryAction(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    fill: Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .background(goalHeroBrush(fill), shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 13.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(imageVector = icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(WF.spacing.xs))
        Text(label, style = WF.type.label, color = Color.White)
    }
}

@Composable
private fun SecondaryAction(label: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.ai.copy(alpha = 0.08f), shape)
            .border(1.dp, WF.colors.ai.copy(alpha = 0.25f), shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 13.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.CalendarMonth,
            contentDescription = null,
            tint = WF.colors.ai,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(WF.spacing.xs))
        Text(label, style = WF.type.label, color = WF.colors.ai)
    }
}

@Composable
private fun DetailCard(content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .wfField()
            .padding(WF.spacing.xxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.lg),
    ) {
        content()
    }
}

@Composable
private fun MilestoneCard(milestones: List<GoalsApi.GoalDetail.Milestone>, displayed: GoalDisplayable) {
    val firstUnreached = milestones.indexOfFirst { !it.reached }
    DetailCard {
        Text("Milestones", style = WF.type.cardTitle, color = WF.colors.ink)
        milestones.forEachIndexed { index, m ->
            val isNow = index == firstUnreached
            val reachedTint = FamilyColor.Person3.solid
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(34.dp)
                        .background(
                            when {
                                m.reached -> reachedTint.copy(alpha = 0.18f)
                                isNow -> WF.colors.primary.copy(alpha = 0.12f)
                                else -> WF.colors.panel
                            },
                            CircleShape,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(m.emoji ?: "⛳", style = TextStyle(fontSize = 16.sp))
                }
                Text(
                    text = m.label ?: goalFmt(m.threshold),
                    style = WF.type.label,
                    color = if (m.reached || isNow) WF.colors.ink else WF.colors.ink2,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = when {
                        m.reached -> "reached"
                        isNow -> GoalDisplay.milestoneToGo(displayed, m.threshold, ::goalFmt)
                        else -> m.rewardText?.takeIf { it.isNotBlank() } ?: "—"
                    },
                    style = WF.type.caption,
                    color = when {
                        m.reached -> reachedTint
                        isNow -> WF.colors.primary
                        else -> WF.colors.ink3
                    },
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun RecentActivityCard(
    entries: List<GoalsApi.GoalDetail.LogEntry>,
    unit: String?,
    canEdit: Boolean,
    onEdit: (GoalsApi.GoalDetail.LogEntry) -> Unit,
) {
    DetailCard {
        Text("Recent activity", style = WF.type.cardTitle, color = WF.colors.ink)
        if (entries.isEmpty()) {
            Text(
                text = "No activity yet — log some progress.",
                style = WF.type.bodySmall,
                color = WF.colors.ink3,
            )
            return@DetailCard
        }
        entries.forEach { log ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(WF.radius.sm))
                    .clickable(enabled = canEdit) { onEdit(log) }
                    .padding(vertical = WF.spacing.sm),
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = weekday(log.dateKey),
                    style = WF.type.micro,
                    color = WF.colors.ink3,
                    modifier = Modifier.width(34.dp),
                )
                if (log.participants.isEmpty()) {
                    AvatarFromHex(colorHex = null, emoji = "🙂", size = 24.dp)
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
                        log.participants.take(4).forEach { p ->
                            AvatarFromHex(
                                colorHex = p.colorHex,
                                emoji = p.avatarEmoji ?: "🙂",
                                size = 24.dp,
                            )
                        }
                    }
                }
                Text(
                    text = log.note?.takeIf { it.isNotBlank() } ?: "Logged progress",
                    style = WF.type.bodySmall,
                    color = WF.colors.ink,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "+${goalFmt(log.amount)}${unit?.let { " $it" }.orEmpty()}",
                    style = WF.type.label,
                    color = FamilyColor.Person3.solid,
                )
                if (canEdit) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = "Edit entry",
                        tint = WF.colors.ink3,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }
}

/** "Fri" from the entry's HOUSEHOLD-bucketed day key, never a re-parse of `loggedAt`. */
private fun weekday(dateKey: String): String {
    val day = runCatching { GoalDateKey.parse(dateKey) }.getOrNull() ?: return ""
    return day.dayOfWeek.getDisplayName(
        java.time.format.TextStyle.SHORT,
        java.util.Locale.getDefault(),
    )
}

// ---------------------------------------------------------------------------
// Previews — the data-view slot gets a placeholder here, because the real eight
// visualisations live in `feature:goalcharts`, which this module cannot see.
// ---------------------------------------------------------------------------

/** The stand-in this module's previews pass for [GoalDetailScreen]'s `dataView` slot. */
@Composable
fun GoalSeriesPlaceholder(series: GoalSeries) {
    Column(
        Modifier
            .fillMaxWidth()
            .wfField()
            .padding(WF.spacing.xxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
    ) {
        SectionLabel("Data view")
        Text(
            text = "${series.points.size} points · ${series.byDay.size} days · " +
                "total ${goalFmt(series.total)}${series.unit.let { if (it.isEmpty()) "" else " $it" }}",
            style = WF.type.bodySmall,
            color = WF.colors.ink2,
        )
        Text(
            text = "The visualisation is supplied by the host (feature:goalcharts).",
            style = WF.type.caption,
            color = WF.colors.ink3,
        )
    }
}

@Preview(name = "Data view slot", showBackground = true)
@Composable
private fun GoalSeriesPlaceholderPreview() {
    WaffledTheme {
        Box(Modifier.background(WF.colors.canvas).padding(WF.spacing.xxl)) {
            GoalSeriesPlaceholder(
                GoalSeries(
                    points = listOf(
                        GoalPoint(LocalDate.of(2026, 7, 15), 3.0, "p1"),
                        GoalPoint(LocalDate.of(2026, 7, 17), 5.0, "p1"),
                    ),
                    target = 100,
                    unit = "hours",
                ),
            )
        }
    }
}
