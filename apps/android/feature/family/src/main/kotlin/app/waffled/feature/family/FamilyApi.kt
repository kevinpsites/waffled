package app.waffled.feature.family

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * The Family slice of the API: the hub's tile feeds, the approvals queue, and the person
 * spotlight (`GET /api/persons/:id/overview`).
 *
 * Some endpoints are also called by the Chores and Rewards slices. Each feature owns the
 * slice it calls so no feature depends on another; the wire types here decode only what
 * Family draws, and every field past an identity has a default so an older self-hosted
 * server still decodes.
 */
class FamilyApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- hub tile feeds ----------------------------------------------------------

    /** A person's chore tally for today. */
    @Serializable
    data class PersonChores(
        val id: String,
        val name: String = "",
        val avatarEmoji: String? = null,
        val colorHex: String? = null,
        val total: Int = 0,
        val done: Int = 0,
        val stars: Int = 0,
    )

    @Serializable data class GoalRef(val id: String, val isFeatured: Boolean = false)
    @Serializable data class ListRef(val id: String)
    @Serializable data class FamilyStars(val name: String? = null, val stars: Int = 0)
    @Serializable data class PhotoRef(val id: String, val memory: String? = null)

    @Serializable private data class PeopleChores(val people: List<PersonChores> = emptyList())
    @Serializable private data class Goals(val goals: List<GoalRef> = emptyList())
    @Serializable private data class Lists(val lists: List<ListRef> = emptyList())
    @Serializable private data class Stars(val people: List<FamilyStars> = emptyList())
    @Serializable private data class Photos(val photos: List<PhotoRef> = emptyList())

    suspend fun choresToday(): List<PersonChores> = send<PeopleChores>(HttpMethod.Get, "api/chores/today").people
    suspend fun goals(): List<GoalRef> = send<Goals>(HttpMethod.Get, "api/goals").goals
    suspend fun lists(): List<ListRef> = send<Lists>(HttpMethod.Get, "api/lists").lists
    suspend fun familyStars(): List<FamilyStars> = send<Stars>(HttpMethod.Get, "api/family/overview").people
    suspend fun photos(): List<PhotoRef> = send<Photos>(HttpMethod.Get, "api/photos").photos

    // ---- approvals ---------------------------------------------------------------

    /** A reward purchase, with a snapshot of the reward as it was when asked for. */
    @Serializable
    data class Redemption(
        val id: String,
        val rewardId: String = "",
        val personId: String = "",
        val personName: String? = null,
        val personAvatar: String? = null,
        val personColor: String? = null,
        val title: String = "",
        val emoji: String? = null,
        val cost: Int = 0,
        val currency: String = "",
        val status: String = "pending",
        val createdAt: String = "",
    )

    /**
     * One chore instance. Field names match the Chores slice's `ChoreInstance` one for one,
     * so `app` can hand a row to that module's proof views with a plain field copy.
     */
    @Serializable
    data class ChoreInstance(
        val id: String,
        val choreId: String = "",
        val choreTitle: String = "",
        val emoji: String? = null,
        val personId: String? = null,
        val personName: String? = null,
        /** `pending` | `done` | `awaiting`. */
        val status: String = "pending",
        val rewardAmount: Int = 0,
        val rewardCurrency: String? = null,
        val rrule: String? = null,
        val dueOn: String? = null,
        val dueTime: String? = null,
        val requiresApproval: Boolean = false,
        val streak: Int = 0,
        val requiresPhoto: Boolean = false,
        val proofUrl: String? = null,
        val hadProof: Boolean = false,
    )

    @Serializable private data class Redemptions(val redemptions: List<Redemption> = emptyList())
    @Serializable private data class Instances(val instances: List<ChoreInstance> = emptyList())

    suspend fun pendingRedemptions(): List<Redemption> =
        send<Redemptions>(HttpMethod.Get, "api/redemptions") { parameter("status", "pending") }.redemptions

    /** Every completion awaiting a parent's OK, across all dates — the queue never hides yesterday. */
    suspend fun awaitingChores(): List<ChoreInstance> =
        send<Instances>(HttpMethod.Get, "api/chore-instances/awaiting").instances

    suspend fun approveRedemption(id: String) = sendUnit(HttpMethod.Post, "api/redemptions/$id/approve")
    suspend fun denyRedemption(id: String) = sendUnit(HttpMethod.Post, "api/redemptions/$id/deny")
    suspend fun approveChore(id: String) = sendUnit(HttpMethod.Post, "api/chore-instances/$id/approve")
    suspend fun rejectChore(id: String) = sendUnit(HttpMethod.Post, "api/chore-instances/$id/reject")

    // ---- the person spotlight ----------------------------------------------------

    suspend fun choreInstances(date: String): List<ChoreInstance> =
        send<Instances>(HttpMethod.Get, "api/chore-instances/today") { parameter("date", date) }.instances

    suspend fun completeChore(id: String) = sendUnit(HttpMethod.Post, "api/chore-instances/$id/complete")
    suspend fun uncompleteChore(id: String) = sendUnit(HttpMethod.Post, "api/chore-instances/$id/uncomplete")

    /**
     * A person's spotlight. [PersonOverview.raw] keeps the whole response so the rewards
     * slot can decode its own saving-toward types from it without a second fetch.
     */
    suspend fun personOverview(personId: String): PersonOverview {
        val raw = send<JsonObject>(HttpMethod.Get, "api/persons/$personId/overview")
        return WaffledJson.decodeFromJsonElement<PersonOverview>(raw).copy(raw = raw)
    }

    @Serializable
    data class PersonOverview(
        val person: Person,
        val stars: Int = 0,
        val topStreak: Int = 0,
        val currencies: List<Currency> = emptyList(),
        val balances: List<Balance> = emptyList(),
        val goals: List<Goal> = emptyList(),
        val categoryBalance: List<CategoryBalance> = emptyList(),
        val insight: Insight? = null,
        val recentLedger: List<LedgerEntry> = emptyList(),
        val redemptions: List<OwnRedemption> = emptyList(),
        /**
         * Kept as raw JSON and parsed leniently: the card is optional (null unless
         * `weeklyPlanning` is on), so a shape it doesn't expect must drop the card, never
         * the whole spotlight.
         */
        @SerialName("planningFocus") private val planningFocusJson: JsonElement? = null,
        @Transient val raw: JsonObject? = null,
    ) {
        val planningFocus: PlanningFocus?
            get() = planningFocusJson
                ?.takeUnless { it is JsonNull }
                ?.let { runCatching { WaffledJson.decodeFromJsonElement<PlanningFocus>(it) }.getOrNull() }

        @Serializable
        data class Person(
            val id: String,
            val name: String = "",
            val avatarEmoji: String? = null,
            val colorHex: String? = null,
            val age: Int? = null,
            val memberType: String? = null,
        )

        @Serializable
        data class Currency(
            val key: String,
            val label: String = "",
            val symbol: String = "",
            val color: String? = null,
            val isDefault: Boolean = false,
            val sortOrder: Int = 0,
        )

        @Serializable data class Balance(val currency: String, val balance: Int = 0)

        @Serializable
        data class Goal(
            val id: String,
            val title: String = "",
            val emoji: String? = null,
            val category: String? = null,
            val unit: String? = null,
            val goalType: String? = null,
            /** Already on the goal's own axis (a habit's period count, a checklist's steps). */
            val progress: Double? = null,
            val target: Double? = null,
            /** Null for a target-less goal — there is no computable percentage. */
            val pct: Int? = null,
            val streakDays: Int = 0,
        )

        @Serializable
        data class CategoryBalance(
            val category: String,
            val emoji: String = "",
            val label: String = "",
            val goalCount: Int = 0,
            val avgPct: Int = 0,
        )

        @Serializable data class Insight(val text: String = "")

        @Serializable
        data class LedgerEntry(
            val amount: Int = 0,
            val reason: String = "",
            val currency: String = "",
            val detail: String? = null,
            /** Free text on an ad-hoc entry, e.g. a spot award's reason. */
            val note: String? = null,
            val createdAt: String = "",
        ) {
            val id: String get() = createdAt + reason + amount + (detail ?: "")

            /** A chore/reward title when present, else the humanised reason (+ a spot award's note). */
            val label: String
                get() {
                    if (!detail.isNullOrEmpty()) return detail
                    val base = reason.replace('_', ' ')
                    val trimmed = note?.trim()
                    return if (reason == "spot_award" && !trimmed.isNullOrEmpty()) "$base — $trimmed" else base
                }
        }

        @Serializable
        data class OwnRedemption(
            val id: String,
            val title: String = "",
            val emoji: String? = null,
            val cost: Int = 0,
            val currency: String = "",
            val status: String = "",
            val createdAt: String = "",
        )
    }

    /** "This week's one thing" from Weekly Planning's Kids step. */
    @Serializable
    data class PlanningFocus(
        val emoji: String = "",
        val label: String,
        val detail: String? = null,
        val weekStart: String = "",
    )

    // ---- request helper (same shape as every feature slice) ------------------------

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

    /** A write with an empty JSON body — the server rejects a POST with no content type. */
    private suspend fun sendUnit(method: HttpMethod, path: String) {
        execute(method, path, {
            contentType(ContentType.Application.Json)
            setBody(JsonObject(emptyMap()))
        }) { }
    }

    private suspend fun <T> execute(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit,
        parse: suspend (HttpResponse) -> T,
    ): T = withContext(Dispatchers.IO) {
        val sentToken = tokens.accessToken()

        suspend fun attempt(token: String?): HttpResponse = client.request(path) {
            this.method = method
            if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
            configure()
        }

        WaffledHttp.unwrap(
            response = attempt(sentToken),
            tokens = tokens,
            sentToken = sentToken,
            retry = { fresh -> attempt(fresh) },
            parse = parse,
        )
    }
}
