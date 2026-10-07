package app.waffled.feature.planning.steps

import androidx.compose.runtime.Immutable
import app.waffled.feature.planning.api.PlanningConnectionApi
import app.waffled.feature.planning.api.PlanningConnectionBoard
import app.waffled.feature.planning.api.PlanningConnectionEvent
import app.waffled.feature.planning.api.PlanningConnectionPairing
import app.waffled.feature.planning.api.PlanningConnectionSlot
import app.waffled.feature.planning.api.PlanningConnectionSlots
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

// Weekly Planning · step 5 "Connection". Port of iOS `ConnectionStepModel.swift`. Every
// string a row shows is composed by the SERVER or by a pure function here; nothing parses
// a household-local timestamp.

object PlanningConnectionCopy {
    /** Rows the board draws — a LAYOUT cap; the server ranks every pairing. */
    const val ROWS = 3
    const val SLOTS_PER_ROW = 2

    /** What a just-made pairing added, since the bar that made it closes. */
    fun madeNote(names: List<String>): String {
        val last = names.lastOrNull() ?: return "Added to the calendar"
        val who = if (names.size > 1) "${names.dropLast(1).joinToString(", ")} and $last" else last
        return "Added to the calendar — $who"
    }

    /** "Link a time"'s candidates, needing no new read. */
    fun bothOnIt(p: PlanningConnectionPairing): List<PlanningConnectionEvent> = p.alreadyThisWeek + p.togetherThisWeek

    /**
     * Which pairings to draw, IN THE SERVER'S ORDER. The ranking reads only history before the
     * planned week, so a bare take(3) hides a pairing you just gave time to: credited ones
     * claim places first, the rest go to the best-ranked. Filtered, never re-grouped.
     */
    fun visible(pairings: List<PlanningConnectionPairing>): List<PlanningConnectionPairing> {
        val keep = pairings.filter { it.alreadyThisWeek.isNotEmpty() }.mapTo(HashSet()) { it.key }
        var guesses = maxOf(0, ROWS - keep.size)
        for (p in pairings) {
            if (guesses <= 0) break
            if (keep.add(p.key)) guesses -= 1
        }
        return pairings.filter { it.key in keep }
    }

    fun durationWords(minutes: Int): String {
        if (minutes % 60 != 0) return "$minutes minutes"
        val h = minutes / 60
        return "$h ${if (h == 1) "hour" else "hours"}"
    }

    private val monthDayOut = DateTimeFormatter.ofPattern("MMM d", Locale.US)

    /** "Aug 8" off a calendar label already resolved in the household's zone — no instant involved. */
    fun monthDay(iso: String): String = runCatching { LocalDate.parse(iso).format(monthDayOut) }.getOrDefault(iso)

    /**
     * The line under a pairing's name: time that already exists first, then how long it has
     * been plus the near miss. A LINKED event is looked up across both lists, or the sentence
     * and the chip could name different events.
     */
    fun sentence(p: PlanningConnectionPairing, linkedId: String?): String {
        if (linkedId != null) {
            bothOnIt(p).firstOrNull { it.id == linkedId }?.let { linked ->
                return "Nothing new — ${linked.day}’s ${linked.title} already is it, and you said so out loud."
            }
        }
        p.alreadyThisWeek.firstOrNull()?.let { credit ->
            val len = credit.minutes?.let { " for ${durationWords(it)}" }.orEmpty()
            return "${credit.day}’s ${credit.title} is the two of you$len — that may already be it."
        }
        val since = p.lastTogetherOn?.let { " since ${monthDay(it)}" }.orEmpty()
        val lead = "Nothing on the calendar with just the two of you$since."
        val near = p.togetherThisWeek
        return when {
            near.size == 1 -> "$lead ${near[0].day}’s ${near[0].title} is you both, but it’s not that."
            near.size > 1 -> "$lead You’re both at ${near.size} things this week, but none of them is that."
            else -> lead
        }
    }

