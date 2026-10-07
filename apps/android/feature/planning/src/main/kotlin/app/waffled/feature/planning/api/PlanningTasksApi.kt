package app.waffled.feature.planning.api

import app.waffled.feature.chores.ChoresApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.math.roundToInt

// Weekly Planning · step 8 "Tasks" — wire types and its ONE read. Port of iOS
// `PlanningTasksAPI.swift`. Handing a chore out is a write to the CHORES module, so
// `handOut` composes two chores endpoints the app already has.

/** One card on the board: a chore DEFINITION, not a day's instance. */
@Serializable
data class PlanningTasksChore(
    val id: String,
    val title: String,
    val emoji: String? = null,
    val rrule: String? = null,
    /** "daily" | "weekly" | "once", in the chore editor's own words. */
    val cadence: String = "once",
    /** The days inside the planned week this chore lands on, computed server-side. */
    val days: List<String> = emptyList(),
    /** A one-off's own date, which may sit outside the planned week. */
    val dueOn: String? = null,
    /** "HH:mm", or null for no set time. */
    val dueTime: String? = null,
    /** A one-off whose day has PASSED, still open, rolling forward. */
    val carriedOver: Boolean = false,
    val rewardAmount: Double = 0.0,
    val rewardCurrency: String? = null,
    /** Carried so the editor opened from the card prefills honestly (it reads absent as false). */
    val requiresApproval: Boolean = false,
    val requiresPhoto: Boolean = false,
    /**
     * Every open day of this chore already on a board. `PATCH /api/chores/:id` only cascades
     * from today forward, so these are moved by hand — THE EASY-TO-MISS HALF of a hand-out.
     */
    val pendingInstanceIds: List<String> = emptyList(),
    /** A one-off's open day — what Done completes. The server decides; no dates on device. */
    val completableInstanceId: String? = null,
)

@Serializable
data class PlanningTasksPerson(
    val id: String,
    val name: String,
    val avatarEmoji: String? = null,
    /** A real `persons.color_hex` — data, so `colorFromHex`, not a `WF` token. */
    val colorHex: String? = null,
    val memberType: String = "",
    val isAdmin: Boolean = false,
    /** The standing load this person already carries — the fairness read, unscored. */
    val recurringChores: Int = 0,
    /** What they are holding for the planned week. Server-owned. */
    val chores: List<PlanningTasksChore> = emptyList(),
)

/** A rhythm needing attention in the planned week. Only "I do it" completes from here. */
@Serializable
data class PlanningTasksRhythm(
    val id: String,
    val title: String,
    val emoji: String? = null,
    val personId: String? = null,
    val detail: String = "",
    val overdue: Boolean = false,
    val canComplete: Boolean = false,
)

@Serializable
data class PlanningTasksBoard(
    /** The week the server resolved — echoed so nothing on the device does week arithmetic. */
    val weekStart: String,
    /** The day a task added during this session lands on. Server-owned, like the week. */
    val newTaskDay: String,
    val people: List<PlanningTasksPerson> = emptyList(),
    val unassigned: List<PlanningTasksChore> = emptyList(),
    /** Empty while rhythms is off, and from a server that predates the section. */
    val rhythms: List<PlanningTasksRhythm> = emptyList(),
)

/** The writes a hand-out actually is, as data — so the "every open instance" half is testable. */
object PlanningTasksHandOut {
    data class Plan(
        val choreId: String,
        /** The `PATCH /api/chores/:id` body. */
        val patch: JsonObject,
        val instanceIds: List<String>,
        val personId: String?,
    )

    fun plan(chore: PlanningTasksChore, personId: String?): Plan = Plan(
        choreId = chore.id,
        // EXPLICIT null when taking a chore back: an omitted key means "change nothing".
        patch = buildJsonObject { put("personId", personId?.let(::JsonPrimitive) ?: JsonNull) },
        // ALL of them, or the Chores board keeps showing the old name.
        instanceIds = chore.pendingInstanceIds,
        personId = personId,
    )
}

class PlanningTasksApi(private val http: PlanningHttp, private val chores: ChoresApi) {

    /** The board for the week being planned — the one the shell handed us. */
    suspend fun board(weekStart: String): PlanningTasksBoard =
        http.get("api/weekly-planning/tasks" + PlanningHttp.query("weekStart" to weekStart))

    /** Move a chore to a person, or back up for grabs with null: the PATCH, then every open day. */
    suspend fun handOut(chore: PlanningTasksChore, personId: String?) {
        val plan = PlanningTasksHandOut.plan(chore, personId)
        chores.updateChore(plan.choreId, plan.patch)
        for (instanceId in plan.instanceIds) chores.assign(instanceId, plan.personId)
    }
}

/**
 * A board card in the shape the chores editor edits. `owner` is the column the card sits
 * in, because a chore's "Who" is not on the board payload. A repeating card is the whole
 * chore (its own id); a one-off passes its open day, which a date change then moves.
 */
fun PlanningTasksChore.asChoreInstance(owner: String?): ChoresApi.ChoreInstance = ChoresApi.ChoreInstance(
    id = if (rrule == null) pendingInstanceIds.firstOrNull() ?: id else id,
    choreId = id,
    choreTitle = title,
    emoji = emoji,
    personId = owner,
    status = ChoresApi.STATUS_PENDING,
    // A whole number of stars: the instance's amount is an Int.
    rewardAmount = rewardAmount.roundToInt(),
    rewardCurrency = rewardCurrency,
    rrule = rrule,
    // The day the editor opens on; omitting it would silently move the chore to today.
    dueOn = dueOn,
    dueTime = dueTime,
    requiresApproval = requiresApproval,
    requiresPhoto = requiresPhoto,
)
