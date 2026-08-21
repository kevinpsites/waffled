package app.waffled.feature.goals

import androidx.compose.runtime.Immutable
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A check-and-set guard for rows that can only have one action in flight.
 *
 * Pulled out as its own type so the double-tap rule is testable without a network: the
 * whole point is that the SECOND call has to be refused *before* it can suspend, which is
 * impossible to assert once the check is buried inside a request.
 */
class BusyGuard {

    private val inFlight = ConcurrentHashMap.newKeySet<String>()
    private val _busy = MutableStateFlow(emptySet<String>())

    /** Ids with an action in flight — the view disables their buttons. */
    val busy: StateFlow<Set<String>> = _busy.asStateFlow()

    fun isBusy(id: String): Boolean = id in inFlight

    /** Claim [id]. Returns false when something is already running for it. */
    fun tryBegin(id: String): Boolean {
        val claimed = inFlight.add(id)
        if (claimed) _busy.value = inFlight.toSet()
        return claimed
    }

    fun end(id: String) {
        if (inFlight.remove(id)) _busy.value = inFlight.toSet()
    }

    /** Run [block] only if [id] is free, releasing it however [block] ends. */
    suspend fun <T> withClaim(id: String, block: suspend () -> T): T? {
        if (!tryBegin(id)) return null
        return try {
            block()
        } finally {
            end(id)
        }
    }
}

/**
 * The Today → "Review events" queues — the port of the iOS `ReviewEventsModel`.
 *
 * Two queues from the goal↔calendar bridge:
 *  - **Confirmed**: events the household already agreed tie to a goal, now ended.
 *    Confirming logs progress (editable amount + who); skipping clears it.
 *  - **Suggested**: untagged events the matcher thinks might count. Link, or dismiss.
 *
 * Every write is **idempotent on (event, occurrence, goal)** server-side. The client's
 * contribution to that is [BusyGuard]: a double-tap can't issue a second request, so a
 * replay only ever happens on a genuine retry, where the server's dedupe takes over.
 */
class ReviewEventsModel(
    val api: GoalsApi,
    private val refreshBus: RefreshBus? = null,
) {

    /** A recap row's editable draft: how much to log, and to whom. */
    @Immutable
    data class Draft(val amount: Double, val people: List<String>)

    @Immutable
    data class State(
        val recap: List<GoalsApi.GoalRecapItem> = emptyList(),
        val suggestions: List<GoalsApi.GoalSuggestionItem> = emptyList(),
        val drafts: Map<String, Draft> = emptyMap(),
        val loading: Boolean = true,
        val error: Boolean = false,
    ) {
        val isEmpty: Boolean get() = recap.isEmpty() && suggestions.isEmpty()

        /** The Today banner's headline for these two queues. */
        val headline: String get() = reviewRecapTitle(recap.size, suggestions.size)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val guard = BusyGuard()
    val busy: StateFlow<Set<String>> = guard.busy

    val current: State get() = _state.value

    fun isBusy(id: String): Boolean = guard.isBusy(id)

    /**
     * Load both queues in parallel.
     *
     * Existing drafts are KEPT: a refresh that arrives while someone is adjusting an
     * amount must not throw away what they typed.
     */
    suspend fun load() {
        _state.value = _state.value.copy(loading = true)
        val fetched = runCatching {
            coroutineScope {
                val recap = async { api.recap() }
                val suggestions = async { api.suggestions() }
                recap.await() to suggestions.await()
            }
        }

        val loaded = fetched.getOrNull()
        if (loaded == null) {
            _state.value = _state.value.copy(loading = false, error = true)
            return
        }
        val (recap, suggestions) = loaded
        val drafts = _state.value.drafts.toMutableMap()
        for (item in recap) {
            drafts.getOrPut(item.id) { Draft(item.suggestedAmount, item.defaultPersonIds) }
        }
        _state.value = State(
            recap = recap,
            suggestions = suggestions,
            // Drop drafts for rows that are gone, so the map can't grow forever.
            drafts = drafts.filterKeys { key -> recap.any { it.id == key } },
            loading = false,
            error = false,
        )
    }

    fun draft(item: GoalsApi.GoalRecapItem): Draft =
        _state.value.drafts[item.id] ?: Draft(item.suggestedAmount, item.defaultPersonIds)

    /** Negative progress makes no sense on a recap stepper, so the amount floors at zero. */
    fun setAmount(item: GoalsApi.GoalRecapItem, amount: Double) {
        putDraft(item, draft(item).copy(amount = maxOf(0.0, amount)))
    }

    fun setPeople(item: GoalsApi.GoalRecapItem, people: List<String>) {
        putDraft(item, draft(item).copy(people = people))
    }

    private fun putDraft(item: GoalsApi.GoalRecapItem, draft: Draft) {
        _state.value = _state.value.copy(drafts = _state.value.drafts + (item.id to draft))
    }

    /** A habit or checklist confirm has no amount to edit — it ticks, or it counts once. */
    fun canConfirm(item: GoalsApi.GoalRecapItem): Boolean =
        !item.isAmountBased || draft(item).amount > 0

    suspend fun confirm(item: GoalsApi.GoalRecapItem) {
        val d = draft(item)
        act(item.id) {
            api.confirmRecap(
                eventId = item.eventId,
                occurrenceDate = item.occurrenceDate,
                // A checklist tick or a habit day is one event, not an amount.
                amount = if (item.isAmountBased) d.amount else 1.0,
                personIds = d.people,
            )
            dropRecap(item.id)
        }
    }

    suspend fun skip(item: GoalsApi.GoalRecapItem) = act(item.id) {
        api.skipRecap(item.eventId, item.occurrenceDate)
        dropRecap(item.id)
    }

    suspend fun link(item: GoalsApi.GoalSuggestionItem) = act(item.id) {
        api.linkSuggestion(item.eventId, item.goalId)
        dropSuggestion(item.id)
    }

    /**
     * Dismiss a suggestion for good. Unlike the other three this does NOT bump the goals
     * domain — nothing about any goal changed, only what we stop being asked about.
     */
    suspend fun dismiss(item: GoalsApi.GoalSuggestionItem) {
        guard.withClaim(item.id) {
            val done = runCatching { api.dismissSuggestion(item.eventId) }
            if (done.isFailure) {
                _state.value = _state.value.copy(error = true)
            } else {
                dropSuggestion(item.id)
            }
        }
    }

    private suspend fun act(id: String, block: suspend () -> Unit) {
        guard.withClaim(id) {
            val done = runCatching { block() }
            if (done.isFailure) {
                _state.value = _state.value.copy(error = true)
            } else {
                refreshBus?.bump(RefreshDomain.Goals)
            }
        }
    }

    private fun dropRecap(id: String) {
        _state.value = _state.value.copy(
            recap = _state.value.recap.filterNot { it.id == id },
            drafts = _state.value.drafts - id,
        )
    }

    private fun dropSuggestion(id: String) {
        _state.value = _state.value.copy(suggestions = _state.value.suggestions.filterNot { it.id == id })
    }

    fun dismissError() {
        _state.value = _state.value.copy(error = false)
    }
}
