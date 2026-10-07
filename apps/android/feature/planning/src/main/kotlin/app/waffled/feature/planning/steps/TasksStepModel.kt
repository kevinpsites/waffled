package app.waffled.feature.planning.steps

import app.waffled.core.network.WaffledApiException
import app.waffled.feature.planning.api.PlanningTasksBoard
import app.waffled.feature.planning.api.PlanningTasksChore
import app.waffled.feature.planning.api.PlanningTasksRhythm
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

// Weekly Planning · step 8 "Tasks" — the model and its pure formatting. Port of iOS
// `TasksStepModel.swift`. A COLUMN IS THE WEEK, NOT THE SITTING: its contents come from the
// server read, never from local "what I just moved" state, so every write re-reads.

/** Pure strings, built ONCE PER LOAD and looked up by id — no date math in the render path. */
object PlanningTasksFormat {

    fun shortTime(hhmm: String?): String {
        val parts = hhmm?.split(":") ?: return ""
        if (parts.size != 2) return ""
        val h = parts[0].toIntOrNull() ?: return ""
        val m = parts[1].toIntOrNull() ?: return ""
        val ampm = if (h < 12) "am" else "pm"
        val h12 = if (h % 12 == 0) 12 else h % 12
        return if (m == 0) "$h12$ampm" else "$h12:${"%02d".format(m)}$ampm"
    }

    /** When this chore lands. EVERY BRANCH IS A FACT THE SERVER HANDED US. */
    fun dayChip(c: PlanningTasksChore): String {
        val time = shortTime(c.dueTime)
        fun withTime(s: String) = if (time.isEmpty()) s else "$s $time"
        return when {
            c.carriedOver -> withTime("Carried over")
            c.days.size >= 7 -> withTime("Every day")
            c.days.isNotEmpty() -> withTime(c.days.joinToString(", ") { weekdayOf(it) })
            // A one-off dated outside the week still says which day it is for.
            c.dueOn != null -> withTime(monthDay(c.dueOn))
            else -> "No day set"
        }
    }

    fun provenance(c: PlanningTasksChore): String = when {
        c.carriedOver -> "Left over from before this week"
        c.cadence == "once" -> "One-off task"
        else -> "Recurring chore"
    }

    fun carriesLabel(n: Int): String =
        if (n == 0) "No recurring chores yet" else "Carries $n recurring chore${if (n == 1) "" else "s"}"

    /** A one-off's day can be moved; a recurring chore's days come from its rrule. */
    fun dayIsSettable(c: PlanningTasksChore): Boolean = c.cadence == "once"

    fun dayIsUnset(c: PlanningTasksChore): Boolean = c.days.isEmpty() && c.dueOn == null && !c.carriedOver

    // Calendar labels, parsed as LocalDate: no zone can shift them a day.
    private val shortDay = DateTimeFormatter.ofPattern("EEE", Locale.US)
    private val monthDayFmt = DateTimeFormatter.ofPattern("MMM d", Locale.US)

    fun weekdayOf(iso: String): String = runCatching { LocalDate.parse(iso).format(shortDay) }.getOrDefault(iso)

    fun monthDay(iso: String): String = runCatching { LocalDate.parse(iso).format(monthDayFmt) }.getOrDefault(iso)
}

/** Where a card sits, in the same two-way vocabulary the Chores board uses. */
sealed interface PlanningTaskColumn {
    data object UpForGrabs : PlanningTaskColumn
    data class Person(val personId: String) : PlanningTaskColumn
}

/**
 * The drag payload, carried as the drag's LOCAL STATE under a private non-text MIME type,
 * so no text field accepts it. It carries an id and nothing else: who has the card is read
 * back off the board at drop time.
 */
data class PlanningTaskDrag(val choreId: String) {
    companion object {
        const val MIME_TYPE = "application/vnd.waffled.planning-task"

        fun choreId(localState: Any?): String? = (localState as? PlanningTaskDrag)?.choreId
    }
}

/** What the chore editor is open on. `Add(null, …)` is the strip's own "Add a task". */
sealed interface PlanningTasksComposer {
    data class Add(val personId: String?, val note: String?) : PlanningTasksComposer
    data class Edit(val chore: PlanningTasksChore, val owner: String?) : PlanningTasksComposer
}

