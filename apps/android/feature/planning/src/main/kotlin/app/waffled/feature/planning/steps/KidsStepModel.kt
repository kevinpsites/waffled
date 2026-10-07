package app.waffled.feature.planning.steps

import androidx.compose.runtime.Immutable
import app.waffled.feature.planning.api.PlanningKidCard
import app.waffled.feature.planning.api.PlanningKidPick
import app.waffled.feature.planning.api.PlanningKidsApi
import app.waffled.feature.planning.api.PlanningKidsChoice
import app.waffled.feature.planning.api.PlanningKidsCrumb
import app.waffled.feature.planning.api.PlanningKidsView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject

enum class KidsQuestion(val wire: String) { Focus("focus"), Forward("forward") }

data class KidsTypeTarget(val personId: String, val which: KidsQuestion)

@Immutable
data class KidsStepState(
    val view: PlanningKidsView? = null,
    /** Set even by a FAILED fetch, which keeps the previous [view]. */
    val loaded: Boolean = false,
    /** One write at a time: two answers together would race the same session crumb. */
    val saving: String? = null,
    val errorMessage: String? = null,
    val activePersonId: String? = null,
    val changing: Boolean = false,
    val typing: KidsTypeTarget? = null,
    /** Bumped when a read or write lands, so the body pushes the crumb once. */
    val rev: Int = 0,
    /**
     * What they typed but never saved, keyed `<personId>:<which>`. Not an answer, so it
     * stays out of [view] and lives only while the step is on screen.
     */
    val drafts: Map<String, String> = emptyMap(),
) {
    val kids: List<PlanningKidCard> get() = view?.kids.orEmpty()
    val canRepeat: Boolean get() = view?.canRepeat ?: false
    val activeCard: PlanningKidCard? get() = kids.firstOrNull { it.personId == activePersonId } ?: kids.firstOrNull()
    val isReadBack: Boolean get() = !changing && kids.isNotEmpty() && kids.all { it.settled }

    fun isFrozen(shellBusy: Boolean): Boolean = shellBusy || saving != null

    /** NULL UNTIL A READ HAS LANDED: the shell replaces the step's data with whatever it gets. */
    val crumb: JsonObject? get() = view?.let { PlanningKidsCrumb.decision(it) }

    val heading: String
        get() {
            val names = kids.map { it.name }
            if (names.size <= 1) return names.firstOrNull() ?: "Kids"
            return names.dropLast(1).joinToString(", ") + " and " + names.last()
        }
}

/**
 * Step 9's state, no view in it — port of iOS `PlanningKidsStepModel`. The answers are a
 * REAL write, never `setDecisionData`; the crumb only mirrors what the server stored.
 */
class PlanningKidsStepModel(
    private val fetchKids: suspend (sessionId: String, weekStart: String?) -> PlanningKidsView,
    private val answerKid: suspend (
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick,
        forward: PlanningKidPick,
    ) -> PlanningKidsView,
    private val repeatAnswers: suspend (sessionId: String, weekStart: String?) -> PlanningKidsView,
) {
    constructor(api: PlanningKidsApi) : this(
        fetchKids = { s, w -> api.kids(s, w) },
        answerKid = { s, p, w, f, fw -> api.answer(s, p, w, f, fw) },
        repeatAnswers = { s, w -> api.repeat(s, w) },
    )

    private val _state = MutableStateFlow(KidsStepState())
    val state: StateFlow<KidsStepState> = _state.asStateFlow()

    suspend fun load(sessionId: String, weekStart: String?) {
        val latest = attempt { fetchKids(sessionId, weekStart) }
        if (latest != null) apply(latest)
        _state.update { it.copy(loaded = true) }
    }

    fun select(personId: String) {
        if (_state.value.kids.none { it.personId == personId }) return
        _state.update { it.copy(activePersonId = personId) }
    }

    fun beginChanging() = _state.update { it.copy(changing = true) }

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    fun beginTyping(personId: String, which: KidsQuestion) =
        _state.update { it.copy(typing = KidsTypeTarget(personId, which)) }

    fun cancelTyping() = _state.update { it.copy(typing = null) }

    fun isTyping(personId: String, which: KidsQuestion): Boolean =
        _state.value.typing == KidsTypeTarget(personId, which)

    fun recordDraft(personId: String, which: KidsQuestion, text: String) =
        _state.update { it.copy(drafts = it.drafts + (draftKey(personId, which) to text)) }

    /** The unsaved draft wins, then their own saved custom answer — never an empty box. */
    fun typeInSeed(card: PlanningKidCard, which: KidsQuestion): String {
        _state.value.drafts[draftKey(card.personId, which)]?.let { return it }
        return when (which) {
            KidsQuestion.Focus -> if (PlanningKidsChoice.focusIsCustom(card)) card.focus?.label.orEmpty() else ""
            KidsQuestion.Forward -> if (PlanningKidsChoice.forwardIsCustom(card)) card.forward?.label.orEmpty() else ""
        }
    }

    /** The other question defaults to [PlanningKidPick.Absent] — half an answer must not erase the other half. */
    suspend fun answer(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick = PlanningKidPick.Absent,
        forward: PlanningKidPick = PlanningKidPick.Absent,
    ) {
        if (_state.value.saving != null) return
        _state.update { it.copy(saving = personId, errorMessage = null, typing = null) }
        val latest = attempt { answerKid(sessionId, personId, weekStart, focus, forward) }
        if (latest != null) {
            apply(latest)
            _state.update { it.copy(changing = false, saving = null) }
        } else {
            _state.update { it.copy(errorMessage = "That didn’t take — try again.", saving = null) }
        }
    }

    suspend fun repeatLastWeek(sessionId: String, weekStart: String?) {
        val s = _state.value
        if (s.saving != null || !s.canRepeat) return
        _state.update { it.copy(saving = REPEAT_TOKEN, errorMessage = null) }
        val latest = attempt { repeatAnswers(sessionId, weekStart) }
        if (latest != null) {
            apply(latest)
            _state.update { it.copy(changing = false, saving = null) }
        } else {
            _state.update { it.copy(errorMessage = "Couldn’t copy last week — pick this week’s instead.", saving = null) }
        }
    }

    private fun apply(latest: PlanningKidsView) {
        _state.update { s ->
            val keep = s.activePersonId?.takeIf { id -> latest.kids.any { it.personId == id } }
            s.copy(view = latest, rev = s.rev + 1, activePersonId = keep ?: latest.kids.firstOrNull()?.personId)
        }
    }

    private suspend fun <T> attempt(work: suspend () -> T): T? = try {
        work()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    companion object {
        const val REPEAT_TOKEN = "repeat"
        fun draftKey(personId: String, which: KidsQuestion) = "$personId:${which.wire}"
    }
}
