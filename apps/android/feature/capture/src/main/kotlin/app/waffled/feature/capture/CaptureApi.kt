package app.waffled.feature.capture

import app.waffled.core.model.Currency
import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What `POST /api/capture` answered. `fallback` = the server had no usable LLM read. */
data class CaptureParseResult(val intent: CaptureIntent?, val via: String, val fallback: Boolean)

/** A row a mutate could act on. [meta] is a resolver blob that MUST go back to `/commit` unchanged. */
@Serializable
data class CaptureCandidate(
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val confidence: Double = 0.0,
    val meta: Map<String, JsonElement>? = null,
)

/**
 * `/api/capture/resolve`. Three "empty" shapes, all 200: unregistered kind/verb →
 * [unsupported] + reason; disabled module → reason alone; no match → bare empty list.
 */
@Serializable
data class CaptureResolveResponse(
    val candidates: List<CaptureCandidate> = emptyList(),
    val disabledReason: String? = null,
    val unsupported: Boolean = false,
)

/** The slice of a list the capture picker needs. */
@Serializable
data class CaptureList(
    val id: String,
    val name: String,
    val emoji: String? = null,
    val listType: String = "custom",
) {
    val isGrocery: Boolean get() = listType.equals("grocery", ignoreCase = true)
}

@Serializable
data class CaptureRecipeRef(val id: String, val title: String? = null)

/** Everything the capture sheet talks to — a seam so [CaptureModel] tests run without a server. */
interface CaptureService {
    suspend fun parse(text: String): CaptureParseResult
    suspend fun warm()
    suspend fun resolve(verb: String, targetKind: String?, description: String, args: Map<String, JsonElement>): CaptureResolveResponse
    suspend fun commitMutate(verb: String, targetKind: String?, targetId: String, args: Map<String, JsonElement>, meta: Map<String, JsonElement>?): String
    suspend fun lists(): List<CaptureList>
    suspend fun currencies(): List<Currency>
    suspend fun recipes(): List<CaptureRecipeRef>
    suspend fun createEvent(
        title: String, startsAtIso: String, endsAtIso: String?, allDay: Boolean, personIds: List<String>,
        timezone: String?, rrule: String?, recurrenceEndAt: String?,
    )
    suspend fun addGroceryItem(name: String)
    suspend fun createChore(title: String, personId: String?, rewardAmount: Int?, rewardCurrency: String?, rrule: String?)
    suspend fun planMeal(date: String, mealType: String, recipeId: String?, title: String?)
    suspend fun createList(name: String): CaptureList
    suspend fun addListItem(listId: String, name: String, quantity: String?)
    suspend fun createCountdown(title: String, date: String, emoji: String?)
    suspend fun createPerson(name: String, memberType: String, avatarEmoji: String?, birthday: String?, isAdmin: Boolean)
    suspend fun createGoal(
        title: String, goalType: String, trackingMode: String, targetValue: Double?, unit: String?,
        deadline: String?, participantIds: List<String>,
    )
    suspend fun createPantryItem(name: String, amount: String?, unit: String?, location: String, expiresOn: String?, lowAt: Double?)
    suspend fun createReward(title: String, emoji: String?, cost: Int?, requiresApproval: Boolean?)
}

/**
 * The capture slice of the API — the Kotlin port of the capture + capture-commit calls
 * in iOS `WaffledAPI.swift`. Each create mirrors the body iOS sends; a few routes are also
 * called by their owning feature's own Api, by design (no cross-feature dependency).
 */
class CaptureApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) : CaptureService {

    @Serializable private data class ParseEnvelope(val intent: JsonElement? = null, val via: String = "heuristic", val fallback: Boolean = false)
    @Serializable private data class CommitEnvelope(val message: String = "")
    @Serializable private data class ListsEnvelope(val lists: List<CaptureList> = emptyList())
    @Serializable private data class ListEnvelope(val list: CaptureList)
    @Serializable private data class CurrenciesEnvelope(val currencies: List<Currency> = emptyList())
    @Serializable private data class RecipesEnvelope(val recipes: List<CaptureRecipeRef> = emptyList())

