package app.waffled.feature.planning.steps

import androidx.compose.runtime.Immutable
import app.waffled.core.network.WaffledJson
import app.waffled.feature.planning.PlanningModel
import app.waffled.feature.planning.PlanningRouteSeed
import app.waffled.feature.planning.api.LooseEnd
import app.waffled.feature.planning.api.LooseEndDestination
import app.waffled.feature.planning.api.LooseEndRoute
import app.waffled.feature.planning.api.LooseEndsView
import app.waffled.feature.planning.api.PlanningApi
import app.waffled.feature.planning.api.PlanningConfigPatch
import app.waffled.feature.planning.api.PlanningListCandidate
import app.waffled.feature.planning.api.PlanningLooseEndsApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Weekly Planning · step 1 "Loose ends" — the step's state, copy and choice table. Port of
// iOS `LooseEndsModel.swift`. Only three things write: "done", "drop" and the capture bar.
// Routing records a destination on the session; "leave it" writes nothing at all.

/** "Not done" is computed from the modules; "Parked" exists nowhere else, so it can be dropped. */
enum class LooseEndGroup(val wire: String) {
    NotDone("notDone"),
    Parked("parked");

    val label: String get() = if (this == NotDone) "Not done" else "Parked"

    val caption: String get() = if (this == NotDone) "already in the app" else "somebody wrote it down"

    val note: String
        get() = if (this == NotDone) {
            "Computed from your modules — overdue chores, unchecked items on your lists, rhythms past due. Nobody typed these; they are simply still open."
        } else {
            "What somebody wrote down during the week that exists nowhere else yet. Which is why one of the answers here is to drop it."
        }

    val other: LooseEndGroup get() = if (this == NotDone) Parked else NotDone
}

object LooseEndCopy {
    /** Kinds are server-owned: an unknown one is shown by its own name, never hidden. */
    fun kindLabel(kind: String): String = when (kind) {
        "chore" -> "Chore"
        "list" -> "List"
        "rhythm" -> "Rhythm"
        "parked" -> "Parked"
        else -> kind.replaceFirstChar { it.uppercase() }
    }

    fun actionLabel(action: String, kind: String): String =
        if (action == "done") (if (kind == "parked") "Talk about it now" else "It’s done already") else "Drop it"

    fun actionHint(action: String, kind: String): String =
        if (action == "done") (if (kind == "parked") "Two minutes, then decide" else "Just tell its module") else "It was never really a thing"

    fun leaveLabel(group: LooseEndGroup): String = if (group == LooseEndGroup.Parked) "Keep it parked" else "Leave it open"

    fun leaveHint(group: LooseEndGroup): String = if (group == LooseEndGroup.Parked) "It isn’t time yet" else "Nothing changes anywhere"

    const val DISCLAIMER = "Routing here changes nothing in your modules — it only decides which step handles it."
    const val TRAIL_CAPTION = "Sent ahead — they’ll come up at that step later tonight"
    const val CAPTURE_PLACEHOLDER = "Drop something new on the board — one line is enough"
    const val WRITE_FAILED = "That didn’t go through — try again."

    fun clearedTitle(group: LooseEndGroup): String =
        if (group == LooseEndGroup.Parked) "Nothing’s parked" else "Nothing’s left undone"

    /** Names what was looked at — "nothing's left" from a step that never said where it looked is only a claim. */
    fun clearedSubtitle(group: LooseEndGroup, sources: List<String>, remainingOther: Int): String {
        val head = if (group == LooseEndGroup.Parked) {
            "Nobody wrote anything down this week that lives nowhere else yet."
        } else {
            "We checked your ${if (sources.isEmpty()) "modules" else sources.joinToString(", ")}."
        }
        if (remainingOther <= 0) return "$head Both groups are clear."
        val noun = if (group.other == LooseEndGroup.Parked) {
            if (remainingOther == 1) "parked note is" else "parked notes are"
        } else {
            if (remainingOther == 1) "loose end is" else "loose ends are"
        }
        return "$head $remainingOther $noun still waiting."
    }
}

