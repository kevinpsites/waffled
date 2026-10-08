package app.waffled.feature.planning

import androidx.compose.runtime.Immutable
import app.waffled.core.auth.KeyValueStore
import app.waffled.core.model.WaffledDates
import app.waffled.core.network.WaffledApiException
import app.waffled.feature.planning.api.PlanningApi
import app.waffled.feature.planning.api.PlanningConfigPatch
import app.waffled.feature.planning.api.PlanningListCandidate
import app.waffled.feature.planning.api.PlanningSession
import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.WeeklyPlanningCompletion
import app.waffled.feature.planning.api.WeeklyPlanningConfig
import app.waffled.feature.planning.api.WeeklyPlanningConfigView
import app.waffled.feature.planning.api.WeeklyPlanningView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import java.time.ZoneId

/** One tag a parked note may be addressed to; the label is the catalog's own step title. */
@Immutable
data class PlanningParkedTag(val stepKey: String, val label: String, val hint: String? = null)

/**
 * Everything the shell renders, as one immutable snapshot. Labels and numbers are
 * precomputed once per load; the derived getters below are cheap list scans, never date math.
 */
@Immutable
data class PlanningState(
    val view: WeeklyPlanningView? = null,
    /** Set even by a FAILED fetch, which keeps the previous [view]. */
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val errorMessage: String? = null,
    /** Why the park composer couldn't park; the composer stays open on what was typed. */
    val parkError: String? = null,
    /** Bumped by a park between sessions, so the record's read-back re-reads. */
    val parkedBetweenRevision: Int = 0,
    /** The week the NEXT fetch asks for; null means the server's default week. */
    val requestedWeek: String? = null,
    /** The step this screen is looking at, or null to follow the session's own pointer. */
    val askedStep: String? = null,
    val pausedSessionId: String? = null,
    val weekLabel: String = "",
    val sessionDayName: String = "",
    val savedAtLabel: String? = null,
    /** The lists the loose-ends step could ask about. Empty is a real answer. */
    val listCandidates: List<PlanningListCandidate> = emptyList(),
    val actGroups: List<PlanningActGroup> = emptyList(),
    /** Each runnable step's 1-based position — NOT `PlanningStep.number`, a catalog index. */
    val stepNumbers: Map<String, Int> = emptyMap(),
) {
    val steps: List<PlanningStep> get() = view?.steps.orEmpty()
    val runnable: List<PlanningStep> get() = PlanningFormat.availableSteps(steps)
    val session: PlanningSession? get() = view?.session
    val config: WeeklyPlanningConfig? get() = view?.config

    val current: PlanningStep? get() = PlanningFormat.resolveCurrent(view, askedStep)
    val next: PlanningStep? get() = current?.let { PlanningFormat.nextStepAfter(steps, it.key) }

    /** Loose ends and Horizon carry their own park bar. */
    val showsParkBar: Boolean get() = current?.key.let { it != null && it != "looseEnds" && it != "horizon" }

    /** The steps still ahead that can raise a parked note — never Loose ends or the Recap. */
    val parkTags: List<PlanningParkedTag>
        get() {
            val key = current?.key ?: return emptyList()
            return runnable.dropWhile { it.key != key }.drop(1)
                .filter { it.key != "looseEnds" && it.key != "recap" }
                .map { PlanningParkedTag(it.key, it.title) }
        }

    val position: Int get() = current?.let { stepNumbers[it.key] } ?: 0

    /** The 2dp hair — position over total, as the web draws it. */
    val progress: Double get() = PlanningFormat.hairFraction(steps, current?.key)

    /** A week that has already finished cannot be planned. */
    val canGoBack: Boolean get() = view?.let { it.weekStart > it.minWeekStart } ?: false

    val hasNoRunnableSteps: Boolean get() = loaded && view != null && runnable.isEmpty()

    /**
     * A completed session is a receipt, checked before the paused screen. [askedStep]
     * overrides it, but only for a RUNNABLE step, or `resolveCurrent` dumps you on step 1.
     */
    val showsRecord: Boolean
        get() {
            if (session?.isCompleted != true) return false
            val asked = askedStep ?: return true
            return runnable.none { it.key == asked }
        }

    /** "Left for now": stepped out of THIS active session, with no step asked for since. */
    val isPaused: Boolean
        get() {
            val s = session ?: return false
            return s.isActive && pausedSessionId == s.id && askedStep == null
        }

    val decidedSteps: List<PlanningStep> get() = runnable.filter { it.isSettled }
    val settledCount: Int get() = decidedSteps.size
}

