package app.waffled.feature.planning

import app.waffled.core.network.WaffledJson
import app.waffled.feature.planning.api.LooseEndRoute
import app.waffled.feature.planning.api.PlanningStepHandoff
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement

/**
 * Reading `data.routes` off step 1's record — one implementation, because the tolerance
 * rule only stays true in one place. Port of iOS `PlanningRouteSeed.swift`.
 */
object PlanningRouteSeed {

    /**
     * Decode TOLERANTLY: one unreadable row costs that row only. `[]` for absent, null or
     * anything that isn't an array.
     */
    fun decode(value: JsonElement?): List<LooseEndRoute> {
        val items = value as? JsonArray ?: return emptyList()
        return items.mapNotNull { item ->
            runCatching { WaffledJson.decodeFromJsonElement(LooseEndRoute.serializer(), item) }.getOrNull()
        }
    }

    fun addressed(stepKey: String, routes: List<LooseEndRoute>): List<LooseEndRoute> =
        routes.filter { it.to == stepKey }

    /** A route's identity, `"chore:<uuid>"` — never the title; two loose ends can read the same. */
    fun key(route: LooseEndRoute): String = "${route.kind}:${route.id}"

    /**
     * The routed half of a step's "sent here" box: addressed here; not already in the box
     * as a parked note (matched on the note's id, since routing a note also tags it); not a
     * step that draws its own; and not already acted on this sitting ([settled] holds
     * [key]s). [parked] is the RAW handoff list, not the banner's locally-hidden view.
     */
    fun sentHere(
        stepKey: String,
        routes: List<LooseEndRoute>,
        parked: List<PlanningStepHandoff>?,
        settled: Set<String>,
    ): List<LooseEndRoute> {
        if (stepKey in drawsItsOwn) return emptyList()
        val notes = parked.orEmpty().mapTo(HashSet()) { it.id }
        return addressed(stepKey, routes).filter { route ->
            !(route.kind == "parked" && route.id in notes) && key(route) !in settled
        }
    }

    private val drawsItsOwn = setOf("kids", "looseEnds")
}
