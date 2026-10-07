package app.waffled.feature.goals

import androidx.compose.runtime.Immutable
import app.waffled.core.model.GoalSeries
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The Goals tab's state — the port of the iOS `GoalsModel`.
 *
 * Goals are **not** a PowerSync table, so this loads over REST on appear, on
 * pull-to-refresh, and after every write; and every write bumps [RefreshDomain.Goals] so
 * the other REST-backed screens (a Today goal card, the person spotlight) re-fetch.
 * Nothing else would ever hear about the change.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule.
 */
class GoalsModel(
    /** Public so the sheets can issue their own writes against one slice. */
    val api: GoalsApi,
    /** Public so the screen can watch it and re-fetch after somebody ELSE writes. */
    val refreshBus: RefreshBus? = null,
) {

    /** The All / Shared / Each segmented filter. Only meaningful on a shared list. */
    enum class Filter { All, Shared, Each }

    @Immutable
    data class State(
        val lists: List<GoalsApi.GoalList> = emptyList(),
        val goals: List<GoalsApi.Goal> = emptyList(),
        val selectedListId: String? = null,
        val filter: Filter = Filter.All,
        val loading: Boolean = true,
        val error: Boolean = false,
    ) {
        /** The picked list, falling back to the first so the screen is never listless. */
        val selectedList: GoalsApi.GoalList?
            get() = lists.firstOrNull { it.id == selectedListId } ?: lists.firstOrNull()

        /** A one-person list has nothing to filter — the segmented control is hidden. */
        val isIndividual: Boolean get() = (selectedList?.members?.size ?: 0) == 1

        /** Goals after the All/Shared/Each filter, which only applies to a shared list. */
        val visibleGoals: List<GoalsApi.Goal>
            get() = goals.filter { g ->
                isIndividual || filter == Filter.All ||
                    if (filter == Filter.Shared) {
                        g.trackingMode == "shared_total"
                    } else {
                        g.trackingMode == "each_tracks"
                    }
            }

        // Three tiers, mirroring the web: the one Spotlight hero, the Pinned band, then
        // everything else A–Z (the API already sorts A–Z). `isFeatured` is the internal
        // flag behind "Pinned".
        val spotlight: GoalsApi.Goal? get() = visibleGoals.firstOrNull { it.spotlight }
        val pinned: List<GoalsApi.Goal> get() = visibleGoals.filter { it.isFeatured && !it.spotlight }
        val more: List<GoalsApi.Goal> get() = visibleGoals.filter { !it.spotlight && !it.isFeatured }

        val isEmpty: Boolean get() = visibleGoals.isEmpty()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val current: State get() = _state.value

    /**
     * The `Goals` bus revision this model has already absorbed.
     *
     * The goal DETAIL screen owns a separate model, so logging progress or deleting a
     * goal there never touches this list's state — iOS reloads on nav pop. Watching the
     * bus is the Android equivalent, and comparing against what we've already seen is
     * what stops this model's OWN writes triggering a second, redundant fetch.
     */
    private var seenGoalsRevision = 0

    /** True when something else has changed goals since this model last read them. */
    fun isStale(): Boolean = (refreshBus?.revisionOf(RefreshDomain.Goals) ?: 0) > seenGoalsRevision

    // ---- loading ---------------------------------------------------------------

    /** Fetch the lists, keep or re-pick the selection, then load that list's goals. */
    suspend fun loadLists() {
        _state.value = _state.value.copy(loading = true)
        val fetched = runCatching { api.goalLists() }
        val lists = fetched.getOrNull()
        if (lists == null) {
            _state.value = _state.value.copy(loading = false, error = true)
            return
        }
        // Whoever was selected may have been deleted between loads.
        val keep = _state.value.selectedListId?.takeIf { id -> lists.any { it.id == id } }
        _state.value = _state.value.copy(
            lists = lists,
            selectedListId = keep ?: lists.firstOrNull()?.id,
            error = false,
        )
        loadGoals()
        _state.value = _state.value.copy(loading = false)
    }

    /** Switch lists. Resets the filter, because "Shared" means nothing on a new list. */
    suspend fun select(listId: String) {
        if (listId == _state.value.selectedListId) return
        _state.value = _state.value.copy(selectedListId = listId, filter = Filter.All)
        loadGoals()
    }

    fun setFilter(filter: Filter) {
        _state.value = _state.value.copy(filter = filter)
    }

    suspend fun loadGoals() {
        // Absorbed here rather than on success: a failed refresh still means we've SEEN
        // the change, and re-firing on every recomposition would hammer a flaky server.
        seenGoalsRevision = refreshBus?.revisionOf(RefreshDomain.Goals) ?: 0
        val listId = _state.value.selectedList?.id
        if (listId == null) {
            _state.value = _state.value.copy(goals = emptyList())
            return
        }
        val fetched = runCatching { api.goalsIn(listId) }
        _state.value = fetched.getOrNull()
            ?.let { _state.value.copy(goals = it, error = false) }
            // Keep the goals already on screen: a card must never blank on a flaky network.
            ?: _state.value.copy(error = true)
    }

    // ---- writes ----------------------------------------------------------------

    /** Quick pin/unpin straight from a card — the Pinned tier is `isFeatured`. */
    suspend fun togglePin(goal: GoalsApi.Goal) {
        write { api.updateGoal(goal.id, buildJsonObject { put("isFeatured", !goal.isFeatured) }) }
    }

    /**
     * Log progress against a goal. A time goal passes [hours] / [minutes] and lets the
     * server fold them to decimal hours; everything else passes [amount].
     */
    suspend fun log(
        goalId: String,
        amount: Double,
        personIds: List<String>,
        note: String,
        loggedOn: String?,
        hours: Int? = null,
        minutes: Int? = null,
    ) {
        write {
            api.logProgress(
                goalId = goalId,
                amount = amount,
                personIds = personIds,
                note = note,
                loggedOn = loggedOn,
                hours = hours,
                minutes = minutes,
            )
        }
    }

    /** Create a goal, then reselect its list so the new goal is actually visible. */
    suspend fun create(body: JsonObject, listId: String?): Boolean {
        val created = runCatching { api.createGoal(body) }
        if (created.isFailure) {
            _state.value = _state.value.copy(error = true)
            return false
        }
        if (listId != null) _state.value = _state.value.copy(selectedListId = listId)
        refreshBus?.bump(RefreshDomain.Goals)
        loadLists()
        return true
    }

    /** Note the new list locally and reselect it, so it shows before the next fetch. */
    suspend fun selectNewList(listId: String) {
        _state.value = _state.value.copy(selectedListId = listId, filter = Filter.All)
        loadLists()
    }

    private suspend fun write(block: suspend () -> Unit) {
        val done = runCatching { block() }
        if (done.isFailure) {
            _state.value = _state.value.copy(error = true)
            return
        }
        refreshBus?.bump(RefreshDomain.Goals)
        loadGoals()
    }

    fun dismissError() {
        _state.value = _state.value.copy(error = false)
    }
}

/**
 * One goal's detail — the port of the iOS `GoalDetailModel`.
 *
 * Deliberately a SEPARATE model from [GoalsModel]: a delete, a step tick or an entry edit
 * here must not reach into the list screen's state. The list reloads when the detail is
 * popped.
 */
class GoalDetailModel(
    val api: GoalsApi,
    val goal: GoalsApi.Goal,
    private val refreshBus: RefreshBus? = null,
) {

    @Immutable
    data class State(
        val detail: GoalsApi.GoalDetail? = null,
        val lists: List<GoalsApi.GoalList> = emptyList(),
        /**
         * The day-bucketed history, already derived into the shape a data view draws.
         * Computed ONCE per load — never in a render pass.
         */
        val series: GoalSeries = GoalSeries(),
        val stats: GoalStatsResult? = null,
        val loading: Boolean = true,
        val error: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val current: State get() = _state.value

    // Prefer the freshly-loaded detail, fall back to the goal we were handed — the screen
    // can be reached from a lightweight goal (the person spotlight carries no participants).
    val unit: String? get() = _state.value.detail?.unit ?: goal.unit
    val target: Double? get() = _state.value.detail?.target ?: goal.target
    /** The raw LIFETIME total — the Log sheet's figure. Displays read [displayed]. */
    val progress: Double get() = _state.value.detail?.totalProgress ?: goal.totalProgress

    /** What every measured line reads off, on the goal's own axis. */
    val displayed: GoalDisplayable get() = _state.value.detail ?: goal
    val participants: List<GoalsApi.Participant>
        get() = _state.value.detail?.participants?.takeIf { it.isNotEmpty() } ?: goal.participants

    /**
     * Fetch the detail, the lists (for the editor's group picker) and the activity in
     * parallel — they are independent, and doing them serially triples the wait on a phone.
     *
     * A failed ACTIVITY read is not a failed load: the ring, the ladder and the log are all
     * still worth showing, so the data view just falls back to an empty series.
     */
    suspend fun load() {
        _state.value = _state.value.copy(loading = true)
        val fetched = runCatching {
            coroutineScope {
                val detail = async { api.goalDetail(goal.id) }
                // Only the editor's group picker reads the lists, so a failed read must not
                // drop the detail (the hero's THIS WEEK would fall back to 0). iOS keeps
                // the detail the same way.
                val lists = async { runCatching { api.goalLists() }.getOrNull() }
                val activity = async { runCatching { api.goalActivity(goal.id) }.getOrNull() }
                Triple(detail.await(), lists.await(), activity.await())
            }
        }

        val loaded = fetched.getOrNull()
        if (loaded == null) {
            _state.value = _state.value.copy(loading = false, error = true)
            return
        }
        val (detail, lists, activity) = loaded
        _state.value = State(
            detail = detail,
            lists = lists ?: _state.value.lists,
            series = seriesFrom(detail, activity),
            stats = activity?.let {
                GoalStats.compute(
                    today = it.today,
                    startDate = it.startDate,
                    endDate = it.endDate,
                    target = detail.target,
                    days = it.entries(),
                )
            },
            loading = false,
            error = false,
        )
    }

    /**
     * The seam handed to the host-supplied data view.
     *
     * `activity` owns the WINDOW (the server knows the goal's real start and its
     * household-local today); `detail` owns the SHAPE (type, cadence, target, unit) and
     * the person colours.
     */
    private fun seriesFrom(detail: GoalsApi.GoalDetail, activity: GoalsApi.GoalActivity?): GoalSeries {
        if (activity == null) return GoalSeries(unit = detail.unit.orEmpty())
        return GoalSeriesBuilder.build(
            goalType = detail.goalType,
            unit = detail.unit,
            target = detail.target,
            habitPeriod = detail.habitPeriod,
            habitTargetPerPeriod = detail.habitTargetPerPeriod,
            startDate = activity.startDate,
            endDate = activity.endDate,
            today = activity.today,
            days = activity.entries(),
            personColors = detail.participants
                .mapNotNull { p -> p.colorHex?.let { p.personId to it } }
                .toMap(),
        )
    }

    suspend fun update(body: JsonObject) = write { api.updateGoal(goal.id, body) }

    suspend fun log(
        amount: Double,
        personIds: List<String>,
        note: String,
        loggedOn: String?,
        hours: Int? = null,
        minutes: Int? = null,
    ) = write {
        api.logProgress(
            goalId = goal.id,
            amount = amount,
            personIds = personIds,
            note = note,
            loggedOn = loggedOn,
            hours = hours,
            minutes = minutes,
        )
    }

    suspend fun tickStep(stepId: String, done: Boolean) = write { api.tickStep(goal.id, stepId, done) }

    /**
     * Both entry writes return the server's own sentence when it refuses (null on success),
     * so the entry sheet can stay open with the typed note intact.
     */
    suspend fun editEntry(
        logId: String,
        amount: Double?,
        personIds: List<String>?,
        note: String?,
        loggedOn: String?,
    ): String? = writeOrRefusal("Could not save this change.") {
        api.editLog(goal.id, logId, amount, personIds, note, loggedOn)
    }

    suspend fun deleteEntry(logId: String): String? =
        writeOrRefusal("Could not delete this entry.") { api.deleteLog(goal.id, logId) }

    private suspend fun writeOrRefusal(fallback: String, block: suspend () -> Unit): String? {
        val done = runCatching { block() }
        done.exceptionOrNull()?.let { e ->
            return (e as? WaffledApiException)?.userMessage?.takeIf { it.isNotBlank() } ?: fallback
        }
        refreshBus?.bump(RefreshDomain.Goals)
        load()
        return null
    }

    /** Delete the goal. Returns whether the caller should pop back. */
    suspend fun delete(): Boolean {
        val done = runCatching { api.deleteGoal(goal.id) }
        if (done.isFailure) {
            _state.value = _state.value.copy(error = true)
            return false
        }
        refreshBus?.bump(RefreshDomain.Goals)
        return true
    }

    private suspend fun write(block: suspend () -> Unit) {
        val done = runCatching { block() }
        if (done.isFailure) {
            _state.value = _state.value.copy(error = true)
            return
        }
        refreshBus?.bump(RefreshDomain.Goals)
        load()
    }

    fun dismissError() {
        _state.value = _state.value.copy(error = false)
    }
}
