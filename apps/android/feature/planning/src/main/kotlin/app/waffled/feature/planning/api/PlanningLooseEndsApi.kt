package app.waffled.feature.planning.api

import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Weekly Planning · step 1 "Loose ends" — its reads and its two writes. Port of iOS
// `PlanningLooseEndsAPI.swift`. Parking and editing a note live on the shell's
// `PlanningApi`, and `LooseEndRoute` (the cross-step contract) in `PlanningDtos.kt`.

/**
 * One thing still open. `kind` and `actions` stay strings: the catalog of kinds is the
 * server's, and a fifth kind must cost its own label, not the whole step.
 */
@Serializable
data class LooseEnd(
    val key: String,
    val kind: String,
    val id: String,
    val title: String,
    val emoji: String? = null,
    val detail: String? = null,
    val actions: List<String> = emptyList(),
    /** Null is "nobody has this" — a real state, and the row most worth routing. */
    val owner: LooseEndOwner? = null,
)

@Serializable
data class LooseEndOwner(
    val id: String,
    val name: String,
    val colorHex: String? = null,
    val avatarEmoji: String? = null,
)

@Serializable
data class LooseEndDestination(
    val to: String,
    val label: String,
    val hint: String,
    /** Absent on all but one destination — the server omits the key rather than sending false. */
    val primary: Boolean? = null,
    /** The step's title ("Meals"), for naming where something was sent. */
    val stepTitle: String? = null,
)

@Serializable
data class LooseEndDestinations(
    val notDone: List<LooseEndDestination> = emptyList(),
    val parked: List<LooseEndDestination> = emptyList(),
)

@Serializable
data class LooseEndCounts(val notDone: Int = 0, val parked: Int = 0)

@Serializable
data class LooseEndsView(
    val weekStart: String,
    val notDone: List<LooseEnd> = emptyList(),
    val parked: List<LooseEnd> = emptyList(),
    val counts: LooseEndCounts = LooseEndCounts(),
    val destinations: LooseEndDestinations = LooseEndDestinations(),
    val routes: List<LooseEndRoute> = emptyList(),
    val sources: List<String> = emptyList(),
    /** Null from a server that predates the list setting. */
    val lists: List<PlanningListCandidate>? = null,
)

@Serializable
data class LooseEndResolution(val ok: Boolean, val kind: String, val id: String, val action: String)

class PlanningLooseEndsApi(private val http: PlanningHttp) {

    @Serializable private data class RoutesEnvelope(val routes: List<LooseEndRoute> = emptyList())

    suspend fun looseEnds(weekStart: String?, sessionId: String?): LooseEndsView =
        http.get(
            "api/weekly-planning/loose-ends" +
                PlanningHttp.query("weekStart" to weekStart, "sessionId" to sessionId),
        )

    /** `to = null` UNDOES the routing, and is sent as an explicit null, never omitted. */
    suspend fun route(
        sessionId: String,
        kind: String,
        id: String,
        title: String,
        source: String,
        to: String?,
    ): List<LooseEndRoute> =
        http.send<RoutesEnvelope>(
            HttpMethod.Post,
            "api/weekly-planning/loose-ends/route",
            buildJsonObject {
                put("sessionId", sessionId)
                put("kind", kind)
                put("id", id)
                put("title", title)
                put("source", source)
                put("to", to?.let(::JsonPrimitive) ?: JsonNull)
            },
        ).routes

    suspend fun resolve(kind: String, id: String, action: String, sessionId: String?): LooseEndResolution =
        http.send(
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
