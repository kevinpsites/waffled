package app.waffled.feature.planning.steps

import androidx.compose.runtime.Immutable
import app.waffled.feature.calendar.EventPeople
import app.waffled.feature.goals.goalFmt
import app.waffled.feature.planning.PlanningFormat
import app.waffled.feature.planning.api.PlanningRecapCounts
import app.waffled.feature.planning.api.PlanningRecapCrumb
import app.waffled.feature.planning.api.PlanningRecapEvent
import app.waffled.feature.planning.api.PlanningRecapGroup
import app.waffled.feature.planning.api.PlanningRecapLastCall
import app.waffled.feature.planning.api.PlanningRecapLeftAlone
import app.waffled.feature.planning.api.PlanningRecapView
import app.waffled.feature.planning.api.PlanningRecapWeekTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import java.time.format.DateTimeFormatter
import java.util.Locale

// Weekly Planning · step 10 (Recap) — state and pure formatting. Port of iOS
// `RecapStepModel.swift`. THE MODEL COMPUTES NOTHING ABOUT THE WEEK: every tally arrives
// resolved, and re-adding counts here would be a second reading free to drift. It decides
// only the day labels and each event's colour inputs.

object PlanningRecapText {

    /** "7 of 10 hours" — one of last week's targets against what was logged. */
    fun targetLine(t: PlanningRecapWeekTarget): String {
        val unit = t.unit?.let { " $it" }.orEmpty()
        return "${goalFmt(t.done)} of ${goalFmt(t.target)}$unit"
    }

    /** "Lentil soup · Lottie"; a cook with no meal produces nothing (the web's `mealLine`). */
    fun mealLine(meal: String?, cook: String?): String? {
        if (meal.isNullOrEmpty()) return null
        return if (cook.isNullOrEmpty()) meal else "$meal · $cook"
    }

    fun decisionsLabel(n: Int): String = if (n == 1) "1 decision" else "$n decisions"

    // THE TENSE comes off the week's own `savedAt`: the recap is also the saved-week
    // record, which may be read on Thursday, so no sentence may promise what saving will do.

    fun changedTitle(saved: Boolean): String = if (saved) "What the session changed" else "What tonight changed"

    fun nothingDecidedDetail(saved: Boolean): String = if (saved) {
        "The week was saved as it stood — everything on the calendar, the plan and the board is exactly as it was."
    } else {
        "Saving still records the week you read back — and everything on the calendar, the plan and the board stays exactly as it is."
    }

    fun footNote(saved: Boolean): String {
        val pointer = "Every line above is a pointer, not a copy — it is already live in Calendar, Meals, Lists, Chores and Goals."
        return if (saved) {
            "$pointer The record was written when the week was saved: what was decided, what was deferred, what rolled over. Today is the surface now, not this session."
        } else {
            "$pointer Saving writes the record: what was decided, what was deferred, what rolled over, with a timestamp. After that Today is the surface, not this session."
        }
    }

    fun lastCallMoreLabel(n: Int): String =
        if (n == 1) "…and 1 more still on the board" else "…and $n more still on the board"

    private val shortDay = DateTimeFormatter.ofPattern("EEE", Locale.US)

    /** "Sun" for a `YYYY-MM-DD`, read as a calendar label so no zone can shift it. */
    fun dayName(ymd: String): String = PlanningFormat.parseDay(ymd)?.format(shortDay) ?: ymd

    fun dayNumber(ymd: String): String = PlanningFormat.parseDay(ymd)?.dayOfMonth?.toString().orEmpty()
}

/** One event on the strip, with its colour INPUTS precomputed for the calendar's palette. */
@Immutable
data class PlanningRecapEventRow(val id: String, val title: String, val `when`: String, val people: EventPeople)

@Immutable
data class PlanningRecapDayRow(
    val date: String,
    val dayName: String,
    val dayNumber: String,
    val mealLine: String?,
    val events: List<PlanningRecapEventRow>,
    val more: Int,
    val hidden: List<PlanningRecapEventRow>,
)

/** A parked note being turned into something real through the app's own editor. */
sealed interface RecapNoteComposer {
    val noteId: String
    val note: String

    data class Task(override val noteId: String, override val note: String) : RecapNoteComposer
    data class Event(override val noteId: String, override val note: String) : RecapNoteComposer
}