/** One choice on a card, as data so the arrangement is testable without a view. */
@Immutable
data class LooseEndChoice(
    val key: String,
    val label: String,
    val hint: String,
    val isPrimary: Boolean,
    val act: Act,
) {
    sealed interface Act {
        /** Send it to the step that will handle it. Writes nothing to any module. */
        data class Route(val to: String) : Act
        /** "It's done already" / "Drop it" — the two answers that write. */
        data class Settle(val action: String) : Act
        /** Set aside for this screen only. */
        data object Leave : Act
    }

    data class Built(val choices: List<LooseEndChoice>, val quiet: List<LooseEndChoice>)

    companion object {
        /** A note's "talk about it now" and "keep it parked" are ordinary choices; elsewhere they stay quiet. */
        fun build(item: LooseEnd, group: LooseEndGroup, destinations: List<LooseEndDestination>): Built {
            val choices = destinations.mapTo(mutableListOf()) {
                LooseEndChoice("to:${it.to}", it.label, it.hint, it.primary == true, Act.Route(it.to))
            }
            val quiet = mutableListOf<LooseEndChoice>()
            for (a in item.actions) {
                val c = LooseEndChoice(
                    "do:$a",
                    LooseEndCopy.actionLabel(a, item.kind),
                    LooseEndCopy.actionHint(a, item.kind),
                    false,
                    Act.Settle(a),
                )
                if (group == LooseEndGroup.Parked && a == "done") choices += c else quiet += c
            }
            val leave = LooseEndChoice("leave", LooseEndCopy.leaveLabel(group), LooseEndCopy.leaveHint(group), false, Act.Leave)
            if (group == LooseEndGroup.Parked) choices += leave else quiet.add(0, leave)
            return Built(choices, quiet)
        }
    }
}

@Immutable
data class LooseEndsState(
    val view: LooseEndsView? = null,
    /** Set even by a FAILED fetch, which keeps the previous [view]. */
    val loaded: Boolean = false,
    /** Routed this session; seeded from the read so a reload doesn't re-ask what was triaged. */
    val routes: List<LooseEndRoute> = emptyList(),
    /** Items SETTLED here ("done"/"drop"). */
    val answered: Int = 0,
    val working: Boolean = false,
    val errorMessage: String? = null,
    val openNotDone: List<LooseEnd> = emptyList(),
    val openParked: List<LooseEnd> = emptyList(),
    val totalNotDone: Int = 0,
    val totalParked: Int = 0,
) {
    fun open(group: LooseEndGroup): List<LooseEnd> = if (group == LooseEndGroup.NotDone) openNotDone else openParked

    fun remaining(group: LooseEndGroup): Int = open(group).size

    /** The denominator of "3 of 7": everything seen this sitting, before triage. */
    fun total(group: LooseEndGroup): Int = if (group == LooseEndGroup.NotDone) totalNotDone else totalParked

    fun destinations(group: LooseEndGroup): List<LooseEndDestination> {
        val d = view?.destinations ?: return emptyList()
        return if (group == LooseEndGroup.NotDone) d.notDone else d.parked
    }

    /** Most recent first. */
    val trail: List<LooseEndRoute> get() = routes.asReversed()

    /**
     * Step NAMES for the trail: "Parked"'s labels are verbs ("Make it a task"), which read
     * wrong after an arrow — so the step title, then the notDone label, then the raw key.
     */
    fun stepName(to: String): String {
        val d = view?.destinations
        val all = d?.notDone.orEmpty() + d?.parked.orEmpty()
        return all.firstOrNull { it.to == to && it.stepTitle != null }?.stepTitle
            ?: d?.notDone?.firstOrNull { it.to == to }?.label
            ?: to
    }

    /** Empty is a real answer, and so is a server that predates the setting. */
    val listCandidates: List<PlanningListCandidate> get() = view?.lists.orEmpty()

    /**
     * The crumb carries `routes` because answering a step REPLACES its data server-side, and
     * `data.routes` is the array later steps read. Bare counts would wipe it.
     */
    val decisionData: JsonObject
        get() = JsonObject(
            mapOf(
                "routes" to JsonArray(routes.map { WaffledJson.encodeToJsonElement(LooseEndRoute.serializer(), it) }),
                "answered" to JsonPrimitive(answered),
                "left" to JsonPrimitive(openNotDone.size + openParked.size),
            ),
        )
}