/**
 * The session shell's model — port of iOS `PlanningModel`. The web keeps "which step" in
 * the URL and "which week" in the query; here they are `askedStep`/`requestedWeek`, while
 * the session's `currentStep` stays the cross-DEVICE resume pointer.
 *
 * Takes its operations as functions so tests drive it without a server; the [PlanningApi]
 * constructor is what the app uses. Not thread-safe: call it from one dispatcher (Main).
 */
class PlanningModel(
    fetchView: suspend (weekStart: String?) -> WeeklyPlanningView,
    fetchConfig: suspend () -> WeeklyPlanningConfigView,
    saveConfig: suspend (PlanningConfigPatch) -> WeeklyPlanningConfig,
    startSession: suspend (weekStart: String?) -> PlanningSession,
    patchSession: suspend (id: String, currentStep: String?, status: String?) -> PlanningSession,
    decideStep: suspend (sessionId: String, stepKey: String, status: String, data: JsonObject?) -> List<PlanningStep>,
    completeSession: suspend (id: String) -> WeeklyPlanningCompletion,
    discardSession: suspend (id: String) -> Unit,
    resolveLooseEnd: suspend (kind: String, id: String, action: String, sessionId: String?) -> Unit,
    parkNote: suspend (note: String, stepKey: String?, sessionId: String?) -> Unit,
    /** Where "Leave for now" is remembered — THIS device only, and it survives the screen. */
    private val store: KeyValueStore,
) {
    private val fetchView = fetchView
    private val fetchConfig = fetchConfig
    private val saveConfigCall = saveConfig
    private val startSessionCall = startSession
    private val patchSessionCall = patchSession
    private val decideStepCall = decideStep
    private val completeSessionCall = completeSession
    private val discardSessionCall = discardSession
    private val resolveLooseEndCall = resolveLooseEnd
    private val parkNoteCall = parkNote

    constructor(api: PlanningApi, store: KeyValueStore) : this(
        fetchView = { api.view(it) },
        fetchConfig = { api.config() },
        saveConfig = { api.setConfig(it) },
        startSession = { api.startSession(it) },
        patchSession = { id, step, status -> api.patchSession(id, step, status) },
        decideStep = { s, k, st, d -> api.decideStep(s, k, st, d) },
        completeSession = { api.completeSession(it) },
        discardSession = { api.discardSession(it) },
        resolveLooseEnd = { kind, id, action, s -> api.resolveLooseEnd(kind, id, action, s) },
        parkNote = { note, key, s -> api.parkNote(note, key, s); Unit },
        store = store,
    )

    private val _state = MutableStateFlow(PlanningState(pausedSessionId = store.getString(PAUSED_KEY)))
    val state: StateFlow<PlanningState> = _state.asStateFlow()

    // The crumb and the step that set it, paired so "a crumb belongs to its step" is
    // structural. Persisted only when the step is answered.
    private var decisionData: JsonObject? = null
    private var decisionStepKey: String? = null

    // ---- loading ----

    /** Re-read the view. A failure keeps the last good view and still marks it loaded. */
    suspend fun load() {
        val week = _state.value.requestedWeek
        val latest = attempt { fetchView(week) }
        // A slower read of a week the stepper has since left must not pull it back.
        if (latest != null && week == _state.value.requestedWeek) apply(latest)
        _state.update { it.copy(loaded = true) }
    }

    private fun apply(latest: WeeklyPlanningView) {
        val numbers = PlanningFormat.availableSteps(latest.steps)
            .mapIndexed { i, s -> s.key to i + 1 }.toMap()
        val saved = latest.session?.takeIf { it.isCompleted }?.let { savedLabel(it.completedAt ?: it.startedAt) }
        _state.update {
            it.copy(
                view = latest,
                weekLabel = PlanningFormat.weekLabel(latest.weekStart),
                sessionDayName = PlanningFormat.planningDayName(latest.config.dayOfWeek),
                actGroups = PlanningFormat.stepsByAct(latest.steps),
                stepNumbers = numbers,
                savedAtLabel = saved,
            )
        }
    }

    /** The bare config plus the server-owned catalog. */
    suspend fun loadConfigCatalog(): WeeklyPlanningConfigView? = attempt { fetchConfig() }

    // ---- writes ----

    /** One write at a time, and ALWAYS refetch: the server's answer is what renders. */
    private suspend fun go(work: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        try {
            work()
        } catch (e: CancellationException) {
            _state.update { it.copy(busy = false) }
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(errorMessage = errorText(e, "That didn’t stick. Check your connection and try again.")) }
        }
        _state.update { it.copy(busy = false) }
        load()
    }

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    suspend fun start() {
        val week = _state.value.view?.weekStart
        go {
            val session = startSessionCall(week)
            setAsked(session.currentStep)
            // Pressing Start is being in the session; a pause for this id would bounce back.
            if (_state.value.pausedSessionId == session.id) writePaused(null)
        }
    }

    /** Answer the step on screen; with no next step, the answer IS the save. */
    suspend fun answer(status: String) {
        val s = _state.value
        val session = s.session ?: return
        val step = s.current ?: return
        val crumb = crumbForCurrentStep
        val following = PlanningFormat.nextStepAfter(s.steps, step.key)
        go {
            decideStepCall(session.id, step.key, status, crumb)
            clearCrumb()
            if (following != null) {
                patchSessionCall(session.id, following.key, null)
                setAsked(following.key)
            } else {
                completeSessionCall(session.id)
                setAsked(null)
                // Finished, so an old "not right now" is stale and would shadow the record.
                if (_state.value.pausedSessionId == session.id) writePaused(null)
            }
        }
    }

    /** Land on a step from the agenda, moving the pointer so another device follows. */
    suspend fun jump(key: String) {
        setAsked(key)
        val session = _state.value.session ?: return
        go { patchSessionCall(session.id, key, null) }
    }

    /** SHOW a step without moving the cross-device pointer — a recap row is only a link. */
    fun show(key: String) = setAsked(key)

    /** Reopen a saved session; only `status` is sent, so the pointer stays where it ended. */
    suspend fun reopen() {
        val session = _state.value.session ?: return
        go {
            val updated = patchSessionCall(session.id, null, "active")
            setAsked(updated.currentStep)
        }
    }

    suspend fun discard() {
        val session = _state.value.session ?: return
        go {
            discardSessionCall(session.id)
            setAsked(null)
            clearCrumb()
            writePaused(null)
        }
    }

    /** Move the stepper, dropping the step: it would name a step of a different record. */
    suspend fun goWeek(week: String) {
        val before = _state.value.requestedWeek
        clearCrumb()
        // Null when it IS the default, so the everyday case keeps following the calendar.
        val target = if (week == _state.value.view?.defaultWeekStart) null else week
        _state.update { it.copy(askedStep = null, requestedWeek = target) }
        load()
        // `load` keeps the last good view on failure, and here that view is another week.
        val view = _state.value.view
        if (view != null && _state.value.requestedWeek == target && view.weekStart != (target ?: view.defaultWeekStart)) {
            _state.update {
                it.copy(
                    requestedWeek = before,
                    errorMessage = "Couldn’t open that week. Check your connection and try again.",
                )
            }
        }
    }

    suspend fun goPreviousWeek() {
        val s = _state.value
        val view = s.view ?: return
        if (!s.canGoBack) return
        goWeek(PlanningFormat.addWeeks(view.weekStart, -1))
    }

    suspend fun goNextWeek() {
        val view = _state.value.view ?: return
        goWeek(PlanningFormat.addWeeks(view.weekStart, 1))
    }

    // ---- leaving, and coming back ----

    /**
     * "I've stepped out" — remembered on THIS DEVICE, not the server ("not right now" is
     * one person at one screen). The key holds a session id, so a stale value is inert.
     */
    fun leave() {
        val id = _state.value.session?.id ?: return
        setAsked(null)
        clearCrumb()
        writePaused(id)
    }

    fun resume() {
        writePaused(null)
        setAsked(_state.value.session?.currentStep)
    }

    private fun setAsked(key: String?) = _state.update { it.copy(askedStep = key) }

    private fun writePaused(id: String?) {
        _state.update { it.copy(pausedSessionId = id) }
        if (id != null) store.putString(PAUSED_KEY, id) else store.remove(PAUSED_KEY)
    }

    // ---- the step's crumb ----

    /** `PlanningStepProps.setDecisionData`. Held, never written on its own. */
    fun setDecisionData(data: JsonObject?) {
        decisionData = data
        decisionStepKey = if (data == null) null else _state.value.current?.key
    }

    /** The crumb, but only if the step that set it is still the step on screen. */
    val crumbForCurrentStep: JsonObject?
        get() {
            val key = _state.value.current?.key ?: return null
            return if (decisionStepKey == key) decisionData else null
        }

    private fun clearCrumb() {
        decisionData = null
        decisionStepKey = null
    }

    // ---- parked notes ----

    /** Park a note from the step on screen; true when the server took it. */
    suspend fun parkNote(note: String, stepKey: String?): Boolean {
        val sessionId = _state.value.session?.id ?: return false
        _state.update { it.copy(parkError = null) }
        return try {
            parkNoteCall(note, stepKey, sessionId)
            load()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(parkError = PARK_FAILED) }
            false
        }
    }

    /** From a summary screen: no session and no tag, so it waits for the next Loose ends. */
    suspend fun parkBetweenSessions(note: String): Boolean {
        _state.update { it.copy(parkError = null) }
        return try {
            parkNoteCall(note, null, null)
            _state.update { it.copy(parkedBetweenRevision = it.parkedBetweenRevision + 1) }
            load()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(parkError = PARK_FAILED) }
            false
        }
    }

    fun clearParkError() = _state.update { it.copy(parkError = null) }

    /** Settle one parked note; true when the server took it, so the banner can hide it. */
    suspend fun resolveParked(id: String, action: String): Boolean {
        val sessionId = _state.value.session?.id ?: return false
        return try {
            resolveLooseEndCall("parked", id, action, sessionId)
            load()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
    }

    // ---- config (Settings) ----

    /** Save ONLY what changed — see [PlanningConfigPatch]. */
    suspend fun saveConfig(patch: PlanningConfigPatch) = go { saveConfigCall(patch) }

    /** The lists step 1 could ask about — the server's rule, off the config read. */
    suspend fun loadListCandidates() {
        val view = attempt { fetchConfig() } ?: return
        _state.update { it.copy(listCandidates = view.lists.orEmpty()) }
    }

    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    companion object {
        const val PAUSED_KEY = "waffled.planning.pausedSession"
        private const val PARK_FAILED = "That note didn’t park — try again."

        /** "Sep 2, 5:32 PM", or the raw string: an unrecognised timestamp costs the prettiness. */
        fun savedLabel(iso: String, zone: ZoneId = ZoneId.systemDefault()): String {
            val instant = WaffledDates.parseInstant(iso, zone) ?: return iso
            return WaffledDates.format(instant, "MMM d, h:mm a", zone)
        }

        /** The server's own words when it sent some, else [fallback]. */
        fun errorText(e: Exception, fallback: String): String =
            (e as? WaffledApiException)?.userMessage ?: fallback
    }
}