data class PlanningTasksState(
    val board: PlanningTasksBoard? = null,
    val loaded: Boolean = false,
    val savingChoreId: String? = null,
    /** The NET number handed over this sitting; a take-back undoes its own tally. */
    val assigned: Int = 0,
    /** Bumped on every applied board, so the body re-hands the shell its crumb. */
    val rev: Int = 0,
    val errorMessage: String? = null,
    /** Set after an approval task is marked done: it waits for a parent. */
    val notice: String? = null,
    val composer: PlanningTasksComposer? = null,
    // Derived once per load — never recomputed in the render path.
    val dayChip: Map<String, String> = emptyMap(),
    val provenance: Map<String, String> = emptyMap(),
    val daySettable: Map<String, Boolean> = emptyMap(),
    val dayUnset: Map<String, Boolean> = emptyMap(),
    val carries: Map<String, String> = emptyMap(),
) {
    /** COUNTS ONLY: the recap reads through to chores itself. */
    val crumb: JsonObject
        get() = JsonObject(
            mapOf(
                "assigned" to JsonPrimitive(assigned),
                "leftUpForGrabs" to JsonPrimitive(board?.unassigned?.size ?: 0),
            ),
        )

    /** Server-owned, so a task added mid-session can't be dated to the day it was run. */
    val newTaskDay: String? get() = board?.newTaskDay
}

