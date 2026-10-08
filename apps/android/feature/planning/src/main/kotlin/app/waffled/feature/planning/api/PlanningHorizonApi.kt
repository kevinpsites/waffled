package app.waffled.feature.planning.api

import kotlinx.serialization.Serializable

// Weekly Planning · step 3 "Horizon scan" — ONE read. Port of iOS `PlanningHorizonAPI.swift`.
// The month is the synced calendar, adding is `EventEditSheet`, and parking is step 1's
// writer on `PlanningApi`; what's left is which tags the bar may offer and what this
// session has parked.

/** One tag the park bar may offer — it names the step that will LOOK at the note. */
@Serializable
data class HorizonTag(
    val stepKey: String,
    val label: String,
    val hint: String = "",
    /** The one the bar opens on; ABSENT when its step is unavailable, so the bar opens on "No tag". */
    val primary: Boolean? = null,
)

@Serializable
data class HorizonNote(
    val id: String,
    val note: String,
    val stepKey: String? = null,
    val stepLabel: String? = null,
    val createdAt: String = "",
)

@Serializable
data class HorizonView(
    /** "No tag" is the absence of a tag, so it is never in this list. */
    val tags: List<HorizonTag> = emptyList(),
    /** Every open note parked during this session, from either bar. */
    val parked: List<HorizonNote> = emptyList(),
)

class PlanningHorizonApi(private val http: PlanningHttp) {
    suspend fun horizon(sessionId: String?): HorizonView =
        http.get("api/weekly-planning/horizon" + PlanningHttp.query("sessionId" to sessionId))
}
