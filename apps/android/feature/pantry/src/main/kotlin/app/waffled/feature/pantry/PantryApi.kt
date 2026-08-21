package app.waffled.feature.pantry

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
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
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/**
 * The pantry slice of the API — the Kotlin port of the `pantry` endpoints in
 * `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Pantry is **online-only**: none of its tables are in the PowerSync schema, so this
 * slice is the module's entire data path. After any write the caller bumps
 * `RefreshDomain.Pantry` on the `RefreshBus`, because no reactive query will do it.
 *
 * Barcodes are resolved by the **server**, which caches and snapshots the Open Food Facts
 * answer (90-day TTL, 30-day stale-while-revalidate) — a client must never call Open Food
 * Facts itself.
 *
 * Deliberately not a god-object client: each feature module owns the slice it calls.
 * Everything shared (the Ktor client, the 401 refresh, error text) lives in
 * `core:network`.
 */
class PantryApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types -----------------------------------------------------------------

    /**
     * Nutrition snapshot, on the product's own serving basis.
     *
     * Every field is optional because Open Food Facts reports only what it has, and the
     * JSON keys are snake_case where the Kotlin names are not.
     */
    @Serializable
    data class Nutrition(
        val calories: Double? = null,
        @SerialName("protein_g") val proteinG: Double? = null,
        @SerialName("fat_g") val fatG: Double? = null,
        @SerialName("carbs_g") val carbsG: Double? = null,
        @SerialName("sodium_mg") val sodiumMg: Double? = null,
    ) {
        val isEmpty: Boolean
            get() = calories == null && proteinG == null && fatG == null &&
                carbsG == null && sodiumMg == null
    }

    /**
     * A stored pantry item: its own fields plus the denormalised product snapshot (all
     * null for an item added by hand without a lookup).
     *
     * `amount` is **free text** — "2", "0.5", "a pinch" — which the server also parses
     * numerically. See [PantryAmount].
     */
    @Serializable
    data class Item(
        val id: String,
        val name: String,
        val amount: String = "",
        val unit: String = "",
        val location: String = "",
        val expiresOn: String? = null,
        val note: String = "",
        val usedUp: Boolean = false,
        val barcode: String? = null,
        val brand: String? = null,
        val imageUrl: String? = null,
        val quantityText: String? = null,
        val servingBasis: String? = null,
        val nutrition: Nutrition? = null,
        val allergens: List<String>? = null,
        val traces: List<String>? = null,
        val dietary: List<String>? = null,
        val source: String? = null,
        val lowAt: Double? = null,
        val isMeal: Boolean? = null,
        val createdAt: String? = null,
        /**
         * When the item entered the pantry (`yyyy-MM-dd`), distinct from [createdAt] (the
         * row's log time). Drives the age chip and the "Been a while" group; backdatable.
         */
        val addedOn: String? = null,
    ) {
        /** Friendly attribution for the database this item came from; null for manual adds. */
        val sourceLabel: String? get() = productSourceLabel(source)
    }

    /** The normalised product a barcode lookup resolves to. */
    @Serializable
    data class Product(
        val barcode: String,
        val name: String? = null,
        val brand: String? = null,
        val imageUrl: String? = null,
        val quantityText: String? = null,
        val servingBasis: String? = null,
        val nutrition: Nutrition = Nutrition(),
        val allergens: List<String> = emptyList(),
        val traces: List<String>? = null,
        val dietary: List<String> = emptyList(),
        val nutriscore: String? = null,
        val nova: Double? = null,
        val source: String = "",
    ) {
        val sourceLabel: String? get() = productSourceLabel(source)

        /**
         * The snapshot fields as a body fragment, merged with the user's
         * name/amount/location/best-by when adding a scanned item. Keeping the snapshot
         * on the item is what lets the detail screen show nutrition and allergens later
         * without another lookup.
         */
        fun snapshotBody(): Map<String, kotlinx.serialization.json.JsonElement> = buildMap {
            put("source", JsonPrimitive(source))
            put("barcode", JsonPrimitive(barcode))
            brand?.let { put("brand", JsonPrimitive(it)) }
            imageUrl?.let { put("imageUrl", JsonPrimitive(it)) }
            quantityText?.let { put("quantityText", JsonPrimitive(it)) }
            servingBasis?.let { put("servingBasis", JsonPrimitive(it)) }
            if (allergens.isNotEmpty()) {
                put("allergens", buildJsonArray { allergens.forEach { add(JsonPrimitive(it)) } })
            }
            traces?.takeIf { it.isNotEmpty() }?.let { list ->
                put("traces", buildJsonArray { list.forEach { add(JsonPrimitive(it)) } })
            }
            if (dietary.isNotEmpty()) {
                put("dietary", buildJsonArray { dietary.forEach { add(JsonPrimitive(it)) } })
            }
            val n = buildJsonObject {
                nutrition.calories?.let { put("calories", JsonPrimitive(it)) }
                nutrition.proteinG?.let { put("protein_g", JsonPrimitive(it)) }
                nutrition.fatG?.let { put("fat_g", JsonPrimitive(it)) }
                nutrition.carbsG?.let { put("carbs_g", JsonPrimitive(it)) }
                nutrition.sodiumMg?.let { put("sodium_mg", JsonPrimitive(it)) }
            }
            if (n.isNotEmpty()) put("nutrition", n)
        }
    }

    /**
     * The `api/pantry` payload: the items plus the household's pantry config — the
     * sections, the allergen avoid-list and its per-person rollup, the running-low
     * threshold, the per-section icons and the "old" threshold.
     */
    @Serializable
    data class ListResponse(
        val items: List<Item> = emptyList(),
        val locations: List<String> = emptyList(),
        val showOnToday: Boolean = true,
        /** The household's declared avoid-list. See [PantryAllergen.avoidSet] — it is only HALF. */
        val avoidAllergens: List<String> = emptyList(),
        /** allergen key → the members who have it. The OTHER half of the avoid-set. */
        val allergenPeople: Map<String, List<String>> = emptyMap(),
        val lowThreshold: Double = 1.0,
        val locationIcons: Map<String, String>? = null,
        /** Household "been a while" threshold in months; the server defaults it to 6. */
        val staleMonths: Double? = null,
    )

    /** A scan upsert's answer: the item, and whether an existing one was incremented. */
    data class ScanResult(val item: Item, val incremented: Boolean)

    /**
     * An on-hand item a just-cooked recipe likely used, with the server's suggested
     * action. [suggested] and the consume mode are [MODE_USED_UP], [MODE_DECREMENT] or
     * [MODE_SKIP]; a skip is never sent to consume.
     */
    @Serializable
    data class RecipeMatch(
        val id: String,
        val name: String,
        val amount: String = "",
        val unit: String = "",
        val isStaple: Boolean = false,
        val suggested: String = MODE_SKIP,
    )

    /** A recipe makeable right now — every non-staple ingredient is on hand. */
    @Serializable
    data class CookReady(
        val recipeId: String,
        val title: String,
        val emoji: String? = null,
        val have: List<String> = emptyList(),
        val expiringItem: String? = null,
    )

    /** One of the top library recipes for an on-hand protein group. */
    @Serializable
    data class CookMainRecipe(
        val recipeId: String,
        val title: String,
        val have: Int = 0,
        val total: Int = 0,
        val missing: List<String> = emptyList(),
    )

    /** An on-hand protein and the library recipes it unlocks. */
    @Serializable
    data class CookMain(
        val protein: String,
        val item: MainItem? = null,
        val count: Int = 0,
        val recipes: List<CookMainRecipe> = emptyList(),
    ) {
        @Serializable
        data class MainItem(
            val name: String,
            val amount: String = "",
            val unit: String = "",
            val expiresOn: String? = null,
        )
    }

    @Serializable
    data class Cookable(
        val ready: List<CookReady> = emptyList(),
        val mains: List<CookMain> = emptyList(),
    )

    /** The result of a blob upload — the key, its resolved URL and the stored type. */
    @Serializable
    data class UploadedMedia(val key: String, val url: String, val contentType: String)

    @Serializable private data class ItemEnvelope(val item: Item)
    @Serializable private data class ItemsEnvelope(val items: List<Item> = emptyList())
    @Serializable private data class ScanEnvelope(val item: Item, val incremented: Boolean = false)
    @Serializable private data class LookupEnvelope(val found: Boolean? = null, val product: Product? = null)
    @Serializable private data class LocationsEnvelope(val locations: List<String> = emptyList())
    @Serializable private data class MatchesEnvelope(val matches: List<RecipeMatch> = emptyList())
    @Serializable private data class MediaUploadBody(val data: String, val contentType: String)

    // ---- reading -----------------------------------------------------------------------

    /** The whole pantry surface in one request: items + the household's config. */
    suspend fun list(): ListResponse = send(HttpMethod.Get, "api/pantry")

    /**
     * Resolve a barcode through our own server (which caches the Open Food Facts answer
     * and its siblings).
     *
     * Returns null when no database recognises the barcode — a real answer, and the cue
     * to offer "add it by name". **Throws** when the lookup itself failed (502/timeout),
     * because that means "try again", not "we don't have it", and collapsing the two
     * would offer to hand-name a product the user could simply rescan in a minute.
     */
    suspend fun lookup(barcode: String): Product? {
        val digits = barcode.filter { it.isDigit() }
        if (digits.isEmpty()) return null
        return try {
            send<LookupEnvelope>(HttpMethod.Get, "api/pantry/lookup/$digits").product
        } catch (e: WaffledApiException) {
            if (e.status == 404) null else throw e
        }
    }

    /**
     * Patch the household's pantry config: the sections, the allergen avoid-list, the
     * running-low threshold, the per-section icons, the "been a while" threshold and the
     * Today-card toggle.
     *
     * A **partial merge** — send only what is changing — and it returns the merged
     * result. The server clamps: `lowThreshold` at or above zero, `staleMonths` an
     * integer from 1 to 60, and unknown allergen keys dropped.
     *
     * Not driven by any screen in this module (Settings owns that surface), but it is a
     * pantry route, so it belongs in the pantry slice rather than being reinvented there.
     */
    suspend fun updateConfig(body: JsonObject): ListResponse =
        send(HttpMethod.Put, "api/pantry/config") { jsonBody(body) }

    /** Recipes makeable now, plus on-hand proteins as "mains". */
    suspend fun cookable(): Cookable = send(HttpMethod.Get, "api/pantry/cookable")

    /** On-hand items a just-cooked recipe likely used, each with a suggested action. */
    suspend fun forRecipe(recipeId: String): List<RecipeMatch> =
        send<MatchesEnvelope>(HttpMethod.Get, "api/pantry/for-recipe/$recipeId").matches

    // ---- writing -------------------------------------------------------------------------

    /** Add an item by hand. */
    suspend fun create(body: JsonObject): Item =
        send<ItemEnvelope>(HttpMethod.Post, "api/pantry") { jsonBody(body) }.item

    /**
     * Scan upsert — a re-scan increments the matching on-hand item (by barcode, else by
     * name) rather than duplicating it.
     */
    suspend fun scan(body: JsonObject): ScanResult =
        send<ScanEnvelope>(HttpMethod.Post, "api/pantry/scan") { jsonBody(body) }
            .let { ScanResult(it.item, it.incremented) }

    /**
     * Partial update.
     *
     * The body is a [JsonObject] rather than a data class because `WaffledJson` sets
     * `explicitNulls = false`: a nullable property would be OMITTED, so "clear the
     * best-by date" would silently reach the server as "leave it alone". Build clearing
     * bodies with [itemBody], which puts an explicit [JsonNull] on the wire.
     */
    suspend fun update(id: String, body: JsonObject): Item =
        send<ItemEnvelope>(HttpMethod.Patch, "api/pantry/$id") { jsonBody(body) }.item

    /** Soft-delete an item. Answers 204. */
    suspend fun delete(id: String) {
        sendUnit(HttpMethod.Delete, "api/pantry/$id")
    }

    /**
     * Append ONE section, so the add and scan sheets can create a place on the fly
     * instead of sending the user to Settings. Returns the full list; an existing name in
     * any casing is a no-op rather than a duplicate — hence [PantrySections.canonical].
     */
    suspend fun addLocation(name: String): List<String> =
        send<LocationsEnvelope>(HttpMethod.Post, "api/pantry/locations") {
            jsonBody(buildJsonObject { put("name", name) })
        }.locations

    /**
     * Apply a confirmed consumption. Each pair either marks the item used-up
     * (recoverable) or knocks one off a countable amount. [MODE_SKIP] rows are dropped
     * here rather than at every call site.
     */
    suspend fun consume(items: List<Pair<String, String>>): List<Item> {
        val body = buildJsonObject {
            putJsonArray("items") {
                for ((id, mode) in items) {
                    if (mode == MODE_SKIP) continue
                    add(
                        buildJsonObject {
                            put("id", id)
                            put("mode", mode)
                        },
                    )
                }
            }
        }
        return send<ItemsEnvelope>(HttpMethod.Post, "api/pantry/consume") { jsonBody(body) }.items
    }

    /**
     * Upload image bytes (base64) to the blob store — used to replace an item's photo.
     *
     * The container server buffers request bodies to a string, so uploads go as base64
     * inside JSON rather than as multipart. Encode with `MediaImageEncoder`.
     */
    suspend fun uploadMedia(base64Data: String, contentType: String): UploadedMedia =
        send(HttpMethod.Post, "api/media") {
            contentType(ContentType.Application.Json)
            setBody(MediaUploadBody(data = base64Data, contentType = contentType))
        }

    // ---- the request helper every feature slice copies -------------------------------------

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
     * [WaffledHttp.unwrap] so a **staggered** 401 stays cheap.
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
        /** Mark the item used-up (recoverable). */
        const val MODE_USED_UP = "used_up"

        /** Knock one off a countable amount; a decrement to zero becomes used-up. */
        const val MODE_DECREMENT = "decrement"

        /** Leave it alone. Never sent to consume — [consume] filters these out. */
        const val MODE_SKIP = "skip"

        /**
         * Attribution labels for the Open * Facts database a product came from, mirroring
         * the web `PRODUCT_SOURCE_LABELS`. Open Food Facts is food-only; the siblings
         * cover the non-food a pantry holds.
         */
        val productSourceLabels: Map<String, String> = mapOf(
            "openfoodfacts" to "Open Food Facts",
            "openbeautyfacts" to "Open Beauty Facts",
            "openproductsfacts" to "Open Products Facts",
            "openpetfoodfacts" to "Open Pet Food Facts",
        )

        /** A friendly credit for a product's source, or null for a manual/unknown add. */
        fun productSourceLabel(source: String?): String? = source?.let { productSourceLabels[it] }

        /**
         * The create/update body for the hand-editable fields.
         *
         * Every clearable field goes out as an explicit [JsonNull] when it is empty. That
         * is the whole point of building this by hand: with `explicitNulls = false` a
         * data class would omit the key, and the server would read the omission as "leave
         * it alone" — so removing a best-by date would appear to do nothing.
         */
        fun itemBody(
            name: String,
            amount: String,
            unit: String,
            location: String,
            note: String,
            expiresOn: String?,
            addedOn: String?,
            lowAt: Double?,
            isMeal: Boolean,
        ): JsonObject = buildJsonObject {
            put("name", name)
            put("amount", amount)
            put("unit", unit)
            put("location", location)
            put("note", note)
            put("expiresOn", expiresOn?.let(::JsonPrimitive) ?: JsonNull)
            put("addedOn", addedOn?.let(::JsonPrimitive) ?: JsonNull)
            put("lowAt", lowAt?.let(::JsonPrimitive) ?: JsonNull)
            put("isMeal", isMeal)
        }

        /** The body for a scanned add: the user's fields plus the product snapshot. */
        fun scanBody(
            name: String,
            amount: String,
            unit: String,
            location: String,
            expiresOn: String?,
            product: Product?,
            barcode: String,
        ): JsonObject = buildJsonObject {
            put("name", name)
            put("amount", amount)
            put("unit", unit)
            put("location", location)
            put("expiresOn", expiresOn?.let(::JsonPrimitive) ?: JsonNull)
            if (product != null) {
                for ((key, value) in product.snapshotBody()) put(key, value)
            } else {
                put("barcode", barcode)
            }
        }

        /** A one-field patch, e.g. bumping the amount or flipping used-up. */
        fun patch(build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject =
            buildJsonObject(build)
    }
}

/** Attach a pre-built JSON tree as the request body. */
private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