class PlanningTasksModel(
    private val fetchBoard: suspend (weekStart: String) -> PlanningTasksBoard,
    /** The PATCH **and** an assign per open instance; null takes the chore back. */
    private val handOut: suspend (chore: PlanningTasksChore, personId: String?) -> Unit,
    private val saveChore: suspend (choreId: String?, body: JsonObject) -> Unit,
    private val complete: suspend (instanceId: String) -> Unit,
    /** Step 1's resolve — the one writer Loose ends already uses for a rhythm. */
    private val settleRhythm: suspend (rhythmId: String, sessionId: String) -> Unit,
) {
    private val _state = MutableStateFlow(PlanningTasksState())
    val state: StateFlow<PlanningTasksState> = _state.asStateFlow()
    val current: PlanningTasksState get() = _state.value

    private var composerSaved = false

    /**
     * The shell's completion for a lent-verb composer. Held on the MODEL because the shell
     * captures the verb's closure; a CANCELLED composer must report false.
     */
    private var handoffDone: ((Boolean) -> Unit)? = null

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    /** A FAILED fetch keeps whatever was on screen but still counts as loaded. */
    suspend fun load(weekStart: String) {
        val fresh = attempt { fetchBoard(weekStart) }
        if (fresh != null) {
            apply(fresh)
        } else if (current.board == null) {
            _state.update { it.copy(errorMessage = "Couldn't load the chores board — try again in a moment.") }
        }
        _state.update { it.copy(loaded = true) }
    }

    /**
     * Move a chore to a person, or (null) back up for grabs — ONE path for faces, the 🙌 and
     * drag. A FAILED hand-out RE-READS: it is two writes, so the first may have landed.
     */
    suspend fun give(chore: PlanningTasksChore, personId: String?, weekStart: String): Boolean {
        if (current.savingChoreId != null) return false
        _state.update { it.copy(savingChoreId = chore.id, errorMessage = null) }
        try {
            try {
                handOut(chore, personId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.update {
                    it.copy(errorMessage = "That may not have gone through fully — the board has been re-read, so what you see is what's saved.")
                }
                load(weekStart)
                return false
            }
            _state.update { it.copy(assigned = if (personId != null) it.assigned + 1 else maxOf(0, it.assigned - 1)) }
            attempt { fetchBoard(weekStart) }?.let(::apply)
            return true
        } finally {
            _state.update { it.copy(savingChoreId = null) }
        }
    }

    /** Completes the chore's open day through the chores module, then re-reads. */
    suspend fun markDone(chore: PlanningTasksChore, weekStart: String): Boolean {
        val instanceId = chore.completableInstanceId ?: return false
        val ok = guarded(chore.id) { complete(instanceId) }
        if (!ok) return false
        _state.update { it.copy(notice = if (chore.requiresApproval) "${chore.title} is waiting for a parent’s OK." else null) }
        attempt { fetchBoard(weekStart) }?.let(::apply)
        return true
    }

    /** A booking rhythm is settled by an event, so it is refused here, not skipped by accident. */
    suspend fun settleRhythm(rhythm: PlanningTasksRhythm, sessionId: String, weekStart: String): Boolean {
        if (!rhythm.canComplete) return false
        if (!guarded(rhythm.id) { settleRhythm.invoke(rhythm.id, sessionId) }) return false
        attempt { fetchBoard(weekStart) }?.let(::apply)
        return true
    }

    private suspend fun guarded(id: String, call: suspend () -> Unit): Boolean {
        if (current.savingChoreId != null) return false
        _state.update { it.copy(savingChoreId = id, errorMessage = null) }
        return try {
            call()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            _state.update { it.copy(errorMessage = "That didn’t get marked done — try again.") }
            false
        } finally {
            _state.update { it.copy(savingChoreId = null) }
        }
    }

    // ---- dragging a card onto a person ----

    /** Which column a card sits in RIGHT NOW, or null when the board no longer has it. */
    fun column(choreId: String): PlanningTaskColumn? = located(choreId)?.second

    /**
     * A card was dropped on a column — the third caller of [give], not a fourth write path.
     * A drop where the card already sits, or of a card the board lost, spends no write.
     */
    suspend fun drop(choreId: String, onto: PlanningTaskColumn, weekStart: String): Boolean {
        val (chore, column) = located(choreId) ?: return false
        if (column == onto) return false
        return when (onto) {
            PlanningTaskColumn.UpForGrabs -> give(chore, null, weekStart)
            is PlanningTaskColumn.Person -> give(chore, onto.personId, weekStart)
        }
    }

    private fun located(choreId: String): Pair<PlanningTasksChore, PlanningTaskColumn>? {
        val board = current.board ?: return null
        board.unassigned.firstOrNull { it.id == choreId }?.let { return it to PlanningTaskColumn.UpForGrabs }
        for (person in board.people) {
            person.chores.firstOrNull { it.id == choreId }?.let { return it to PlanningTaskColumn.Person(person.id) }
        }
        return null
    }

    // ---- the chore editor ----

    fun openAdd(personId: String?) {
        composerSaved = false
        _state.update { it.copy(composer = PlanningTasksComposer.Add(personId, null)) }
    }

    fun openEdit(chore: PlanningTasksChore, owner: String?) {
        composerSaved = false
        _state.update { it.copy(composer = PlanningTasksComposer.Edit(chore, owner)) }
    }

    /** The banner lent this step a verb: open the chore editor seeded with the note. */
    fun beginHandoff(note: String, done: (Boolean) -> Unit) {
        // A second note arriving while one is open must not strand the first completion.
        handoffDone?.invoke(false)
        handoffDone = done
        composerSaved = false
        _state.update { it.copy(composer = PlanningTasksComposer.Add(null, note)) }
    }

    /** Persist what the editor built. Null on success, else the message the sheet shows. */
    suspend fun saveFromComposer(choreId: String?, body: JsonObject): String? = try {
        saveChore(choreId, body)
        composerSaved = true
        null
    } catch (e: CancellationException) {
        throw e
    } catch (e: WaffledApiException) {
        if (e.status == 401 || e.status == 403) {
            "Only a parent can add or edit tasks. Switch to a parent to make changes."
        } else {
            "Couldn't save this task — please try again."
        }
    } catch (_: Exception) {
        "Couldn't save this task — please try again."
    }

    /** The editor closed. A CANCELLED composer reports false. Returns whether it saved. */
    fun composerDismissed(): Boolean {
        val saved = composerSaved
        composerSaved = false
        _state.update { it.copy(composer = null) }
        handoffDone?.let { done ->
            handoffDone = null
            done(saved)
        }
        return saved
    }

    /** Withdraw a still-open handoff when the step goes away, or the banner waits forever. */
    fun abandonHandoff() {
        handoffDone?.let { done ->
            handoffDone = null
            done(false)
        }
    }

    private fun apply(fresh: PlanningTasksBoard) {
        val chips = HashMap<String, String>()
        val prov = HashMap<String, String>()
        val settable = HashMap<String, Boolean>()
        val unset = HashMap<String, Boolean>()
        val carried = HashMap<String, String>()
        fun index(c: PlanningTasksChore) {
            chips[c.id] = PlanningTasksFormat.dayChip(c)
            prov[c.id] = PlanningTasksFormat.provenance(c)
            settable[c.id] = PlanningTasksFormat.dayIsSettable(c)
            unset[c.id] = PlanningTasksFormat.dayIsUnset(c)
        }
        fresh.unassigned.forEach(::index)
        fresh.people.forEach { p ->
            carried[p.id] = PlanningTasksFormat.carriesLabel(p.recurringChores)
            p.chores.forEach(::index)
        }
        _state.update {
            it.copy(
                board = fresh,
                dayChip = chips,
                provenance = prov,
                daySettable = settable,
                dayUnset = unset,
                carries = carried,
                rev = it.rev + 1,
            )
        }
    }

    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}
