package app.waffled.feature.chores

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * The chores slice of the API — the Kotlin port of the `chores` / `chore-instances` /
 * `chore-proofs` endpoints in `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Chores are **online-only**: none of these tables are in the PowerSync schema, so this
 * slice is the board's entire data path. After any write the caller bumps
 * `RefreshDomain.Chores` on the `RefreshBus`, because no reactive query will do it.
 *
 * Deliberately not a god-object client: each feature module owns the slice it calls, so
 * parallel agents never contend over one file. Everything shared (the Ktor client, the
 * 401 refresh, error text) lives in `core:network`.
 */
class ChoresApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types ------------------------------------------------------------

    /**
     * One chore instance for a given day — a row on the board.
     *
     * Every field past the identity trio has a default, on purpose. The proof and
     * due-time fields arrived in later server releases and Waffled is self-hosted, so a
     * household running an older API must still get a working board rather than a decode
     * failure that blanks the day.
     */
    @Serializable
    data class ChoreInstance(
        val id: String,
        val choreId: String,
        val choreTitle: String,
        val emoji: String? = null,
        val personId: String? = null,
        val personName: String? = null,
        /** `pending` | `done` | `awaiting`. */
        val status: String = STATUS_PENDING,
        val rewardAmount: Int = 0,
        /** Currency key (e.g. `stars`); null means the household default. */
        val rewardCurrency: String? = null,
        val rrule: String? = null,
        /**
         * The day this instance is due (`yyyy-MM-dd`). A one-off that has rolled over
         * keeps its ORIGINAL due day, which is how the client can say how overdue it is.
         */
        val dueOn: String? = null,
        /** Optional time of day, as `HH:mm` (24h). Null = no set time. */
        val dueTime: String? = null,
        val requiresApproval: Boolean = false,
        val streak: Int = 0,
        /** The chore needs a snapshot of the finished job to complete. */
        val requiresPhoto: Boolean = false,
        /** The (possibly relative) proof URL once a photo is attached. */
        val proofUrl: String? = null,
        /**
         * Whether a proof was ever attached. Proofs expire server-side, so this outlives
         * [proofUrl] and lets the UI say the photo is gone rather than that there never
         * was one.
         */
        val hadProof: Boolean = false,
    ) {
        val isDone: Boolean get() = status == STATUS_DONE
        val isAwaiting: Boolean get() = status == STATUS_AWAITING
        val isPending: Boolean get() = status == STATUS_PENDING
    }

    /** A household reward currency (stars, sticks, …) — symbol/label/colour for display. */
    @Serializable
    data class Currency(
        val key: String,
        val label: String,
        val symbol: String,
        val color: String? = null,
        val isDefault: Boolean = false,
        val spendable: Boolean = true,
        val sortOrder: Int = 0,
    )

    /**
     * The result of a blob upload: the opaque storage key to hand to [complete], its
     * resolved URL, and the stored content type.
     */
    @Serializable
    data class UploadedMedia(
        val key: String,
        val url: String,
        val contentType: String,
    )

    @Serializable private data class InstancesEnvelope(val instances: List<ChoreInstance> = emptyList())
    @Serializable private data class CurrenciesEnvelope(val currencies: List<Currency> = emptyList())

    @Serializable
    private data class MediaUploadBody(
        @SerialName("data") val data: String,
        val contentType: String,
    )

    // ---- the board ---------------------------------------------------------------

    /** The chore instances for [date] (`yyyy-MM-dd`; the server allows today ±31 days). */
    suspend fun instances(date: String): List<ChoreInstance> =
        send<InstancesEnvelope>(HttpMethod.Get, "api/chore-instances/today") {
            parameter("date", date)
        }.instances

    /**
     * Every completion awaiting a parent's OK, across **all** dates.
     *
     * Deliberately not scoped to the day being viewed: an approval queue that hid
     * yesterday's submissions would quietly strand them.
     */
    suspend fun awaiting(): List<ChoreInstance> =
        send<InstancesEnvelope>(HttpMethod.Get, "api/chore-instances/awaiting").instances

    /** The household's reward currencies, for rendering a chore's reward symbol. */
    suspend fun currencies(): List<Currency> =
        send<CurrenciesEnvelope>(HttpMethod.Get, "api/currencies").currencies

    // ---- completing --------------------------------------------------------------

    /**
     * Tick a chore off.
     *
     * [storageKey] + [contentType] attach a photo proof, which is **required** for a
     * photo-required chore — without one the server answers 422 `ProofRequired`.
     */
    suspend fun complete(id: String, storageKey: String? = null, contentType: String? = null) {
        val body = buildJsonObject {
            if (storageKey != null) put("storageKey", JsonPrimitive(storageKey))
            if (contentType != null) put("contentType", JsonPrimitive(contentType))
        }
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/complete") { jsonBody(body) }
    }

    /** Un-tick a chore (also the way an awaiting one is taken back). */
    suspend fun uncomplete(id: String) {
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/uncomplete") { jsonBody(EMPTY) }
    }

    /** Approve an awaiting completion — the reward lands now. */
    suspend fun approve(id: String) {
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/approve") { jsonBody(EMPTY) }
    }

    /** Send an awaiting completion back to pending. */
    suspend fun reject(id: String) {
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/reject") { jsonBody(EMPTY) }
    }

    // ---- claiming + assigning -----------------------------------------------------

    /** Claim an up-for-grabs chore for a person (who did it). */
    suspend fun claim(id: String, personId: String) {
        val body = buildJsonObject { put("personId", JsonPrimitive(personId)) }
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/claim") { jsonBody(body) }
    }

    /**
     * (Re)assign a chore without completing it; a null [personId] sends it back to
     * up-for-grabs.
     *
     * The body is a [JsonObject], not a data class, because `WaffledJson` sets
     * `explicitNulls = false` — a nullable property would be OMITTED and the server would
     * read "leave the assignee alone" instead of "unassign".
     */
    suspend fun assign(id: String, personId: String?) {
        val body = buildJsonObject {
            put("personId", personId?.let(::JsonPrimitive) ?: JsonNull)
        }
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/assign") { jsonBody(body) }
    }

    // ---- chore definitions ---------------------------------------------------------

    /** Create a chore definition. Body: title, emoji?, personId?, rewardAmount, rrule?, … */
    suspend fun createChore(body: JsonObject) {
        sendUnit(HttpMethod.Post, "api/chores") { jsonBody(body) }
    }

    /**
     * Edit a chore definition — the same fields as create, plus optional `scope` and
     * `instanceId` for a recurring chore (see [ChoreScopePolicy.target]).
     */
    suspend fun updateChore(id: String, body: JsonObject) {
        sendUnit(HttpMethod.Patch, "api/chores/$id") { jsonBody(body) }
    }

    /**
     * Delete one occurrence, this-and-following, or the active series — [body] carries
     * `scope` + `instanceId` (see [ChoreScopePolicy.target]). An empty body keeps the
     * server's default: the entire active series.
     */
    suspend fun deleteChore(id: String, body: JsonObject = EMPTY) {
        if (body.isEmpty()) {
            sendUnit(HttpMethod.Delete, "api/chores/$id")
        } else {
            sendUnit(HttpMethod.Delete, "api/chores/$id") { jsonBody(body) }
        }
    }

    // ---- stored proofs ---------------------------------------------------------------

    /** Delete one stored proof photo (drops the blob, keeps the chore's `hadProof` flag). */
    suspend fun deleteProof(instanceId: String) {
        sendUnit(HttpMethod.Delete, "api/chore-proofs/$instanceId")
    }

    // ---- media ------------------------------------------------------------------------

    /**
     * Upload image bytes (base64) to the blob store, then hand the key to [complete].
     *
     * The container server buffers request bodies to a string, so uploads go as base64
     * inside JSON rather than as multipart — see `apps/api/src/modules/media/media.ts`.
     * Encode with `MediaImageEncoder`; it already downscales under the server's cap.
     */
    suspend fun uploadMedia(base64Data: String, contentType: String): UploadedMedia =
        send<UploadedMedia>(HttpMethod.Post, "api/media") {
            contentType(ContentType.Application.Json)
            setBody(MediaUploadBody(data = base64Data, contentType = contentType))
        }

    // ---- the request helper every feature slice copies -------------------------------

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

    /** As [send], for a response whose body we don't decode (often a 204). */
    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit = {},
    ) {
        execute(method, path, configure) { }
    }

    /**
     * Build → authorise → send → unwrap.
     *
     * The bearer token is attached per request (it rotates, so it can't be baked into the
     * client's `defaultRequest`), and the token that was actually sent is handed to
     * [WaffledHttp.unwrap] so a **staggered** 401 stays cheap — a caller that is merely
     * behind gets the current token rather than triggering a second rotation of a
     * single-use refresh token.
     */
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

    companion object {
        const val STATUS_PENDING = "pending"
        const val STATUS_DONE = "done"
        const val STATUS_AWAITING = "awaiting"

        private val EMPTY = JsonObject(emptyMap())
    }
}

/** Attach a pre-built JSON tree as the request body. */
private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
