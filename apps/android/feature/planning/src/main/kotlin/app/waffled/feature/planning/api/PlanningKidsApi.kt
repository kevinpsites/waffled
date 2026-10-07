package app.waffled.feature.planning.api

import app.waffled.feature.goals.GoalsApi
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Weekly Planning · step 9 "Kids" — wire types and the three endpoints. Port of iOS
// `PlanningKidsAPI.swift`. No module gate: the step reads goals AND chores, which a
// household toggles separately.

/**
 * One answer on `/kids/answer`, in FOUR states a nullable String cannot say: [Absent]
 * leaves the other answer alone (no key), [Clear] forgets it (explicit null), [Key] picks
 * an offered option, [Text] is their own words.
 */
sealed interface PlanningKidPick {
    data object Absent : PlanningKidPick
    data object Clear : PlanningKidPick
    data class Key(val key: String) : PlanningKidPick
    data class Text(val text: String) : PlanningKidPick

    /** What goes in the body, or null for "no key at all". */
    val wireValue: JsonElement?
        get() = when (this) {
            Absent -> null
            Clear -> JsonNull
            is Key -> buildJsonObject { put("key", key) }
            is Text -> buildJsonObject { put("text", text) }
        }
}

@Serializable
data class PlanningKidFocusOption(
    val key: String,
    val source: String,
    val id: String? = null,
    val emoji: String = "",
    val label: String = "",
    val detail: String? = null,
    val routed: Boolean = false,
    /** The whole goal, so the number is read through `GoalDisplay`, not `totalProgress`. */
    val goal: GoalsApi.Goal? = null,
)

@Serializable
data class PlanningKidForwardOption(
    val key: String,
    val eventId: String? = null,
    val emoji: String = "",
    val label: String = "",
    val `when`: String = "",
)

@Serializable
data class PlanningKidEvent(
    val id: String,
    val title: String = "",
    val `when`: String = "",
    val startsAt: String = "",
    val allDay: Boolean = false,
)

@Serializable
data class PlanningKidChore(
    val id: String,
    val title: String = "",
    val emoji: String? = null,
    val `when`: String = "",
    val late: Boolean = false,
)

@Serializable
data class PlanningKidFocus(
    val source: String,
    val id: String? = null,
    val emoji: String = "",
    val label: String = "",
    val detail: String? = null,
)

@Serializable
data class PlanningKidForward(
    val eventId: String? = null,
    val emoji: String = "",
    val label: String = "",
    val `when`: String = "",
)

@Serializable
data class PlanningKidCard(
    val personId: String,
    val name: String = "",
    val avatarEmoji: String? = null,
    val colorHex: String? = null,
    val age: Int? = null,
    /** Null when the reward economy is off. NEVER draw a zero in its place. */
    val stars: Int? = null,
    val starsSymbol: String? = null,
    val week: List<PlanningKidEvent> = emptyList(),
    val chores: List<PlanningKidChore> = emptyList(),
    val focusOptions: List<PlanningKidFocusOption> = emptyList(),
    val forwardOptions: List<PlanningKidForwardOption> = emptyList(),
    val focus: PlanningKidFocus? = null,
    val forward: PlanningKidForward? = null,
    val settled: Boolean = false,
)

@Serializable
data class PlanningKidsSources(val goals: Boolean = false, val chores: Boolean = false, val rewards: Boolean = false)

@Serializable
data class PlanningKidsView(
    val weekStart: String = "",
    val kids: List<PlanningKidCard> = emptyList(),
    val sources: PlanningKidsSources = PlanningKidsSources(),
    val canRepeat: Boolean = false,
)

class PlanningKidsApi(private val http: PlanningHttp) {

    /** `weekStart` is for the sessionless case: with a session, ITS week wins server-side. */
    suspend fun kids(sessionId: String, weekStart: String?): PlanningKidsView =
        http.get("api/weekly-planning/kids" + PlanningHttp.query("sessionId" to sessionId, "weekStart" to weekStart))

    suspend fun answer(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick = PlanningKidPick.Absent,
        forward: PlanningKidPick = PlanningKidPick.Absent,
    ): PlanningKidsView = http.send(
        HttpMethod.Put,
        "api/weekly-planning/kids/answer",
        answerBody(sessionId, personId, weekStart, focus, forward),
    )

    suspend fun repeat(sessionId: String, weekStart: String?): PlanningKidsView = http.send(
        HttpMethod.Post,
        "api/weekly-planning/kids/repeat",
        buildJsonObject {
            put("sessionId", sessionId)
            if (!weekStart.isNullOrEmpty()) put("weekStart", weekStart)
        },
    )

    companion object {
        fun answerBody(
            sessionId: String,
            personId: String,
            weekStart: String?,
            focus: PlanningKidPick,
            forward: PlanningKidPick,
        ): JsonObject = buildJsonObject {
            put("sessionId", sessionId)
            put("personId", personId)
            if (!weekStart.isNullOrEmpty()) put("weekStart", weekStart)
            // Absent puts NO key; Clear puts an explicit null. That difference is the contract.
            focus.wireValue?.let { put("focus", it) }
            forward.wireValue?.let { put("forward", it) }
        }
    }
}

/**
 * The crumb for the session record. It MUST MIRROR the server's own map: `/kids/answer`
 * merges `{ kids: { <personId>: … } }` but the shell's `decideStep` REPLACES `data`, and
 * the server's `parseAnswers` reads these exact key names back. Same as the web's
 * `planningKidsDecision`.
 */
object PlanningKidsCrumb {
    fun decision(view: PlanningKidsView?): JsonObject = buildJsonObject {
        put(
            "kids",
            buildJsonObject {
                view?.kids.orEmpty().filter { it.focus != null || it.forward != null }.forEach { k ->
                    put(
                        k.personId,
                        buildJsonObject {
                            put("focus", k.focus?.let(::focusJson) ?: JsonNull)
                            put("forward", k.forward?.let(::forwardJson) ?: JsonNull)
                        },
                    )
                }
            },
        )
    }

    private fun focusJson(f: PlanningKidFocus) = buildJsonObject {
        put("source", f.source)
        put("id", f.id.json())
        put("emoji", f.emoji)
        put("label", f.label)
        put("detail", f.detail.json())
    }

    private fun forwardJson(f: PlanningKidForward) = buildJsonObject {
        put("eventId", f.eventId.json())
        put("emoji", f.emoji)
        put("label", f.label)
        put("when", f.`when`)
    }
}

object PlanningKidsChoice {
    fun focusChosen(card: PlanningKidCard, option: PlanningKidFocusOption): Boolean {
        val focus = card.focus ?: return false
        return focus.source == option.source && focus.id == option.id
    }

    fun focusIsCustom(card: PlanningKidCard): Boolean = card.focus?.source == "custom"

    /** Guarded against both-nil: a bare id compare reads TRUE for every option when unanswered. */
    fun forwardChosen(card: PlanningKidCard, option: PlanningKidForwardOption): Boolean {
        val answered = card.forward?.eventId ?: return false
        val offered = option.eventId ?: return false
        return answered == offered
    }

    fun forwardIsCustom(card: PlanningKidCard): Boolean = card.forward?.let { it.eventId == null } ?: false
}

private fun String?.json(): JsonElement = this?.let(::JsonPrimitive) ?: JsonNull