    /** Credited evenings on the WHOLE board — what the catch-up ladder watches. */
    fun credited(board: PlanningConnectionBoard?): Int = board?.pairings.orEmpty().sumOf { it.alreadyThisWeek.size }
}

/** One pairing, resolved once per board or link change rather than per render. */
@Immutable
data class PlanningConnectionRow(
    /** The key `PUT /links` is keyed by. */
    val key: String,
    val personIds: List<String>,
    val who: String,
    val sentence: String,
    val candidates: List<PlanningConnectionEvent>,
    /** The event somebody ACTUALLY PICKED — not "the first credited one". */
    val answer: PlanningConnectionEvent?,
    /** What one chip can honestly stand for: the answer, else the ONE obvious candidate. */
    val oneTap: PlanningConnectionEvent?,
    /** Exactly one chip on a row ever reads as chosen. */
    val oneTapChosen: Boolean,
    val showPicker: Boolean,
    val slots: List<PlanningConnectionSlot>,
) {
    companion object {
        fun of(p: PlanningConnectionPairing, linkedId: String?): PlanningConnectionRow {
            val candidates = PlanningConnectionCopy.bothOnIt(p)
            val answer = linkedId?.let { id -> candidates.firstOrNull { it.id == id } }
            val tap = answer ?: candidates.singleOrNull()
            return PlanningConnectionRow(
                key = p.key,
                personIds = p.personIds,
                who = p.who,
                sentence = PlanningConnectionCopy.sentence(p, linkedId),
                candidates = candidates,
                answer = answer,
                oneTap = tap,
                oneTapChosen = answer != null,
                showPicker = candidates.size > (if (tap == null) 0 else 1),
                slots = p.slots.take(PlanningConnectionCopy.SLOTS_PER_ROW),
            )
        }
    }
}

@Immutable
data class ConnectionState(
    val board: PlanningConnectionBoard? = null,
    val rows: List<PlanningConnectionRow> = emptyList(),
    /** Set even by a failed fetch, which keeps the previous board. */
    val loaded: Boolean = false,
    /** The last read failed: drives the banner, never blanks a board we have. */
    val failed: Boolean = false,
    /** Pairing key → the event that answers it. */
    val links: Map<String, String> = emptyMap(),
    val added: Int = 0,
    /** Bumped on every save so the pairing bar is rebuilt empty. */
    val madeGeneration: Int = 0,
    val madeNote: String? = null,
) {
    /** `links` is written back because answering the step REPLACES its row's data. */
    val decisionData: JsonObject
        get() = JsonObject(
            mapOf(
                "added" to JsonPrimitive(added),
                "alreadyCounted" to JsonPrimitive(links.size),
                "links" to JsonObject(links.mapValues { JsonPrimitive(it.value) }),
            ),
        )
}