/**
 * Takes its operations as functions so tests drive it without a server; [from] builds the
 * real one. Not thread-safe: call it from one dispatcher (Main).
 */
class PlanningLooseEndsModel(
    private val fetchLooseEnds: suspend (weekStart: String, sessionId: String) -> LooseEndsView,
    /** `to == null` UNDOES the routing. Returns the whole array back. */
    private val routeLooseEnd: suspend (sessionId: String, kind: String, id: String, title: String, source: String, to: String?) -> List<LooseEndRoute>,
    private val resolveLooseEnd: suspend (kind: String, id: String, action: String, sessionId: String) -> Unit,
    /** One list per call: the server merges, so a whole map would rule lists back in behind another device. */
    ruleList: suspend (listId: String, relevant: Boolean) -> Unit,
    private val parkNote: suspend (note: String, sessionId: String) -> Unit,
) {
    private val ruleListCall = ruleList
    private val _state = MutableStateFlow(LooseEndsState())
    val state: StateFlow<LooseEndsState> = _state.asStateFlow()

    // Client-only: "leave it" writes nothing anywhere, so it must not become a row.
    private val setAside = mutableSetOf<String>()
    // Answered this sitting; the module may still report one, and it must not bounce back.
    private val settled = mutableSetOf<String>()
    // First-seen order per group, so a re-read can't reshuffle the deck or shrink "2 of 3".
    private val order = mutableMapOf<LooseEndGroup, MutableList<String>>()

    suspend fun load(weekStart: String, sessionId: String) {
        attempt { fetchLooseEnds(weekStart, sessionId) }?.let { next ->
            _state.update { it.copy(view = next, routes = next.routes) }
        }
        _state.update { it.copy(loaded = true) }
        recompute()
    }

    /**
     * Seed from the step's OWN `data.routes` before the read lands. Load-bearing: the crumb
     * replaces the row's data on answer, so a fresh model whose read failed would otherwise
     * push an empty list over every earlier routing decision. A read that came back wins.
     */
    fun seedRoutes(value: JsonElement?) {
        if (_state.value.routes.isNotEmpty() || value !is JsonArray) return
        val seeded = PlanningRouteSeed.decode(value)
        if (seeded.isEmpty()) return
        _state.update { it.copy(routes = seeded) }
        recompute()
    }

    /** A different week is a different set of loose ends. */
    fun resetForWeek() {
        setAside.clear()
        settled.clear()
        order.clear()
        _state.update { it.copy(answered = 0) }
        recompute()
    }

    suspend fun send(item: LooseEnd, from: LooseEndGroup, to: String, sessionId: String): Boolean = guarded {
        val routes = routeLooseEnd(sessionId, item.kind, item.id, item.title, from.wire, to)
        _state.update { it.copy(routes = routes) }
    }

    suspend fun undo(route: LooseEndRoute, sessionId: String): Boolean = guarded {
        val routes = routeLooseEnd(sessionId, route.kind, route.id, route.title, route.source, null)
        _state.update { it.copy(routes = routes) }
    }

    /** The item's own module decides whether it is still open, so this re-reads. */
    suspend fun settle(item: LooseEnd, action: String, weekStart: String, sessionId: String): Boolean = guarded {
        resolveLooseEnd(item.kind, item.id, action, sessionId)
        _state.update { it.copy(answered = it.answered + 1) }
        settled += item.key
        reload(weekStart, sessionId)
    }

    suspend fun park(note: String, weekStart: String, sessionId: String): Boolean {
        val text = note.trim()
        if (text.isEmpty()) return false
        return guarded {
            parkNote(text, sessionId)
            reload(weekStart, sessionId)
        }
    }

    /** Then re-read: which cards a ruled-out list takes with it is the server's call. */
    suspend fun ruleList(listId: String, relevant: Boolean, weekStart: String, sessionId: String): Boolean = guarded {
        ruleListCall(listId, relevant)
        reload(weekStart, sessionId)
        forgetCardsNoLongerAsked()
    }

    fun leave(item: LooseEnd) {
        setAside += item.key
        _state.update { it.copy(errorMessage = null) }
        recompute()
    }

    fun clearError() = _state.update { it.copy(errorMessage = null) }

    /** Ruling a list out is not an answer: its cards leave the count, answered ones stay. */
    private fun forgetCardsNoLongerAsked() {
        val view = _state.value.view
        val live = (view?.notDone.orEmpty() + view?.parked.orEmpty()).mapTo(HashSet()) { it.key }
        for (keys in order.values) keys.retainAll { it in live || it in settled }
    }

    /** Keeps what it has on failure, so a write that succeeded never reads as failed. */
    private suspend fun reload(weekStart: String, sessionId: String) {
        attempt { fetchLooseEnds(weekStart, sessionId) }?.let { next ->
            _state.update { it.copy(view = next, routes = next.routes) }
        }
    }

    /** One write at a time; a failure leaves every piece of state as it was. */
    private suspend fun guarded(operation: suspend () -> Unit): Boolean {
        if (_state.value.working) return false
        _state.update { it.copy(working = true, errorMessage = null) }
        val ok = try {
            operation()
            true
        } catch (e: CancellationException) {
            _state.update { it.copy(working = false) }
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(errorMessage = PlanningModel.errorText(e, LooseEndCopy.WRITE_FAILED)) }
            false
        }
        _state.update { it.copy(working = false) }
        recompute()
        return ok
    }

    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    private fun remember(group: LooseEndGroup, items: List<LooseEnd>) {
        val known = order.getOrPut(group) { mutableListOf() }
        for (item in items) if (item.key !in known) known += item.key
    }

    /** First-seen order; a card not seen yet goes last, in the server's order (sortedBy is stable). */
    private fun ordered(group: LooseEndGroup, items: List<LooseEnd>): List<LooseEnd> {
        val known = order[group].orEmpty()
        return items.sortedBy { known.indexOf(it.key).let { i -> if (i < 0) Int.MAX_VALUE else i } }
    }

    private fun recompute() {
        val s = _state.value
        val notDone = s.view?.notDone.orEmpty()
        val parked = s.view?.parked.orEmpty()
        remember(LooseEndGroup.NotDone, notDone)
        remember(LooseEndGroup.Parked, parked)
        val hidden = s.routes.mapTo(HashSet()) { "${it.kind}:${it.id}" } + setAside + settled
        _state.update {
            it.copy(
                openNotDone = ordered(LooseEndGroup.NotDone, notDone.filter { e -> e.key !in hidden }),
                openParked = ordered(LooseEndGroup.Parked, parked.filter { e -> e.key !in hidden }),
                totalNotDone = maxOf(order[LooseEndGroup.NotDone]?.size ?: 0, notDone.size),
                totalParked = maxOf(order[LooseEndGroup.Parked]?.size ?: 0, parked.size),
            )
        }
    }

    companion object {
        fun from(api: PlanningLooseEndsApi, shell: PlanningApi) = PlanningLooseEndsModel(
            fetchLooseEnds = { week, session -> api.looseEnds(week, session) },
            routeLooseEnd = { session, kind, id, title, source, to -> api.route(session, kind, id, title, source, to) },
            resolveLooseEnd = { kind, id, action, session -> api.resolve(kind, id, action, session) },
            ruleList = { id, relevant -> shell.setConfig(PlanningConfigPatch(lists = mapOf(id to relevant))) },
            parkNote = { note, session -> shell.parkNote(note, sessionId = session) },
        )
    }
}