@Immutable
data class RecapStepState(
    val view: PlanningRecapView? = null,
    val loaded: Boolean = false,
    val days: List<PlanningRecapDayRow> = emptyList(),
    /** The note whose write is in flight. */
    val working: String? = null,
    val errorMessage: String? = null,
    val rev: Int = 0,
    /** Walked past ON PURPOSE. Local by design: keeping a note parked writes nothing. */
    val keptIds: Set<String> = emptySet(),
    val droppedIds: Set<String> = emptySet(),
    val composer: RecapNoteComposer? = null,
    /** The open composer really made something, so dismissing it settles the note. */
    val composerSaved: Boolean = false,
) {
    val openLastCall: List<PlanningRecapLastCall>
        get() = view?.lastCall.orEmpty().filter { it.id !in keptIds && it.id !in droppedIds }
    val groups: List<PlanningRecapGroup> get() = view?.groups.orEmpty()
    val leftAlone: List<PlanningRecapLeftAlone> get() = view?.leftAlone.orEmpty()
    val lastWeekTargets: List<PlanningRecapWeekTarget> get() = view?.lastWeekTargets.orEmpty()
    val counts: PlanningRecapCounts get() = view?.counts ?: PlanningRecapCounts()
    val nothingDecided: Boolean get() = groups.isEmpty() && leftAlone.isEmpty()

    /** Already saved — the record, not step 10. Off the payload, never a screen flag. */
    val saved: Boolean get() = view?.savedAt != null

    val crumb: JsonObject? get() = PlanningRecapCrumb.decision(view)
}

/**
 * Its only writes answer a parked note, through step 1's own resolver: drop it, or settle
 * it once a task or event really saved. Saving the week is the shell's affirmative.
 */
class PlanningRecapModel(
    private val fetchRecap: suspend (sessionId: String?, weekStart: String?) -> PlanningRecapView,
    private val dropNote: suspend (id: String, sessionId: String) -> Unit,
    private val settleNote: suspend (id: String, sessionId: String) -> Unit,
    private val saveChore: suspend (body: JsonObject) -> Unit,
) {
    private val _state = MutableStateFlow(RecapStepState())
    val state: StateFlow<RecapStepState> = _state.asStateFlow()

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    /** A FAILED fetch keeps what was on screen and still sets loaded. */
    suspend fun load(sessionId: String?, weekStart: String?) {
        val fresh = attempt { fetchRecap(sessionId, weekStart) }
        if (fresh != null) {
            apply(fresh)
        } else if (_state.value.view == null) {
            _state.update { it.copy(errorMessage = "Couldn’t read the week back just now — the week itself is unaffected.") }
        }
        _state.update { it.copy(loaded = true) }
    }

    /** The quiet answer: writes NOTHING, and the note turns up in next Sunday's step 1. */
    fun keepParked(id: String) {
        if (_state.value.working != null) return
        _state.update { it.copy(keptIds = it.keptIds + id) }
    }

    /** A failure leaves the note on the board rather than hiding a row that never landed. */
    suspend fun drop(id: String, sessionId: String) {
        if (_state.value.working != null) return
        _state.update { it.copy(working = id, errorMessage = null) }
        val ok = attempt { dropNote(id, sessionId) } != null
        _state.update {
            if (ok) {
                it.copy(working = null, droppedIds = it.droppedIds + id)
            } else {
                it.copy(working = null, errorMessage = "That didn’t take — the note is still on the board.")
            }
        }
    }

    fun makeTask(note: PlanningRecapLastCall) =
        _state.update { it.copy(composer = RecapNoteComposer.Task(note.id, note.note), composerSaved = false) }

    fun makeEvent(note: PlanningRecapLastCall) =
        _state.update { it.copy(composer = RecapNoteComposer.Event(note.id, note.note), composerSaved = false) }

    /** The chore editor's save: null on success, else the message the sheet shows. */
    suspend fun saveChoreFromNote(body: JsonObject): String? {
        val ok = attempt { saveChore(body) } != null
        if (!ok) return "Couldn’t save that — try again."
        _state.update { it.copy(composerSaved = true) }
        return null
    }

    fun eventSaved() = _state.update { it.copy(composerSaved = true) }

    /** The editor went away. Settle the note only if something was really made. */
    suspend fun composerDismissed(sessionId: String) {
        val s = _state.value
        val made = s.composer ?: return
        _state.update { it.copy(composer = null, composerSaved = false) }
        if (!s.composerSaved) return
        val ok = attempt { settleNote(made.noteId, sessionId) } != null
        _state.update {
            if (ok) {
                it.copy(droppedIds = it.droppedIds + made.noteId)
            } else {
                it.copy(errorMessage = "That was saved, but the note is still on the board — drop it when you’re ready.")
            }
        }
    }

    private fun apply(fresh: PlanningRecapView) {
        val days = fresh.days.map { day ->
            PlanningRecapDayRow(
                date = day.date,
                dayName = PlanningRecapText.dayName(day.date),
                dayNumber = PlanningRecapText.dayNumber(day.date),
                mealLine = PlanningRecapText.mealLine(day.meal, day.cook),
                events = day.events.map(::eventRow),
                more = day.more,
                hidden = day.hidden.map(::eventRow),
            )
        }
        _state.update { it.copy(view = fresh, days = days, rev = it.rev + 1) }
    }

    private fun eventRow(e: PlanningRecapEvent) = PlanningRecapEventRow(
        id = e.id,
        title = e.title,
        `when` = e.`when`,
        people = EventPeople(
            ownerPersonId = e.personId,
            ownerColorHex = e.personColor,
            participantIds = e.participantIds.toSet(),
        ),
    )

    private suspend fun <T> attempt(work: suspend () -> T): T? = try {
        work()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}
