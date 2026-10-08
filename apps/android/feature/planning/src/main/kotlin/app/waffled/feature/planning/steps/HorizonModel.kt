package app.waffled.feature.planning.steps

import androidx.compose.runtime.Immutable
import app.waffled.feature.planning.PlanningModel
import app.waffled.feature.planning.api.HorizonNote
import app.waffled.feature.planning.api.HorizonTag
import app.waffled.feature.planning.api.HorizonView
import app.waffled.feature.planning.api.ParkedTagChange
import app.waffled.feature.planning.api.PlanningApi
import app.waffled.feature.planning.api.PlanningHorizonApi
import app.waffled.feature.planning.api.PlanningParkedItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Weekly Planning · step 3 "Horizon scan" — the state behind the park bar. Port of iOS
// `HorizonModel.swift`. The four weeks hold no state here (they are the synced calendar);
// this owns the one thing the session adds: a parked note and its tag.

/**
 * Which step a note is for. THREE states: [Unset] resolves to the server's primary tag,
 * [NoTag] is the deliberate answer. A nullable key could not represent the default — and a
 * household with no Tasks step gets no primary, so the bar must open on "No tag".
 */
sealed interface PlanningTagChoice {
    data object Unset : PlanningTagChoice
    data object NoTag : PlanningTagChoice
    data class Step(val key: String) : PlanningTagChoice
}

@Immutable
data class HorizonState(
    /** Only the steps still AHEAD — the server filters. */
    val tags: List<HorizonTag> = emptyList(),
    val parked: List<HorizonNote> = emptyList(),
    val loaded: Boolean = false,
    val parking: Boolean = false,
    val errorMessage: String? = null,
    /** Real calendar events added from this step. */
    val added: Int = 0,
    val tagChoice: PlanningTagChoice = PlanningTagChoice.Unset,
) {
    /** Null means no tag at all, which is what "No tag" sends. */
    val chosenStepKey: String?
        get() = when (val c = tagChoice) {
            PlanningTagChoice.Unset -> tags.firstOrNull { it.primary == true }?.stepKey
            PlanningTagChoice.NoTag -> null
            is PlanningTagChoice.Step -> c.key
        }

    val chosenLabel: String? get() = chosenStepKey?.let { key -> label(key) }

    fun label(stepKey: String): String? = tags.firstOrNull { it.stepKey == stepKey }?.label

    /** Counts only: the board is read back from the table that owns it. */
    val decisionData: JsonObject
        get() = JsonObject(mapOf("added" to JsonPrimitive(added), "parked" to JsonPrimitive(parked.size)))
}

class PlanningHorizonModel(
    private val fetchHorizon: suspend (sessionId: String) -> HorizonView,
    private val parkNote: suspend (note: String, stepKey: String?, sessionId: String) -> PlanningParkedItem,
    private val updateNote: suspend (id: String, note: String?, tag: ParkedTagChange, sessionId: String) -> PlanningParkedItem,
) {
    private val _state = MutableStateFlow(HorizonState())
    val state: StateFlow<HorizonState> = _state.asStateFlow()

    /** A failed fetch keeps what we had and still counts as loaded. */
    suspend fun load(sessionId: String) {
        val next = try {
            fetchHorizon(sessionId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        _state.update { if (next != null) it.copy(tags = next.tags, parked = next.parked, loaded = true) else it.copy(loaded = true) }
    }

    fun choose(choice: PlanningTagChoice) = _state.update { it.copy(tagChoice = choice) }

    /** Park a note for the chosen step, or for nobody. A refusal leaves the board as it was. */
    suspend fun park(note: String, sessionId: String): Boolean {
        val text = note.trim()
        val s = _state.value
        if (text.isEmpty() || s.parking) return false
        val label = s.chosenLabel
        return write {
            val item = parkNote(text, s.chosenStepKey, sessionId)
            // The row the server wrote, so the board shows what was stored rather than a guess.
            val row = HorizonNote(item.id, item.note, item.stepKey, if (item.stepKey == null) null else label, item.createdAt)
            _state.update { it.copy(parked = it.parked + row, tagChoice = PlanningTagChoice.Unset) }
        }
    }

    /** Fix a note on the board. The label is re-joined from the catalog, never stored. */
    suspend fun update(id: String, note: String?, tag: ParkedTagChange, sessionId: String): Boolean {
        if (_state.value.parking) return false
        return write {
            val item = updateNote(id, note, tag, sessionId)
            _state.update { s ->
                s.copy(
                    parked = s.parked.map {
                        if (it.id != item.id) it else HorizonNote(item.id, item.note, item.stepKey, item.stepKey?.let(s::label), item.createdAt)
                    },
                )
            }
        }
    }

    fun recordEventAdded() = _state.update { it.copy(added = it.added + 1) }

    fun clearError() = _state.update { it.copy(errorMessage = null) }

    private suspend fun write(work: suspend () -> Unit): Boolean {
        _state.update { it.copy(parking = true, errorMessage = null) }
        return try {
            work()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(errorMessage = PlanningModel.errorText(e, LooseEndCopy.WRITE_FAILED)) }
            false
        } finally {
            _state.update { it.copy(parking = false) }
        }
    }

    companion object {
        fun from(api: PlanningHorizonApi, shell: PlanningApi) = PlanningHorizonModel(
            fetchHorizon = { api.horizon(it) },
            parkNote = { note, key, session -> shell.parkNote(note, key, session) },
            updateNote = { id, note, tag, session -> shell.updateParkedNote(id, note, tag, session) },
        )
    }
}
