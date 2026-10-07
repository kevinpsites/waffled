package app.waffled.feature.planning.steps

import androidx.compose.runtime.Immutable
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.EventBucketing
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.familynight.FamilyNightApi
import app.waffled.feature.familynight.FamilyNightFormat
import app.waffled.feature.planning.PlanningFormat
import app.waffled.feature.planning.api.PlanningFamilyNightApi
import app.waffled.feature.planning.api.PlanningFamilyNightBoard
import app.waffled.feature.planning.api.PlanningFamilyNightPart
import app.waffled.feature.planning.api.PlanningWeekEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// Weekly Planning · step 4 (Family night) — the model and its pure formatting. Port of
// iOS `FamilyNightStepModel.swift`. Every write is followed by a RE-READ: the server owns
// the rotation. A skipped week still takes its turn (the rotation counts occurrences);
// that is a product call, and the skip bar says so.

/** One event in the link picker, with its owner resolved once for the calendar's chip. */
@Immutable
data class PlanningFamilyNightEventRow(val event: SyncedEvent, val owner: Person?)

/** One household-local day of the link picker. */
@Immutable
data class PlanningFamilyNightDay(val key: String, val label: String, val events: List<PlanningFamilyNightEventRow>)

/** Pure strings, computed once per load in the model. */
object PlanningFamilyNightFormat {

    /**
     * The week's events under the HOUSEHOLD-local day they happen on, all-day first then by
     * time; empty days left out. An 8 PM event in Chicago is the next day in UTC.
     */
    fun weekEventDays(
        events: List<PlanningWeekEvent>,
        weekStart: String,
        zone: ZoneId,
        locale: Locale = Locale.getDefault(),
    ): List<PlanningFamilyNightDay> {
        val start = PlanningFormat.parseDay(weekStart) ?: return emptyList()
        val rows = events.map { it.toRow() }
        val byDay = rows.groupBy { EventBucketing.startDay(it.event, zone) }
        val label = DateTimeFormatter.ofPattern("EEEE · MMM d", locale)
        return (0L until 7L).mapNotNull { offset ->
            val day = start.plusDays(offset)
            val list = byDay[day].orEmpty()
            if (list.isEmpty()) return@mapNotNull null
            val ordered = list.sortedWith(
                compareBy<PlanningFamilyNightEventRow> { if (it.event.allDay) 0 else 1 }
                    .thenBy { WaffledDates.parseInstant(it.event.startsAt, zone) ?: Instant.MIN },
            )
            PlanningFamilyNightDay(day.toString(), day.format(label), ordered)
        }
    }

    /** "2026-09-09" → "Wednesday, Sep 9": a calendar label, never an instant. */
    fun longDate(ymd: String, locale: Locale = Locale.getDefault()): String =
        PlanningFormat.parseDay(ymd)?.format(DateTimeFormatter.ofPattern("EEEE, MMM d", locale)) ?: ymd

    /** "17:00" → "5:00 PM" — the familyNight module's own clock wording. */
    fun clockTime(hhmm: String): String = FamilyNightFormat.timeLabel(hhmm)

    /** The rotation's guess, or somebody's decision? */
    fun suggestion(part: PlanningFamilyNightPart): String {
        val name = part.personName ?: return "nobody yet"
        return if (part.pinned) "pinned for this week · $name" else "suggested · $name, next in the rotation"
    }

    /** Keyed by the DEFAULT slugs only; a renamed or new part gets a question from its own label. */
    fun detailHint(part: PlanningFamilyNightPart): String = when (part.partId) {
        "activity" -> "optional — \"charades, kids vs parents\""
        "treat" -> "optional — \"the good ice cream\""
        "checkin" -> "optional — \"how was school, actually\""
        else -> "optional — what's the ${part.label.lowercase()}?"
    }

    fun plusDays(ymd: String, days: Int): String =
        PlanningFormat.parseDay(ymd)?.plusDays(days.toLong())?.toString() ?: ymd

    private fun PlanningWeekEvent.toRow(): PlanningFamilyNightEventRow {
        val synced = SyncedEvent(
            id = id,
            householdId = "",
            title = title,
            startsAt = startsAt,
            allDay = allDay,
            personId = personId,
            origin = origin,
        )
        // The payload carries the owner's colour, so the chip paints without a members lookup.
        val owner = personId?.let { Person(id = it, name = "", colorHex = personColor, avatarEmoji = personEmoji) }
        return PlanningFamilyNightEventRow(synced, owner)
    }
}

/**
 * What this sitting DECIDED, for the session record — not a copy of the module. Keys match
 * the web's `planningFamilyNightDecision` verbatim: both platforms write the same row.
 */
