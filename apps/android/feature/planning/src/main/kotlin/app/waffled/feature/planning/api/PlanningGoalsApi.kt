package app.waffled.feature.planning.api

import app.waffled.core.network.WaffledJson
import app.waffled.feature.goals.GoalsApi
import io.ktor.http.HttpMethod
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

// Weekly Planning · step 6 "Goals" — wire types and endpoints. Port of iOS
// `PlanningGoalsAPI.swift`. One read over the existing goal lists plus two writes; the
// focus is the goals module's own `is_featured`, and `settled`/`focusGoalId` are the
// SESSION's memory of what it decided.

@Serializable
data class PlanningGoalPace(
    val text: String,
    /** "ok" | "flat" | "behind" — a String so a newer tone renders neutral, never fails. */
    val tone: String,
)

/**
 * One choosable goal: the goals module's own [GoalsApi.Goal] plus the step's extras, all
 * in ONE flat object on the wire — hence the hand-written serializer.
 */
@Serializable(with = PlanningGoalGoalSerializer::class)
data class PlanningGoalGoal(
    val goal: GoalsApi.Goal,
    val pace: PlanningGoalPace? = null,
    /** Only a running count or total takes a week's target. Absent from an older server. */
    val weekTargetable: Boolean = false,
    val weekTarget: Double? = null,
    val weekDone: Double = 0.0,
) {
    val id: String get() = goal.id
}

internal object PlanningGoalGoalSerializer : KSerializer<PlanningGoalGoal> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): PlanningGoalGoal {
        val json = (decoder as JsonDecoder).json
        val obj = decoder.decodeJsonElement().jsonObject
        fun prim(key: String): JsonPrimitive? = (obj[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }
        return PlanningGoalGoal(
            goal = json.decodeFromJsonElement(GoalsApi.Goal.serializer(), obj),
            pace = (obj["pace"] as? JsonObject)?.let { json.decodeFromJsonElement(PlanningGoalPace.serializer(), it) },
            weekTargetable = prim("weekTargetable")?.booleanOrNull ?: false,
            weekTarget = prim("weekTarget")?.doubleOrNull,
            weekDone = prim("weekDone")?.doubleOrNull ?: 0.0,
        )
    }

    override fun serialize(encoder: Encoder, value: PlanningGoalGoal) {
        val goal = WaffledJson.encodeToJsonElement(GoalsApi.Goal.serializer(), value.goal).jsonObject
        val out = buildJsonObject {
            goal.forEach { (k, v) -> put(k, v) }
            value.pace?.let { put("pace", WaffledJson.encodeToJsonElement(PlanningGoalPace.serializer(), it)) }
            put("weekTargetable", value.weekTargetable)
            value.weekTarget?.let { put("weekTarget", it) }
            put("weekDone", value.weekDone)
        }
        encoder.encodeSerializableValue(JsonElement.serializer(), out)
    }
}

@Serializable
data class PlanningGoalMember(
    val personId: String,
    val name: String = "",
    val avatarEmoji: String? = null,
    val colorHex: String? = null,
    val age: Int? = null,
)

@Serializable
data class PlanningGoalGroup(
    /** `listId`, not `id`, so a tab can never be confused with a goal. */
    val listId: String,
    val name: String = "",
    val emoji: String? = null,
    val colorHex: String? = null,
    val isPrivate: Boolean = false,
    val sortOrder: Int = 0,
    val members: List<PlanningGoalMember> = emptyList(),
    val isEveryone: Boolean = false,
    val goals: List<PlanningGoalGoal> = emptyList(),
    val settled: Boolean = false,
    val focusGoalId: String? = null,
)

@Serializable
data class PlanningGoalsView(val groups: List<PlanningGoalGroup> = emptyList())

/** The group in the shape the goals editor speaks, so participants follow the list. */
fun PlanningGoalGroup.asGoalList(): GoalsApi.GoalList = GoalsApi.GoalList(
    id = listId,
    name = name,
    emoji = emoji,
    colorHex = colorHex,
    goalCount = goals.size,
    members = members.map { GoalsApi.GoalList.Member(it.personId, it.name, it.avatarEmoji, it.colorHex) },
)

class PlanningGoalsApi(private val http: PlanningHttp) {

    suspend fun goals(sessionId: String): PlanningGoalsView =
        http.get("api/weekly-planning/goals" + PlanningHttp.query("sessionId" to sessionId))

    /** `goalId` null is "nothing this week"; the server reads null, "" and absence alike. */
    suspend fun setFocus(sessionId: String, listId: String, goalId: String?): PlanningGoalsView =
        http.send(
            HttpMethod.Put,
            "api/weekly-planning/goals/focus",
            buildJsonObject {
                put("sessionId", sessionId)
                put("listId", listId)
                put("goalId", goalId?.let(::JsonPrimitive) ?: JsonNull)
            },
        )

    /** One goal's target for the session's week; `target` null clears it. */
    suspend fun setWeekTarget(sessionId: String, goalId: String, target: Double?): PlanningGoalsView =
        http.send(
            HttpMethod.Put,
            "api/weekly-planning/goals/week-target",
            buildJsonObject {
                put("sessionId", sessionId)
                put("goalId", goalId)
                put("target", target?.let(::JsonPrimitive) ?: JsonNull)
            },
        )
}

/**
 * The crumb this step hands the session record. IT MUST MIRROR THE SERVER'S OWN MAP:
 * `/goals/focus` merges `{ focus: { listId: goalId|null } }` onto the step row, but the
 * shell's `decideStep` REPLACES `data`, so a summarising crumb would erase what every
 * mid-step write persisted. Kept identical to the web's `planningGoalsDecision`.
 */
object PlanningGoalsCrumb {
    fun decision(view: PlanningGoalsView?): JsonObject = buildJsonObject {
        put(
            "focus",
            buildJsonObject {
                // SETTLED GROUPS ONLY: an unsettled group's `focusGoalId` may be a pre-existing
                // pin the server merely adopted for display.
                view?.groups.orEmpty().filter { it.settled }.forEach { g ->
                    put(g.listId, g.focusGoalId?.let(::JsonPrimitive) ?: JsonNull)
                }
            },
        )
    }
}