    override suspend fun parse(text: String): CaptureParseResult {
        val r = send<ParseEnvelope>(HttpMethod.Post, "api/capture") { json(buildJsonObject { put("text", text) }) }
        return CaptureParseResult(CaptureIntent.fromJson(r.intent), r.via, r.fallback)
    }

    /** Preload the model so the first parse isn't a cold start. Fire-and-forget. */
    override suspend fun warm() {
        runCatching { sendUnit(HttpMethod.Post, "api/capture/warm") { json(JsonObject(emptyMap())) } }
    }

    override suspend fun resolve(
        verb: String,
        targetKind: String?,
        description: String,
        args: Map<String, JsonElement>,
    ): CaptureResolveResponse = send(HttpMethod.Post, "api/capture/resolve") {
        json(
            buildJsonObject {
                put("verb", verb)
                put("targetKind", targetKind?.let(::JsonPrimitive) ?: JsonNull)
                put("target", buildJsonObject { put("description", description) })
                put("args", JsonObject(args))
            },
        )
    }

    override suspend fun commitMutate(
        verb: String,
        targetKind: String?,
        targetId: String,
        args: Map<String, JsonElement>,
        meta: Map<String, JsonElement>?,
    ): String = send<CommitEnvelope>(HttpMethod.Post, "api/capture/commit") {
        json(
            buildJsonObject {
                put("verb", verb)
                put("targetKind", targetKind?.let(::JsonPrimitive) ?: JsonNull)
                put("targetId", targetId)
                put("args", JsonObject(args))
                if (meta != null) put("meta", JsonObject(meta))
            },
        )
    }.message

    override suspend fun lists(): List<CaptureList> =
        send<ListsEnvelope>(HttpMethod.Get, "api/lists").lists.filterNot { it.listType.equals("template", ignoreCase = true) }

    override suspend fun currencies(): List<Currency> = send<CurrenciesEnvelope>(HttpMethod.Get, "api/currencies").currencies

    override suspend fun recipes(): List<CaptureRecipeRef> = send<RecipesEnvelope>(HttpMethod.Get, "api/recipes").recipes

    override suspend fun createEvent(
        title: String,
        startsAtIso: String,
        endsAtIso: String?,
        allDay: Boolean,
        personIds: List<String>,
        timezone: String?,
        rrule: String?,
        recurrenceEndAt: String?,
    ) = sendUnit(HttpMethod.Post, "api/events") {
        json(
            buildJsonObject {
                put("title", title)
                put("startsAt", startsAtIso)
                put("allDay", allDay)
                put("isCountdown", false)
                endsAtIso?.let { put("endsAt", it) }
                // The FIRST participant is the owner — the server routes the calendar off it.
                personIds.firstOrNull()?.let { put("personId", it) }
                if (personIds.isNotEmpty()) put("participantIds", JsonArray(personIds.map(::JsonPrimitive)))
                timezone?.let { put("timezone", it) }
                rrule?.takeIf { it.isNotEmpty() }?.let { put("rrule", it) }
                recurrenceEndAt?.let { put("recurrenceEndAt", it) }
            },
        )
    }

    override suspend fun addGroceryItem(name: String) =
        sendUnit(HttpMethod.Post, "api/lists/grocery/items") { json(buildJsonObject { put("name", name) }) }

    override suspend fun createChore(title: String, personId: String?, rewardAmount: Int?, rewardCurrency: String?, rrule: String?) =
        sendUnit(HttpMethod.Post, "api/chores") {
            json(
                buildJsonObject {
                    put("title", title)
                    // Explicit null = "up for grabs"; the route reads a missing key the same, but iOS sends it.
                    put("personId", personId?.let(::JsonPrimitive) ?: JsonNull)
                    rewardAmount?.let { put("rewardAmount", it) }
                    rewardCurrency?.takeIf { it.isNotEmpty() }?.let { put("rewardCurrency", it) }
                    rrule?.takeIf { it.isNotEmpty() }?.let { put("rrule", it) }
                },
            )
        }

    override suspend fun planMeal(date: String, mealType: String, recipeId: String?, title: String?) =
        sendUnit(HttpMethod.Post, "api/meals/plan") {
            json(
                buildJsonObject {
                    put("date", date)
                    put("mealType", mealType)
                    recipeId?.let { put("recipeId", it) }
                    title?.let { put("title", it) }
                },
            )
        }