object PlanningFamilyNightDecision {
    fun crumb(board: PlanningFamilyNightBoard?): JsonObject = buildJsonObject {
        put("pinned", JsonArray(board?.parts.orEmpty().filter { it.pinned }.map { JsonPrimitive(it.partId) }))
        put("skipped", board?.status == "skipped")
    }
}

@Immutable
data class FamilyNightPartRow(
    val part: PlanningFamilyNightPart,
    val suggestion: String,
    val detailHint: String,
    /** Three rows each show "What"; each needs its own accessible name. */
    val detailDescription: String,
)

@Immutable
data class FamilyNightStepState(
    val board: PlanningFamilyNightBoard? = null,
    /** Set after the first fetch ATTEMPT, failed or not. */
    val loaded: Boolean = false,
    /** This step's own write is in flight — separate from the shell's busy. */
    val busy: Boolean = false,
    val rev: Int = 0,
    val rows: List<FamilyNightPartRow> = emptyList(),
    val recurrence: String = "",
    val whenLabel: String = "",
    /** Fetched only when the link picker opens, then kept. */
    val weekEvents: List<PlanningWeekEvent> = emptyList(),
    val weekEventsLoaded: Boolean = false,
    val errorMessage: String? = null,
) {
    val crumb: JsonObject get() = PlanningFamilyNightDecision.crumb(board)
}

/**
 * Step 4's state. Reads the planning board (the WEEK being planned) rather than wrapping
 * `FamilyNightModel`, which only knows the next upcoming gathering. Writes post
 * `FamilyNightBodies` through `FamilyNightApi.saveOccurrence`.
 */
class PlanningFamilyNightModel(
    private val fetchBoard: suspend (weekStart: String) -> PlanningFamilyNightBoard,
    private val saveOccurrence: suspend (body: JsonObject) -> Unit,
    private val fetchWeekEvents: suspend (from: String, to: String) -> List<PlanningWeekEvent>,
) {
    constructor(api: PlanningFamilyNightApi, module: FamilyNightApi) : this(
        fetchBoard = { api.board(it) },
        saveOccurrence = { module.saveOccurrence(it) },
        fetchWeekEvents = { from, to -> api.weekEvents(from, to) },
    )

    private val _state = MutableStateFlow(FamilyNightStepState())
    val state: StateFlow<FamilyNightStepState> = _state.asStateFlow()

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    /** A failed fetch keeps the board already there but still counts as loaded. */
    suspend fun load(weekStart: String) {
        val fresh = attempt { fetchBoard(weekStart) }
        if (fresh != null) {
            apply(fresh)
        } else if (_state.value.board == null) {
            _state.update { it.copy(errorMessage = "Couldn't read this week's family night — reload and try again.") }
        }
        _state.update { it.copy(loaded = true) }
    }

    /**
     * Post one body, then re-read. A FAILED write does not refetch and does not mutate.
     * Returns whether the write landed.
     */
    suspend fun write(body: JsonObject, weekStart: String): Boolean {
        if (_state.value.busy) return false
        _state.update { it.copy(busy = true, errorMessage = null) }
        try {
            saveOccurrence(body)
        } catch (e: CancellationException) {
            _state.update { it.copy(busy = false) }
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(busy = false, errorMessage = "That didn't take — try again.") }
            return false
        }
        attempt { fetchBoard(weekStart) }?.let(::apply)
        _state.update { it.copy(busy = false) }
        return true
    }

    /** Meal-plan mirrors are dropped: offering one would put a dinner where an evening goes. */
    suspend fun loadWeekEvents(weekStart: String) {
        if (_state.value.weekEventsLoaded) return
        val last = PlanningFamilyNightFormat.plusDays(weekStart, 6)
        val events = attempt { fetchWeekEvents(weekStart, last) }
        _state.update { s ->
            s.copy(
                weekEvents = events?.filter { it.origin != "meal_plan" && it.origin != "meal_prep" } ?: s.weekEvents,
                weekEventsLoaded = true,
            )
        }
    }

    private fun apply(fresh: PlanningFamilyNightBoard) {
        val rows = fresh.parts.map { part ->
            FamilyNightPartRow(
                part = part,
                suggestion = PlanningFamilyNightFormat.suggestion(part),
                detailHint = PlanningFamilyNightFormat.detailHint(part),
                detailDescription = "What is the ${part.label.lowercase()}?",
            )
        }
        _state.update {
            it.copy(
                board = fresh,
                rows = rows,
                recurrence = "every ${PlanningFormat.planningDayName(fresh.dayOfWeek)}",
                whenLabel = "${PlanningFamilyNightFormat.longDate(fresh.date)} · ${PlanningFamilyNightFormat.clockTime(fresh.time)}",
                rev = it.rev + 1,
            )
        }
    }

    private suspend fun <T> attempt(work: suspend () -> T): T? = try {
        work()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}
