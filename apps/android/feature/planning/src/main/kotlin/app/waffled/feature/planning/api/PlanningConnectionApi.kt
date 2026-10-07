package app.waffled.feature.planning.api

import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

// Weekly Planning · step 5 "Connection" — two reads and one pointer. Port of iOS
// `PlanningConnectionAPI.swift`. Nothing new is stored: a pairing is a query over event
// participants and claiming a slot writes an ordinary calendar event. The one write,
// `links`, is a mid-step POINTER that merges onto the step's row without settling it.

@Serializable
data class PlanningConnectionSlot(
    val date: String,
    /** NULL MEANS THE WHOLE DAY IS FREE, not "unknown": the event sheet's own picker decides the hour. */
    val startsAt: String? = null,
    /** `after` | `open` — the catalog of kinds is the server's. */
    val kind: String,
    val afterTitle: String? = null,
    /** "Wed after Scouts" / "Sun · free all day", built server-side. */
    val label: String,
) {
    val isFreeAllDay: Boolean get() = startsAt == null
}

@Serializable
data class PlanningConnectionEvent(
    val id: String,
    val title: String,
    val startsAt: String,
    val endsAt: String? = null,
    val allDay: Boolean = false,
    val minutes: Int? = null,
    val day: String,
    val time: String? = null,
    /** "Saturday 1:00 PM", formatted in the household's zone server-side. */
    val `when`: String,
)

@Serializable
data class PlanningConnectionPairing(
    val personIds: List<String>,
    val who: String,
    /** The last event BEFORE the planned week whose people were exactly these two. */
    val lastTogetherOn: String? = null,
    val lastTogetherTitle: String? = null,
    /** Events this week whose people are EXACTLY these two. */
    val alreadyThisWeek: List<PlanningConnectionEvent> = emptyList(),
    /** Events this week with both of them AND someone else. */
    val togetherThisWeek: List<PlanningConnectionEvent> = emptyList(),
    /** Ranked gaps, roomiest first — all of them; how many fit is the step's call. */
    val slots: List<PlanningConnectionSlot> = emptyList(),
) {
    /** The exact spelling `PUT /links` is keyed by on every platform. Do not re-spell it. */
    val key: String get() = personIds.joinToString("-")
}

@Serializable
data class PlanningConnectionBoard(
    /** The week the server resolved — echoed, never computed here. */
    val weekStart: String,
    /** EVERY pair, ranked; the cut is the client's (`PlanningConnectionCopy.visible`). */
    val pairings: List<PlanningConnectionPairing> = emptyList(),
)

@Serializable
data class PlanningConnectionSlots(
    val weekStart: String,
    /** Household order, not tap order — the server re-sorts. */
    val personIds: List<String> = emptyList(),
    val who: String = "",
    val slots: List<PlanningConnectionSlot> = emptyList(),
)

class PlanningConnectionApi(private val http: PlanningHttp) {

    @Serializable private data class Ok(val ok: Boolean = true)

    suspend fun board(weekStart: String?): PlanningConnectionBoard =
        http.get("api/weekly-planning/connection" + PlanningHttp.query("weekStart" to weekStart))

    /** 400s on fewer than two people, or an id from another household. */
    suspend fun slots(weekStart: String, personIds: List<String>): PlanningConnectionSlots =
        http.get(
            "api/weekly-planning/connection/slots" +
                PlanningHttp.query("weekStart" to weekStart, "people" to personIds.joinToString(",")),
        )

    /**
     * Which event answers each pairing. Mid-step: `setDecisionData` alone only reaches the
     * server when the step is answered, and somebody who links a time then walks off has
     * answered nothing.
     */
    suspend fun saveLinks(sessionId: String, links: Map<String, String>) {
        http.send<Ok>(
            HttpMethod.Put,
            "api/weekly-planning/connection/links",
            buildJsonObject {
                put("sessionId", sessionId)
                putJsonObject("links") { links.forEach { (k, v) -> put(k, v) } }
            },
        )
    }
}
