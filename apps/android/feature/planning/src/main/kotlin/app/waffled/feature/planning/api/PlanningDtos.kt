package app.waffled.feature.planning.api

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Weekly Planning — the shell's wire types. Port of iOS `PlanningDTOs.swift`.
//
// The step catalog is SERVER-OWNED: keys, titles, questions, labels and acts all arrive in
// the view and nothing here hardcodes them. Every date stays a String: `weekStart` is a
// household-local `YYYY-MM-DD` that must never round-trip through a device date.

/** A parked note handed to the step it was tagged for. */
@Serializable
data class PlanningStepHandoff(
    val id: String,
    val note: String,
    val byline: String? = null,
)

@Serializable
data class PlanningStep(
    val key: String,
    /**
     * 1-based CATALOG position, counting steps this household doesn't run. NOT the
     * "2 of 9" the counter shows — derive that from [PlanningFormat.position].
     */
    val number: Int,
    val title: String,
    val ask: String,
    val primary: String,
    val act: String,
    /** Absent on the steps with no module behind them. */
    val requiresModule: String? = null,
    /** False when this step's module is off, or the household turned the step off. */
    val available: Boolean,
    /** "pending" | "done" | "skipped". */
    val status: String,
    /** The step's crumb. Free-form by design: a step reads its own keys out of it. */
    val data: JsonObject = JsonObject(emptyMap()),
    val decidedAt: String? = null,
    /** Null from an older server: a missing field must cost the banner, not the screen. */
    val parked: List<PlanningStepHandoff>? = null,
) {
    val isDone: Boolean get() = status == "done"
    val isSkipped: Boolean get() = status == "skipped"
    val isSettled: Boolean get() = status != "pending"
}

@Serializable
data class PlanningSession(
    val id: String,
    val weekStart: String,
    /** "active" | "completed". */
    val status: String,
    val currentStep: String? = null,
    val driverPersonId: String? = null,
    val startedAt: String,
    val completedAt: String? = null,
) {
    val isActive: Boolean get() = status == "active"
    val isCompleted: Boolean get() = status == "completed"
}

@Serializable
data class WeeklyPlanningConfig(
    /** 0 = Sunday … 6 = Saturday, for the "session due" prompt — not which week is planned. */
    val dayOfWeek: Int,
    /** "HH:MM", household-local. */
    val time: String,
    /** Per-step opt-out keyed by catalog key. Absent ⇒ on. */
    val steps: Map<String, Boolean> = emptyMap(),
    val showOnToday: Boolean,
    /** Which lists step 1 asks about; absent ⇒ relevant. Null from an older server. */
    val lists: Map<String, Boolean>? = null,
) {
    /** Whether the loose-ends step should ask about this list. Absent ⇒ yes. */
    fun asksAbout(listId: String): Boolean = lists?.get(listId) != false
}

@Serializable
data class WeeklyPlanningView(
    val config: WeeklyPlanningConfig,
    /** Snapped and floored by the server. ECHO IT; never compute a week on the device. */
    val weekStart: String,
    /** The week a fresh session would plan. */
    val defaultWeekStart: String,
    /** The earliest week the stepper may reach. */
    val minWeekStart: String,
    val session: PlanningSession? = null,
    val steps: List<PlanningStep> = emptyList(),
)

/**
 * One entry of the catalog as `GET /config` serves it — the bare `STEPS` array, without
 * the per-session keys, which is why it isn't a [PlanningStep].
 */
@Serializable
data class PlanningStepCatalogEntry(
    val key: String,
    val title: String,
    val ask: String,
    val primary: String,
    val act: String,
    val requiresModule: String? = null,
)

/** A list the loose-ends step COULD ask about, resolved server-side. */
@Serializable
data class PlanningListCandidate(
    val id: String,
    val name: String,
    val emoji: String? = null,
    val relevant: Boolean = true,
)

@Serializable
data class WeeklyPlanningConfigView(
    val config: WeeklyPlanningConfig,
    val steps: List<PlanningStepCatalogEntry> = emptyList(),
    val lists: List<PlanningListCandidate>? = null,
)

@Serializable
data class WeeklyPlanningCompletion(
    val session: PlanningSession,
    val steps: List<PlanningStep> = emptyList(),
)

/**
 * A routed loose end — THE CROSS-STEP CONTRACT. Step 1 persists these on its own row as
 * `data.routes`; later steps and the shell's banner read them back through
 * [PlanningRouteSeed]. Import this; do not redefine it in a step.
 *
 * `title`/`source` are tolerant: the server's guard checks only kind/id/to, so an older
 * row can lack them. `source` is never null, because step 1 writes these back through
 * `decideStep` (which REPLACES the row's data) and a dropped key would be lost for good —
 * hence `@EncodeDefault`, since `WaffledJson` otherwise omits a value equal to its default.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class LooseEndRoute(
    val kind: String,
    val id: String,
    @EncodeDefault val title: String = "",
    @EncodeDefault val source: String = if (kind == "parked") "parked" else "notDone",
    val to: String,
)

/** A parked note as the park/update routes return it. */
@Serializable
data class PlanningParkedItem(
    val id: String,
    val note: String,
    val stepKey: String? = null,
    val status: String = "open",
    val sessionId: String? = null,
    val createdAt: String = "",
)
