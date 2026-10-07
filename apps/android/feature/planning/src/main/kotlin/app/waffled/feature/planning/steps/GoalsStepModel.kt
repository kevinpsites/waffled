package app.waffled.feature.planning.steps

import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.goals.goalFmt
import app.waffled.feature.planning.api.PlanningGoalGoal
import app.waffled.feature.planning.api.PlanningGoalGroup
import app.waffled.feature.planning.api.PlanningGoalsApi
import app.waffled.feature.planning.api.PlanningGoalsCrumb
import app.waffled.feature.planning.api.PlanningGoalsView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Weekly Planning · step 6 "Goals" — everything the body renders, as one snapshot. */
data class PlanningGoalsStepState(
    val view: PlanningGoalsView? = null,
    /** Set even by a FAILED fetch, which keeps the previous [view]. */
    val loaded: Boolean = false,
    /** The list (or goal, for a week target) a write is in flight for. ONE AT A TIME. */
    val savingListId: String? = null,
    val errorMessage: String? = null,
    val tabId: String? = null,
    /** Bumped when a read or write LANDS, so the body pushes the crumb from one effect. */
    val rev: Int = 0,
    /** The composer's group as an ID: a refetch replaces every group object. */
    val newForListId: String? = null,
    /** A create is in flight — separate from [savingListId], which reads as "settling". */
    val creating: Boolean = false,
) {
    val groups: List<PlanningGoalGroup> get() = view?.groups.orEmpty()
    val settledCount: Int get() = groups.count { it.settled }
    val active: PlanningGoalGroup? get() = groups.firstOrNull { it.listId == tabId } ?: groups.firstOrNull()
    val newGoalGroup: PlanningGoalGroup? get() = newForListId?.let { id -> groups.firstOrNull { it.listId == id } }

    fun isFrozen(shellBusy: Boolean): Boolean = shellBusy || savingListId != null || creating

    /**
     * NULL UNTIL A READ HAS LANDED: an empty map is a claim, and the shell REPLACES the
     * step's data with the crumb when the primary is pressed.
     */
    val crumb: JsonObject? get() = view?.let { PlanningGoalsCrumb.decision(it) }
}

/**
 * The Goals step's state, with no view in it. Port of iOS `PlanningGoalsStepModel`. A
 * FAILED fetch keeps the previous value and still sets `loaded`; a failed write neither
 * refetches nor mutates. Call from one dispatcher (Main).
 */
class PlanningGoalsStepModel(
    private val fetchGoals: suspend (sessionId: String) -> PlanningGoalsView,
    private val setFocus: suspend (sessionId: String, listId: String, goalId: String?) -> PlanningGoalsView,
    /** `POST /api/goals` — the goals module's own create; no planning-only endpoint. */
    private val createGoal: suspend (body: JsonObject) -> Unit,
    private val setWeekTarget: suspend (sessionId: String, goalId: String, target: Double?) -> PlanningGoalsView,
) {
    constructor(api: PlanningGoalsApi, goals: GoalsApi) : this(
        fetchGoals = { api.goals(it) },
        setFocus = { s, l, g -> api.setFocus(s, l, g) },
        createGoal = { goals.createGoal(it) },
        setWeekTarget = { s, g, t -> api.setWeekTarget(s, g, t) },
    )

    private val _state = MutableStateFlow(PlanningGoalsStepState())
    val state: StateFlow<PlanningGoalsStepState> = _state.asStateFlow()
    val current: PlanningGoalsStepState get() = _state.value

    suspend fun load(sessionId: String) {
        attempt { fetchGoals(sessionId) }?.let(::apply)
        _state.update { it.copy(loaded = true) }
    }

    fun selectTab(listId: String) {
        if (current.groups.none { it.listId == listId }) return
        _state.update { it.copy(tabId = listId) }
    }

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    /** Answer one group; `goalId` null is "nothing this week". Does not settle the STEP. */
    suspend fun pick(sessionId: String, listId: String, goalId: String?) =
        write(listId) { setFocus(sessionId, listId, goalId) }

    /** This week's target for one goal; the group's focus is left alone. */
    suspend fun setWeekTarget(sessionId: String, goalId: String, target: Double?) =
        write(goalId) { setWeekTarget.invoke(sessionId, goalId, target) }

    private suspend fun write(savingId: String, call: suspend () -> PlanningGoalsView) {
        if (current.savingListId != null) return
        _state.update { it.copy(savingListId = savingId, errorMessage = null) }
        try {
            apply(call())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            _state.update { it.copy(errorMessage = "That didn’t take — try again.") }
        } finally {
            _state.update { it.copy(savingListId = null) }
        }
    }

    // ---- "＋ New goal for this week" ----

    /** Open the editor for the group ON SCREEN — a chooser would let the goal vanish elsewhere. */
    fun openNewGoal() {
        val listId = current.active?.listId
        if (current.creating || listId == null) return
        _state.update { it.copy(errorMessage = null, newForListId = listId) }
    }

    fun closeNewGoal() = _state.update { it.copy(newForListId = null) }

    /**
     * Make the goal, then re-read so it is ON SCREEN in its group. CREATING IS NOT
     * CONFIRMING: no `/goals/focus` call. [listId] is passed in because the editor closes
     * (clearing [PlanningGoalsStepState.newForListId]) the instant it submits.
     */
    suspend fun submitNewGoal(sessionId: String, listId: String, body: JsonObject): Boolean {
        if (current.creating || current.groups.none { it.listId == listId }) return false
        _state.update { it.copy(creating = true, errorMessage = null, newForListId = null) }
        try {
            try {
                createGoal(newGoalBody(body, listId))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.update { it.copy(errorMessage = "That goal didn’t save — try again.") }
                return false
            }
            // A failed refetch keeps the last good groups and does NOT bump `rev`.
            attempt { fetchGoals(sessionId) }?.let { latest ->
                apply(latest)
                if (latest.groups.any { it.listId == listId }) _state.update { it.copy(tabId = listId) }
            }
            return true
        } finally {
            _state.update { it.copy(creating = false) }
        }
    }

    private fun apply(latest: PlanningGoalsView) {
        _state.update { s ->
            // Land on WHAT'S LEFT the first time and stay put: only an empty or vanished
            // selection is filled, so a tap is never reverted by a later read.
            val keep = s.tabId != null && latest.groups.any { it.listId == s.tabId }
            val tab = if (keep) s.tabId else (latest.groups.firstOrNull { !it.settled } ?: latest.groups.firstOrNull())?.listId
            s.copy(view = latest, rev = s.rev + 1, tabId = tab)
        }
    }

    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    companion object {
        /** The ONE thing the step decides about a goal made here: which group it joins. */
        fun newGoalBody(body: JsonObject, listId: String): JsonObject =
            JsonObject(body + ("goalListId" to JsonPrimitive(listId)))

        /**
         * The GOALS MODULE's rule: `goal.manage` for any group, else only a group that is
         * just you. Offering an editor the server would refuse is show-then-403.
         */
        fun canTarget(g: PlanningGoalGroup, canManageGoals: Boolean, personId: String?): Boolean {
            if (canManageGoals) return true
            if (personId == null || g.members.size != 1) return false
            return g.members[0].personId == personId
        }
    }
}

