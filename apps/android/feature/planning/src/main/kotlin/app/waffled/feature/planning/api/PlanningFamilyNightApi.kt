package app.waffled.feature.planning.api

import kotlinx.serialization.Serializable

// Weekly Planning · step 4 (Family night) — this step's ONE read and the week's events for
// "Link an event". Port of iOS `PlanningFamilyNightAPI.swift`. Writes go through
// `feature:familynight`'s own `FamilyNightApi.saveOccurrence` with `FamilyNightBodies`,
// whose presence rules are the contract. Every date stays a String: a label, not an instant.

@Serializable
data class PlanningFamilyNightMember(
    val id: String,
    val name: String = "",
    val avatarEmoji: String? = null,
    val colorHex: String? = null,
)

@Serializable
data class PlanningFamilyNightPart(
    val partId: String,
    val label: String = "",
    val emoji: String = "",
    /** False: the rotation never auto-fills this part. It still takes a pin. */
    val rotates: Boolean = true,
    val detail: String? = null,
    val personId: String? = null,
    val personName: String? = null,
    /** Chosen for this week (written on the occurrence), not the rotation's suggestion. */
    val pinned: Boolean = false,
)

@Serializable
data class PlanningFamilyNightBoard(
    val weekStart: String = "",
    val date: String,
    val dayOfWeek: Int = 0,
    val time: String = "19:00",
    /** Null until somebody touches the week: the board is a pure read. */
    val occurrenceId: String? = null,
    val theme: String? = null,
    /** "planned" | "done" | "skipped". */
    val status: String = "planned",
    /** A STANDING recurring series. Only then may the step promise a skip leaves it alone. */
    val onCalendar: Boolean = false,
    /** THIS week's own event, separate from the standing series. */
    val eventId: String? = null,
    val eventTitle: String? = null,
    val eventWhen: String? = null,
    val members: List<PlanningFamilyNightMember> = emptyList(),
    val parts: List<PlanningFamilyNightPart> = emptyList(),
) {
    val isSkipped: Boolean get() = status == "skipped"
}

/** An event on the planned week, for the link picker. Meal mirrors are filtered out. */
@Serializable
data class PlanningWeekEvent(
    val id: String,
    val title: String = "",
    val origin: String? = null,
    val startsAt: String? = null,
    val allDay: Boolean = false,
    val personId: String? = null,
    val personColor: String? = null,
    val personEmoji: String? = null,
)

class PlanningFamilyNightApi(private val http: PlanningHttp) {

    @Serializable private data class EventsEnvelope(val events: List<PlanningWeekEvent> = emptyList())

    /** [weekStart] is the shell's — passed back, never computed here. */
    suspend fun board(weekStart: String): PlanningFamilyNightBoard =
        http.get("api/weekly-planning/familyNight" + PlanningHttp.query("weekStart" to weekStart))

    /** Whole days stepped off the boundary the SERVER gave us. */
    suspend fun weekEvents(from: String, to: String): List<PlanningWeekEvent> =
        http.get<EventsEnvelope>("api/events" + PlanningHttp.query("from" to from, "to" to to)).events
}
