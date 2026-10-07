package app.waffled.feature.goals

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * The goal the log sheet judges, built from the freshly-loaded [detail] on top of the
 * lightweight [goal] the caller had: the detail's own participants, unit and habit axes,
 * so the sheet reads today's numbers. Shared by the detail screen and [GoalLogHost].
 */
internal fun logGoalFor(goal: GoalsApi.Goal, detail: GoalsApi.GoalDetail?): GoalsApi.Goal {
    if (detail == null) return goal
    return goal.copy(
        title = detail.title.ifBlank { goal.title },
        emoji = detail.emoji ?: goal.emoji,
        goalListId = detail.goalListId ?: goal.goalListId,
        category = detail.category ?: goal.category,
        deadline = detail.deadline ?: goal.deadline,
        isFeatured = detail.isFeatured,
        isSpotlight = detail.isSpotlight ?: goal.isSpotlight,
        streakDays = detail.streakDays,
        autoFromCalendar = detail.autoFromCalendar,
        healthMetric = detail.healthMetric ?: goal.healthMetric,
        createdAt = detail.createdAt.ifBlank { null } ?: goal.createdAt,
        unit = detail.unit ?: goal.unit,
        target = detail.target ?: goal.target,
        totalProgress = detail.totalProgress,
        participants = detail.participants.takeIf { it.isNotEmpty() } ?: goal.participants,
        participantMode = detail.participantMode ?: goal.participantMode,
        trackingMode = detail.trackingMode,
        targetBasis = detail.targetBasis ?: goal.targetBasis,
        habitPeriod = detail.habitPeriod ?: goal.habitPeriod,
        habitTargetPerPeriod = detail.habitTargetPerPeriod ?: goal.habitTargetPerPeriod,
        goalType = detail.goalType,
        periodDone = detail.periodDone ?: goal.periodDone,
        stepTotal = detail.stepTotal ?: goal.stepTotal,
        stepDone = detail.stepDone ?: goal.stepDone,
        loggedTodayBy = detail.loggedTodayBy ?: goal.loggedTodayBy,
    )
}

/**
 * Loads and writes for [GoalLogHost]. It is handed only an id, so it fetches the detail
 * (participants, habit axes, checklist steps), the logger's own note chips and the
 * household's today itself.
 */
class GoalLogHostModel(
    val api: GoalsApi,
    val goalId: String,
    private val refreshBus: RefreshBus? = null,
) {
    @Immutable
    data class State(
        val goal: GoalsApi.Goal? = null,
        val detail: GoalsApi.GoalDetail? = null,
        val noteSuggestions: List<String> = emptyList(),
        /** The household's today off the activity read; null falls back to the device's. */
        val today: LocalDate? = null,
        val loading: Boolean = true,
        val error: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    val current: State get() = _state.value

    /** Only the detail is required; the note chips and today are best-effort. */
    suspend fun load(meId: String?) {
        _state.value = _state.value.copy(loading = true)
        val fetched = runCatching {
            coroutineScope {
                val detail = async { api.goalDetail(goalId) }
                val notes = async { runCatching { api.noteSuggestions(goalId, meId) }.getOrDefault(emptyList()) }
                val today = async {
                    runCatching { GoalDateKey.parseOrNull(api.goalActivity(goalId).today) }.getOrNull()
                }
                Triple(detail.await(), notes.await(), today.await())
            }
        }
        val (detail, notes, today) = fetched.getOrNull() ?: run {
            _state.value = _state.value.copy(loading = false, error = true)
            return
        }
        _state.value = State(
            goal = logGoalFor(GoalsApi.Goal(id = detail.id, title = detail.title), detail),
            detail = detail,
            noteSuggestions = notes,
            today = today,
            loading = false,
            error = false,
        )
    }

    /** Returns whether the log landed; a refusal keeps the sheet open. */
    suspend fun save(
        amount: Double,
        hours: Int?,
        minutes: Int?,
        personIds: List<String>,
        note: String,
        loggedOn: String?,
    ): Boolean {
        val done = runCatching { api.logProgress(goalId, amount, personIds, note, loggedOn, hours, minutes) }
        if (done.isFailure) {
            _state.value = _state.value.copy(error = true)
            return false
        }
        refreshBus?.bump(RefreshDomain.Goals)
        return true
    }

    /** A checklist goal's "log" is a step tick; reload so the sheet shows it. */
    suspend fun tickStep(stepId: String, done: Boolean, meId: String?) {
        val ok = runCatching { api.tickStep(goalId, stepId, done) }.isSuccess
        if (!ok) {
            _state.value = _state.value.copy(error = true)
            return
        }
        refreshBus?.bump(RefreshDomain.Goals)
        load(meId)
    }

    fun dismissError() {
        _state.value = _state.value.copy(error = false)
    }
}

/**
 * Log progress against one goal in place — the Today hero's Log button (iOS `GoalHeroCard`
 * presents `GoalLogSheet` itself rather than opening the goal). Presents its own bottom
 * sheet; [onDone] fires when it closes, after a successful save or a dismiss, and
 * [onLogged] only after a save landed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalLogHost(
    goalId: String,
    api: GoalsApi,
    onDone: () -> Unit,
    /** The signed-in person's id — scopes the note chips to their own history. */
    meId: String? = null,
    refreshBus: RefreshBus? = null,
    onLogged: () -> Unit = {},
) {
    val model = remember(goalId, api) { GoalLogHostModel(api, goalId, refreshBus) }
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    // The sheet calls onSave then onDismiss in one tap. Closing the host there would cancel
    // the write with this composition's scope, so the close waits for the save instead.
    var saving by remember { mutableStateOf(false) }

    LaunchedEffect(model, meId) { model.load(meId) }

    ModalBottomSheet(
        onDismissRequest = onDone,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        if (state.error) {
            DismissibleErrorBanner(message = "Couldn't reach the server.", onDismiss = model::dismissError)
        }
        val goal = state.goal
        if (goal == null) {
            if (state.loading) WaffledLoading()
            return@ModalBottomSheet
        }
        GoalLogSheet(
            goal = goal,
            freshLoggedTodayBy = goal.loggedTodayBy,
            today = state.today ?: LocalDate.now(),
            noteSuggestions = state.noteSuggestions,
            steps = state.detail?.steps.orEmpty(),
            stepsLoaded = state.detail != null,
            onTickStep = { step, done -> scope.launch { model.tickStep(step.id, done, meId) } },
            onDismiss = { if (!saving) onDone() },
            onSave = { amount, hours, minutes, ids, note, loggedOn ->
                saving = true
                scope.launch {
                    val ok = model.save(amount, hours, minutes, ids, note, loggedOn)
                    saving = false
                    if (ok) {
                        onLogged()
                        onDone()
                    }
                }
            },
        )
    }
}