object PlanningGoalsText {

    /** "3 of 10 hours this week". */
    fun weekLine(item: PlanningGoalGoal): String {
        val unit = item.goal.unit?.let { " $it" } ?: ""
        item.weekTarget?.let { return "${goalFmt(item.weekDone)} of ${goalFmt(it)}$unit this week" }
        return if (item.weekDone > 0) "${goalFmt(item.weekDone)}$unit so far this week" else "No target for this week"
    }

    sealed interface TargetEntry {
        data class Set(val value: Double) : TargetEntry
        data object Clear : TargetEntry
        data object Invalid : TargetEntry
    }

    /** A positive number, blank (clear the week's target), or neither. */
    fun parseTarget(text: String): TargetEntry {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return TargetEntry.Clear
        val n = trimmed.toDoubleOrNull() ?: return TargetEntry.Invalid
        return if (n.isFinite() && n > 0) TargetEntry.Set(n) else TargetEntry.Invalid
    }

    fun targetText(target: Double?): String = target?.let { goalFmt(it) } ?: ""

    /** The axis label under the number, matching the rule `GoalDisplay` implements. */
    fun axisLabel(g: GoalsApi.Goal): String = when (g.goalType) {
        "habit" -> if (g.habitPeriod == "day") "today" else "this ${g.habitPeriod ?: "week"}"
        "checklist" -> "steps done"
        else -> g.unit ?: "so far"
    }

    fun kindLabel(g: GoalsApi.Goal): String =
        mapOf("count" to "Count", "total" to "Total", "habit" to "Habit", "checklist" to "Checklist")[g.goalType]
            ?: g.goalType

    /** EVERY CLAUSE IS A FACT THE SERVER SENT — no birthday on file drops the age. */
    fun groupSubtitle(g: PlanningGoalGroup): String {
        val n = g.members.size
        if (g.isPrivate) {
            return when (n) {
                2 -> "private · just the two of you"
                1 -> "private · just you"
                else -> "private · $n people"
            }
        }
        if (n == 1) return g.members[0].age?.let { "individual · age $it" } ?: "individual"
        if (g.isEveryone) return "shared · everyone tracks it"
        if (n == 2) return "shared · " + g.members.joinToString(" & ") { it.name.substringBefore(' ') }
        return "shared · $n people"
    }

    /** THREE STATES: "already pinned" and "we decided" are not the same claim. */
    fun verdict(g: PlanningGoalGroup): String {
        val focus = g.goals.firstOrNull { it.id == g.focusGoalId } ?: return "No focus this week — that’s allowed"
        return if (g.settled) {
            "★ This week · ${focus.goal.title}"
        } else {
            "Pinned already · ${focus.goal.title} — keep it, or pick another"
        }
    }
}
