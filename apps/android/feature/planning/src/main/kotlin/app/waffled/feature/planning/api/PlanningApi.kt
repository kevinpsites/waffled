package app.waffled.feature.planning.api

import app.waffled.core.network.TokenProvider
import io.ktor.client.HttpClient
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A PARTIAL config write — pass only what changed. `steps` and `lists` merge server-side,
 * so sending a whole map from this device's snapshot would clobber another device's change.
 */
data class PlanningConfigPatch(
    val dayOfWeek: Int? = null,
    val time: String? = null,
    val showOnToday: Boolean? = null,
    val steps: Map<String, Boolean>? = null,
    val lists: Map<String, Boolean>? = null,
) {
    fun body(): JsonObject = buildJsonObject {
        dayOfWeek?.let { put("dayOfWeek", it) }
        time?.let { put("time", it) }
        showOnToday?.let { put("showOnToday", it) }
        steps?.let { m -> putJsonObject("steps") { m.forEach { (k, v) -> put(k, v) } } }
        lists?.let { m -> putJsonObject("lists") { m.forEach { (k, v) -> put(k, v) } } }
    }
}

/**
 * How an edit treats a parked note's tag. The server reads the key for PRESENCE:
 * [Unchanged] omits it; `To(null)` sends an explicit null — the real answer "No tag".
 */
sealed interface ParkedTagChange {
    data object Unchanged : ParkedTagChange
    data class To(val stepKey: String?) : ParkedTagChange
}

/**
 * The shell's routes (`/api/weekly-planning`), plus the three parked-note routes the shell's
 * banner and park sheet need. Each step's own reads live in `Planning<Step>Api.kt`.
 * Port of iOS `PlanningAPI.swift` and the parked-note half of `PlanningLooseEndsAPI.swift`.
 */
class PlanningApi(client: HttpClient, tokens: TokenProvider) {

    val http = PlanningHttp(client, tokens)

    @Serializable private data class SessionEnvelope(val session: PlanningSession)
    @Serializable private data class StepsEnvelope(val steps: List<PlanningStep> = emptyList())
    @Serializable private data class ConfigEnvelope(val config: WeeklyPlanningConfig)
    @Serializable private data class ParkedEnvelope(val item: PlanningParkedItem)

    /** The landing read. The answer's own `weekStart` is the authority — echo that. */
    suspend fun view(weekStart: String? = null): WeeklyPlanningView =
        http.get("api/weekly-planning" + PlanningHttp.query("weekStart" to weekStart))

    /** Config plus the bare catalog and the askable lists. */
    suspend fun config(): WeeklyPlanningConfigView = http.get("api/weekly-planning/config")

    /** Admin-only for day/time/today/steps; `lists` needs `planning.manage`. */
    suspend fun setConfig(patch: PlanningConfigPatch): WeeklyPlanningConfig =
        http.send<ConfigEnvelope>(HttpMethod.Put, "api/weekly-planning/config", patch.body()).config

    /** Start this week's session, or resume the one already there. */
    suspend fun startSession(weekStart: String? = null): PlanningSession =
        http.send<SessionEnvelope>(
            HttpMethod.Post,
            "api/weekly-planning/session",
            buildJsonObject { if (!weekStart.isNullOrEmpty()) put("weekStart", weekStart) },
        ).session

    /** OMIT WHAT YOU AREN'T CHANGING: a null `currentStep` is a 400. */
    suspend fun patchSession(id: String, currentStep: String? = null, status: String? = null): PlanningSession =
        http.send<SessionEnvelope>(
            HttpMethod.Patch,
            "api/weekly-planning/session/${PlanningHttp.seg(id)}",
            buildJsonObject {
                currentStep?.let { put("currentStep", it) }
                status?.let { put("status", it) }
            },
        ).session

    /** Record a step's answer; `data` is omitted entirely when there is no crumb. */
    suspend fun decideStep(sessionId: String, stepKey: String, status: String, data: JsonObject? = null): List<PlanningStep> =
        http.send<StepsEnvelope>(
            HttpMethod.Post,
            "api/weekly-planning/session/${PlanningHttp.seg(sessionId)}/step",
            buildJsonObject {
                put("stepKey", stepKey)
                put("status", status)
                if (data != null) put("data", data)
            },
        ).steps

    /** Throw the session away. What it decided lives in the modules that own it. */
    suspend fun discardSession(id: String) {
        http.sendIgnoring(HttpMethod.Delete, "api/weekly-planning/session/${PlanningHttp.seg(id)}")
    }

    suspend fun completeSession(id: String): WeeklyPlanningCompletion =
        http.send(HttpMethod.Post, "api/weekly-planning/session/${PlanningHttp.seg(id)}/complete")

    /**
     * Settle one routed loose end. `sessionId` retires it from THIS session's route list,
     * so a note dealt with here stops being offered by the recap.
     */
    suspend fun resolveLooseEnd(kind: String, id: String, action: String, sessionId: String? = null) {
        http.sendIgnoring(
            HttpMethod.Post,
            "api/weekly-planning/loose-ends/resolve",
            buildJsonObject {
                put("kind", kind)
                put("id", id)
                put("action", action)
                if (!sessionId.isNullOrEmpty()) put("sessionId", sessionId)
            },
        )
    }

    /** Park a note. Both optionals are OMITTED when absent: "No tag" is the absence of one. */
    suspend fun parkNote(note: String, stepKey: String? = null, sessionId: String? = null): PlanningParkedItem =
        http.send<ParkedEnvelope>(
            HttpMethod.Post,
            "api/weekly-planning/loose-ends/parked",
            buildJsonObject {
                put("note", note)
                if (!stepKey.isNullOrEmpty()) put("stepKey", stepKey)
                if (!sessionId.isNullOrEmpty()) put("sessionId", sessionId)
            },
        ).item

    /** Fix a parked note's words, its tag, or both. A null [note] leaves the words alone. */
    suspend fun updateParkedNote(
        id: String,
        note: String? = null,
        stepKey: ParkedTagChange = ParkedTagChange.Unchanged,
        sessionId: String? = null,
    ): PlanningParkedItem =
        http.send<ParkedEnvelope>(
            HttpMethod.Patch,
            "api/weekly-planning/loose-ends/parked/${PlanningHttp.seg(id)}",
            buildJsonObject {
                note?.let { put("note", it) }
                if (stepKey is ParkedTagChange.To) put("stepKey", stepKey.stepKey?.let(::JsonPrimitive) ?: JsonNull)
                if (!sessionId.isNullOrEmpty()) put("sessionId", sessionId)
            },
        ).item
}