class PlanningConnectionModel(
    private val fetchBoard: suspend (weekStart: String) -> PlanningConnectionBoard,
    private val fetchSlots: suspend (weekStart: String, personIds: List<String>) -> PlanningConnectionSlots,
    private val saveLinks: suspend (sessionId: String, links: Map<String, String>) -> Unit,
    /** The ladder's pause, injected so tests don't sit through seven real seconds. */
    private val wait: suspend (Duration) -> Unit = { delay(it) },
) {
    private val _state = MutableStateFlow(ConnectionState())
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private var seededWeek: String? = null

    /**
     * Seed from the step's own `data.links` before the read lands. Keyed on the WEEK too: the
     * keys are person-id joins identical across weeks, so without it week B would show (and
     * then write back) week A's answers.
     */
    fun seedLinks(value: JsonElement?, weekStart: String) {
        if (seededWeek != weekStart) {
            seededWeek = weekStart
            setLinks(emptyMap())
        }
        if (_state.value.links.isNotEmpty() || value !is JsonObject) return
        val seeded = value.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.let { k to it.content } }.toMap()
        if (seeded.isNotEmpty()) setLinks(seeded)
    }

    suspend fun load(weekStart: String) {
        val next = attempt { fetchBoard(weekStart) }
        _state.update { if (next != null) it.copy(board = next, failed = false, loaded = true) else it.copy(failed = true, loaded = true) }
        rebuild()
    }

    /** Null when the server refuses, which the caller renders as "no slots", not an error. */
    suspend fun slots(weekStart: String, personIds: List<String>): PlanningConnectionSlots? =
        attempt { fetchSlots(weekStart, personIds) }

    /** A POINTER; re-picking the linked event unlinks it. A failed write costs the link, not the sitting. */
    suspend fun link(key: String, eventId: String?, sessionId: String) {
        val next = _state.value.links.toMutableMap()
        if (eventId == null || next[key] == eventId) next.remove(key) else next[key] = eventId
        setLinks(next)
        attempt { saveLinks(sessionId, next) }
    }

    /**
     * An event was really created: re-read until the board agrees, then link what appeared.
     * [participantIds] is what the composer opened with, in household order, so a pairing
     * built from scratch matches no row and links nothing.
     */
    suspend fun settleAfterSave(weekStart: String, sessionId: String, participantIds: List<String>, names: List<String> = emptyList()) {
        _state.update { it.copy(added = it.added + 1, madeGeneration = it.madeGeneration + 1, madeNote = PlanningConnectionCopy.madeNote(names)) }
        val board = _state.value.board
        val was = PlanningConnectionCopy.credited(board)
        val key = participantIds.joinToString("-")
        val before = board?.pairings?.firstOrNull { it.key == key }?.alreadyThisWeek?.mapTo(HashSet()) { it.id }
        settle(weekStart, sessionId, was, before?.let { key to it })
    }

    /**
     * THE CATCH-UP LADDER. The write is local-first but this board is a server read, so one
     * immediate re-read asks too early. Ask again on a widening ladder, stop the moment the
     * credited count goes UP, and give up after the last rung. A failed read stops at once.
     */
    private suspend fun settle(weekStart: String, sessionId: String, was: Int, autoLink: Pair<String, Set<String>>?) {
        for (rung in 0..CATCHUP.size) {
            val next = attempt { fetchBoard(weekStart) }
            if (next == null) {
                _state.update { it.copy(failed = true, loaded = true) }
                return
            }
            _state.update { it.copy(board = next, failed = false, loaded = true) }
            rebuild()
            if (PlanningConnectionCopy.credited(next) > was) {
                // Which event answers is decided by DIFFERENCE: only an id that appeared since we looked is certainly on the server.
                if (autoLink != null) {
                    val (key, before) = autoLink
                    next.pairings.firstOrNull { it.key == key }
                        ?.alreadyThisWeek?.firstOrNull { it.id !in before }
                        ?.let { link(key, it.id, sessionId) }
                }
                return
            }
            if (rung >= CATCHUP.size) return
            wait(CATCHUP[rung])
        }
    }

    fun clearMadeNote() = _state.update { it.copy(madeNote = null) }

    fun clearFailed() = _state.update { it.copy(failed = false) }

    private fun setLinks(links: Map<String, String>) {
        _state.update { it.copy(links = links) }
        rebuild()
    }

    private fun rebuild() = _state.update { s ->
        s.copy(rows = PlanningConnectionCopy.visible(s.board?.pairings.orEmpty()).map { PlanningConnectionRow.of(it, s.links[it.key]) })
    }

    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    companion object {
        val CATCHUP: List<Duration> = listOf(250.milliseconds, 500.milliseconds, 1.seconds, 2.seconds, 3.seconds)

        fun from(api: PlanningConnectionApi) = PlanningConnectionModel(
            fetchBoard = { api.board(it) },
            fetchSlots = { week, ids -> api.slots(week, ids) },
            saveLinks = { session, links -> api.saveLinks(session, links) },
        )
    }
}