    override suspend fun createList(name: String): CaptureList =
        send<ListEnvelope>(HttpMethod.Post, "api/lists") {
            json(buildJsonObject { put("name", name); put("emoji", JsonNull) })
        }.list

    override suspend fun addListItem(listId: String, name: String, quantity: String?) =
        sendUnit(HttpMethod.Post, "api/lists/$listId/items") {
            json(buildJsonObject { put("name", name); quantity?.takeIf { it.isNotEmpty() }?.let { put("quantity", it) } })
        }

    override suspend fun createCountdown(title: String, date: String, emoji: String?) =
        sendUnit(HttpMethod.Post, "api/countdowns") {
            json(buildJsonObject { put("title", title); put("date", date); emoji?.takeIf { it.isNotEmpty() }?.let { put("emoji", it) } })
        }

    override suspend fun createPerson(name: String, memberType: String, avatarEmoji: String?, birthday: String?, isAdmin: Boolean) =
        sendUnit(HttpMethod.Post, "api/persons") {
            json(
                buildJsonObject {
                    put("name", name)
                    put("memberType", memberType)
                    put("isAdmin", isAdmin)
                    avatarEmoji?.takeIf { it.isNotEmpty() }?.let { put("avatarEmoji", it) }
                    birthday?.takeIf { it.isNotEmpty() }?.let { put("birthday", it) }
                },
            )
        }

    override suspend fun createGoal(
        title: String,
        goalType: String,
        trackingMode: String,
        targetValue: Double?,
        unit: String?,
        deadline: String?,
        participantIds: List<String>,
    ) = sendUnit(HttpMethod.Post, "api/goals") {
        json(
            buildJsonObject {
                put("title", title)
                put("goalType", goalType)
                put("trackingMode", trackingMode)
                // A count is whole; a total keeps its fraction.
                targetValue?.let { if (goalType == "count") put("targetValue", Math.round(it)) else put("targetValue", it) }
                unit?.takeIf { it.isNotEmpty() }?.let { put("unit", it) }
                deadline?.takeIf { it.isNotEmpty() }?.let { put("deadline", it) }
                // Empty = the route scopes the goal to the caller.
                if (participantIds.isNotEmpty()) put("participantIds", JsonArray(participantIds.map(::JsonPrimitive)))
            },
        )
    }

    override suspend fun createPantryItem(name: String, amount: String?, unit: String?, location: String, expiresOn: String?, lowAt: Double?) =
        sendUnit(HttpMethod.Post, "api/pantry") {
            json(
                buildJsonObject {
                    put("name", name)
                    put("location", location)
                    amount?.takeIf { it.isNotEmpty() }?.let { put("amount", it) }
                    unit?.takeIf { it.isNotEmpty() }?.let { put("unit", it) }
                    expiresOn?.takeIf { it.isNotEmpty() }?.let { put("expiresOn", it) }
                    // The route keeps low_at only for a finite threshold >= 0.
                    lowAt?.takeIf { it >= 0 && it.isFinite() }?.let { put("lowAt", it) }
                },
            )
        }

    override suspend fun createReward(title: String, emoji: String?, cost: Int?, requiresApproval: Boolean?) =
        sendUnit(HttpMethod.Post, "api/rewards") {
            json(
                buildJsonObject {
                    put("title", title)
                    cost?.let { put("cost", it) }
                    emoji?.takeIf { it.isNotEmpty() }?.let { put("emoji", it) }
                    // Omitted when null so the route inherits the household default.
                    requiresApproval?.let { put("requiresApproval", it) }
                },
            )
        }

    // ---- plumbing ------------------------------------------------------------------

    private fun HttpRequestBuilder.json(body: JsonObject) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = withContext(Dispatchers.IO) {
        WaffledHttp.authorized(client, tokens, method, path, configure) { it.body<T>() }
    }

    private suspend fun sendUnit(method: HttpMethod, path: String, configure: HttpRequestBuilder.() -> Unit = {}) {
        withContext(Dispatchers.IO) { WaffledHttp.authorized(client, tokens, method, path, configure) { } }
    }
}
