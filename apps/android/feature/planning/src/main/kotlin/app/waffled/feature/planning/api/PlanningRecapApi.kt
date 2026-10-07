package app.waffled.feature.planning.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Weekly Planning · step 10 "Recap" — ONE read, no write of its own. Port of iOS
// `PlanningRecapAPI.swift`. Every line is a POINTER, never a copy: headlines, sentences,
// tallies and each event's `when` arrive resolved; the client decides only layout. Every
// collection defaults, so a missing array costs that card and never the whole recap.

@Serializable
data class PlanningRecapEvent(
    val id: String,
    val title: String = "",
    /** Composed server-side in the household's zone: text to show, not a date to parse. */
    val `when`: String = "",
    val personId: String? = null,
    val personName: String? = null,
    /** A real `persons.color_hex` — colour INPUT for the calendar's own palette. */
    val personColor: String? = null,
    val participantIds: List<String> = emptyList(),
)

@Serializable
data class PlanningRecapDay(
    val date: String,
    /** Null with the meals module off too. */
    val meal: String? = null,
    val cook: String? = null,
    val events: List<PlanningRecapEvent> = emptyList(),
    val more: Int = 0,
    /** What the cap held back, so a busy day can open in place. Empty from an older server. */
    val hidden: List<PlanningRecapEvent> = emptyList(),
)

/** Grouped by the module the decision LIVES IN — the place you'd go to change it. */
@Serializable
data class PlanningRecapGroup(
    val key: String,
    val label: String = "",
    val headline: String = "",
    val detail: String = "",
    val count: Int = 0,
    val stepKey: String? = null,
)

@Serializable
data class PlanningRecapLastCall(
    val id: String,
    val note: String = "",
    val detail: String? = null,
)

/** Left alone ON PURPOSE. `badge` is a String: a newer server's fourth badge renders as itself. */
@Serializable
data class PlanningRecapLeftAlone(
    val key: String,
    val label: String = "",
    val detail: String = "",
    val badge: String = "",
    val stepKey: String? = null,
)

/** Derived server-side on every read, so the header and the cards cannot disagree. */
@Serializable
data class PlanningRecapCounts(
    val decisions: Int = 0,
    val deferred: Int = 0,
    val parked: Int = 0,
)

@Serializable
data class PlanningRecapWeekTarget(
    val goalId: String,
    val title: String = "",
    val emoji: String? = null,
    val unit: String? = null,
    val target: Double = 0.0,
    val done: Double = 0.0,
)

@Serializable
data class PlanningRecapView(
    val weekStart: String = "",
    val savedAt: String? = null,
    val days: List<PlanningRecapDay> = emptyList(),
    val groups: List<PlanningRecapGroup> = emptyList(),
    val lastCall: List<PlanningRecapLastCall> = emptyList(),
    val lastCallMore: Int = 0,
    val leftAlone: List<PlanningRecapLeftAlone> = emptyList(),
    val counts: PlanningRecapCounts = PlanningRecapCounts(),
    val lastWeekTargets: List<PlanningRecapWeekTarget> = emptyList(),
)

class PlanningRecapApi(private val http: PlanningHttp) {
    /** With a session, ITS week wins server-side; `weekStart` still goes through the week gate. */
    suspend fun recap(sessionId: String?, weekStart: String?): PlanningRecapView =
        http.get("api/weekly-planning/recap" + PlanningHttp.query("sessionId" to sessionId, "weekStart" to weekStart))
}

/**
 * The receipt's crumb: INTEGERS ONLY — how MANY decisions, never WHAT, since a copied title
 * goes stale. Null until a read lands, or the affirmative writes zeroes over a real week.
 * Keys match the web's `planningRecapDecision`.
 */
object PlanningRecapCrumb {
    fun decision(view: PlanningRecapView?): JsonObject? {
        view ?: return null
        return buildJsonObject {
            put(
                "counts",
                buildJsonObject {
                    put("decisions", view.counts.decisions)
                    put("deferred", view.counts.deferred)
                    put("parked", view.counts.parked)
                },
            )
        }
    }
}
