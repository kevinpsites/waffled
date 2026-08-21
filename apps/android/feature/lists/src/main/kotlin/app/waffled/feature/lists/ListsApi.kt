package app.waffled.feature.lists

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
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A PATCH field's three states.
 *
 * The server distinguishes a **missing** key ("leave it alone") from an explicit `null`
 * ("clear it"), and `WaffledJson` is configured with `explicitNulls = false` — so a
 * nullable data-class property would be silently omitted and "clear this" would become
 * "leave it alone". Modelling the tri-state explicitly is what stops that, and it is why
 * every body below is built as a [JsonObject] rather than serialised from a class.
 *
 * iOS spells this as a double-optional (`String??`); Kotlin has no such sugar.
 */
sealed interface Field<out T> {
    /** Don't send the key at all — leave whatever the server has. */
    data object Absent : Field<Nothing>

    /** Send the key. A null [value] clears the field server-side. */
    data class Set<T>(val value: T?) : Field<T>

    companion object {
        /** Sugar for `Set(value)`. */
        fun <T> of(value: T?): Field<T> = Set(value)

        /** `""`/null both mean "clear" for the free-text fields (section, store, quantity). */
        fun blankAsClear(value: String?): Field<String> = Set(value?.takeIf { it.isNotBlank() })
    }
}

/**
 * The Lists / grocery-board / pantry-staples slice of the API — the Kotlin port of the
 * `lists`, `list-items` and `pantry-staples` endpoints in
 * `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Deliberately **not** a god-object client: each feature module owns the slice it calls.
 * Everything shared (the Ktor client, the 401 refresh, error text) lives in `core:network`.
 *
 * Lists are **not** a PowerSync table, so every read here is REST and every write is
 * followed by a `RefreshBus` bump — see [ListDetailModel].
 */
class ListsApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- envelopes -------------------------------------------------------------

    @Serializable private data class ListsEnvelope(val lists: List<ListSummary> = emptyList())
    @Serializable private data class TemplatesEnvelope(val templates: List<ListSummary> = emptyList())
    @Serializable private data class ListEnvelope(val list: ListSummary)
    @Serializable private data class TemplateEnvelope(val template: ListSummary)
    @Serializable private data class ItemsEnvelope(val items: List<ListItemDTO> = emptyList())
    @Serializable private data class ItemEnvelope(val item: ListItemDTO)
    @Serializable private data class BoardEnvelope(val board: GroceryBoardDTO)
    @Serializable private data class StoresEnvelope(val stores: List<String> = emptyList())
    @Serializable private data class StaplesEnvelope(val staples: List<GroceryBoardDTO.Staple> = emptyList())
    @Serializable private data class StapleEnvelope(val staple: GroceryBoardDTO.Staple)
    @Serializable private data class RemovedEnvelope(val removed: Int = 0)

    // ---- the list index --------------------------------------------------------

    /**
     * Every list in the household.
     *
     * Templates are excluded server-side; they are filtered again here so a
     * `listType == "template"` row can never pollute the normal rail even against an
     * older server.
     */
    suspend fun lists(): List<ListSummary> =
        send<ListsEnvelope>(HttpMethod.Get, "api/lists").lists.filterNot { it.isTemplate }

    /** The household's saved list templates (hidden from the normal rail). */
    suspend fun templates(): List<ListSummary> =
        send<TemplatesEnvelope>(HttpMethod.Get, "api/lists/templates").templates

    /** Create a custom list. */
    suspend fun createList(name: String, emoji: String?): ListSummary =
        send<ListEnvelope>(HttpMethod.Post, "api/lists") {
            jsonBody(
                buildJsonObject {
                    put("name", name)
                    // An explicit null is how "no emoji" is expressed; omitting the key
                    // would let the server pick its own default.
                    put("emoji", jsonOrNull(emoji?.takeIf { it.isNotBlank() }))
                },
            )
        }.list

    /**
     * Rename a list / change its emoji.
     *
     * An [emoji] of `""` CLEARS it — the one place on this screen where a blank field has
     * to reach the wire as `null` rather than vanishing.
     */
    suspend fun updateList(id: String, name: String? = null, emoji: Field<String> = Field.Absent): ListSummary =
        send<ListEnvelope>(HttpMethod.Patch, "api/lists/$id") {
            jsonBody(
                buildJsonObject {
                    if (name != null) put("name", name)
                    if (emoji is Field.Set) put("emoji", jsonOrNull(emoji.value?.takeIf { it.isNotBlank() }))
                },
            )
        }.list

    /** Soft-delete a whole list (or a template). */
    suspend fun deleteList(id: String) {
        sendUnit(HttpMethod.Delete, "api/lists/$id")
    }

    /** Mark a plain custom list as a reusable template — converts it in place. */
    suspend fun saveAsTemplate(listId: String): ListSummary =
        send<TemplateEnvelope>(HttpMethod.Post, "api/lists/$listId/save-as-template") {
            jsonBody(buildJsonObject { })
        }.template

    /** Move a template back into the active Lists rail (undo a convert). */
    suspend fun unmarkTemplate(id: String): ListSummary =
        send<ListEnvelope>(HttpMethod.Post, "api/lists/$id/unmark-template") {
            jsonBody(buildJsonObject { })
        }.list

    /** Apply a template → a fresh custom list with everything unchecked. */
    suspend fun applyTemplate(templateId: String, name: String? = null): ListSummary =
        send<ListEnvelope>(HttpMethod.Post, "api/lists/templates/$templateId/apply") {
            jsonBody(
                buildJsonObject {
                    name?.takeIf { it.isNotBlank() }?.let { put("name", it) }
                },
            )
        }.list

    // ---- one list's items ------------------------------------------------------

    /** The items in a list (works for any list, grocery included). */
    suspend fun items(listId: String): List<ListItemDTO> =
        send<ItemsEnvelope>(HttpMethod.Get, "api/lists/$listId").items

    /** Add an item to a non-grocery list. */
    suspend fun addItem(
        listId: String,
        name: String,
        quantity: String? = null,
        section: String? = null,
        store: String? = null,
    ): ListItemDTO = send<ItemEnvelope>(HttpMethod.Post, "api/lists/$listId/items") {
        jsonBody(
            buildJsonObject {
                put("name", name)
                quantity?.takeIf { it.isNotBlank() }?.let { put("quantity", it) }
                // The server's field is `category`; the client calls it `section`.
                section?.takeIf { it.isNotBlank() }?.let { put("category", it) }
                store?.takeIf { it.isNotBlank() }?.let { put("store", it) }
            },
        )
    }.item

    /** Add a grocery item — grocery has its own create route (it is an auto-built list). */
    suspend fun addGroceryItem(name: String, quantity: String? = null, section: String? = null): ListItemDTO =
        send<ItemEnvelope>(HttpMethod.Post, "api/lists/grocery/items") {
            jsonBody(
                buildJsonObject {
                    put("name", name)
                    quantity?.takeIf { it.isNotBlank() }?.let { put("quantity", it) }
                    section?.takeIf { it.isNotBlank() }?.let { put("category", it) }
                },
            )
        }.item

    /**
     * Patch one item.
     *
     * Every free-text field is a [Field]: [Field.Absent] leaves it alone, `Set(null)` (or
     * `Set("")`) clears it. Sending nothing at all is a no-op rather than an empty PATCH.
     */
    suspend fun patchItem(
        id: String,
        name: String? = null,
        quantity: Field<String> = Field.Absent,
        checked: Boolean? = null,
        section: Field<String> = Field.Absent,
        store: Field<String> = Field.Absent,
        priority: Int? = null,
    ) {
        val body = buildJsonObject {
            if (name != null) put("name", name)
            if (quantity is Field.Set) put("quantity", jsonOrNull(quantity.value?.takeIf { it.isNotBlank() }))
            if (checked != null) put("checked", checked)
            if (section is Field.Set) put("category", jsonOrNull(section.value?.takeIf { it.isNotBlank() }))
            if (store is Field.Set) put("store", jsonOrNull(store.value?.takeIf { it.isNotBlank() }))
            if (priority != null) put("priority", priority)
        }
        if (body.isEmpty()) return
        sendUnit(HttpMethod.Patch, "api/list-items/$id") { jsonBody(body) }
    }

    /**
     * Full-detail edit (the Details editor): ALWAYS sets name, quantity, assignee,
     * section, store and priority, sending explicit nulls to clear.
     *
     * Distinct from [patchItem] on purpose — the editor's whole contract is "what you see
     * is what the row becomes", so an emptied field has to clear rather than be skipped.
     */
    suspend fun updateItemDetails(
        id: String,
        name: String,
        quantity: String,
        assignedTo: String?,
        section: String,
        store: String,
        priority: Int,
    ) {
        sendUnit(HttpMethod.Patch, "api/list-items/$id") {
            jsonBody(
                buildJsonObject {
                    put("name", name)
                    put("quantity", jsonOrNull(quantity.takeIf { it.isNotBlank() }))
                    put("assignedTo", jsonOrNull(assignedTo))
                    put("category", jsonOrNull(section.takeIf { it.isNotBlank() }))
                    put("store", jsonOrNull(store.takeIf { it.isNotBlank() }))
                    put("priority", priority)
                },
            )
        }
    }

    /**
     * Bulk-edit section / store / assignee / priority across many items in one call.
     *
     * `Set(null)` clears for the whole selection — e.g. unassigning everything picked.
     */
    suspend fun bulkPatchItems(
        ids: List<String>,
        section: Field<String> = Field.Absent,
        store: Field<String> = Field.Absent,
        assignedTo: Field<String> = Field.Absent,
        priority: Int? = null,
    ) {
        val patch = buildJsonObject {
            if (section is Field.Set) put("section", jsonOrNull(section.value))
            if (store is Field.Set) put("store", jsonOrNull(store.value))
            if (assignedTo is Field.Set) put("assignedTo", jsonOrNull(assignedTo.value))
            if (priority != null) put("priority", priority)
        }
        if (patch.isEmpty() || ids.isEmpty()) return
        sendUnit(HttpMethod.Patch, "api/list-items/bulk") {
            jsonBody(
                buildJsonObject {
                    put("ids", kotlinx.serialization.json.JsonArray(ids.map(::JsonPrimitive)))
                    putJsonObject("patch") { patch.forEach { (k, v) -> put(k, v) } }
                },
            )
        }
    }

    /** Remove one item. */
    suspend fun deleteItem(id: String) {
        sendUnit(HttpMethod.Delete, "api/list-items/$id")
    }

    /** Clear a custom list's Completed section now (soft-deletes its checked items). */
    suspend fun clearCompleted(listId: String) {
        sendUnit(HttpMethod.Post, "api/lists/$listId/clear-completed") { jsonBody(buildJsonObject { }) }
    }

    /** The household's previously-used store names (most-used first). */
    suspend fun stores(): List<String> =
        send<StoresEnvelope>(HttpMethod.Get, "api/lists/stores").stores

    // ---- the grocery board -----------------------------------------------------

    /**
     * The grocery board for a week. Omit [weekStart] for the server's current week.
     *
     * **Never compute a week start to pass here.** The server snaps every `weekStart`
     * onto the household's boundary, which is not necessarily the device's — step from
     * the board's own [GroceryBoardDTO.weekStart] instead, via [GroceryWeekStep].
     */
    suspend fun groceryBoard(weekStart: String? = null): GroceryBoardDTO =
        send<GroceryBoardDTO>(HttpMethod.Get, "api/lists/grocery/board") {
            if (weekStart != null) parameter("weekStart", weekStart)
        }

    /**
     * Rebuild the meal-derived grocery rows for [weekStart].
     *
     * The server recomputes only `source = 'auto'` rows; hand-added (`manual`) and
     * explicit off-plan (`recipe`) rows survive untouched. That asymmetry is the whole
     * reason the client must not invent its own rebuild.
     */
    suspend fun rebuildGrocery(weekStart: String): GroceryBoardDTO =
        send<BoardEnvelope>(HttpMethod.Post, "api/lists/grocery/rebuild") {
            parameter("weekStart", weekStart)
        }.board

    /** "Start over": un-check everything on this week's grocery list. */
    suspend fun clearGroceryChecks(weekStart: String): GroceryBoardDTO =
        send<BoardEnvelope>(HttpMethod.Post, "api/lists/grocery/clear-checks") {
            parameter("weekStart", weekStart)
        }.board

    /**
     * Take an off-plan recipe's ingredients back off the grocery list. Rows shared with
     * something still on the plan survive, with this recipe's credit stripped.
     */
    suspend fun removeRecipeFromGrocery(recipeId: String, weekStart: String? = null): Int =
        send<RemovedEnvelope>(HttpMethod.Delete, "api/lists/grocery/from-recipe/$recipeId") {
            if (weekStart != null) parameter("weekStart", weekStart)
        }.removed

    /**
     * Take a whole Meal Builder plate back off the grocery list.
     *
     * The route lives under `/api/meals` because the plate is the subject, but the effect
     * is entirely on this list — which is why it is called from here.
     */
    suspend fun removeMealFromGrocery(mealId: String, weekStart: String? = null): Int =
        send<RemovedEnvelope>(HttpMethod.Delete, "api/meals/$mealId/add-to-list") {
            if (weekStart != null) parameter("weekStart", weekStart)
        }.removed

    // ---- pantry staples --------------------------------------------------------

    /** The editable master list of staples assumed in-house (and so left off the list). */
    suspend fun pantryStaples(): List<GroceryBoardDTO.Staple> =
        send<StaplesEnvelope>(HttpMethod.Get, "api/pantry-staples").staples

    suspend fun addPantryStaple(name: String): GroceryBoardDTO.Staple =
        send<StapleEnvelope>(HttpMethod.Post, "api/pantry-staples") {
            jsonBody(buildJsonObject { put("name", name) })
        }.staple

    suspend fun removePantryStaple(id: String) {
        sendUnit(HttpMethod.Delete, "api/pantry-staples/$id")
    }

    // ---- the request helper every feature slice copies --------------------------

    /**
     * Build → authorise → send → unwrap, in one place.
     *
     * The bearer token is attached per request (it rotates, so it can't be baked into the
     * client's `defaultRequest`), and the token that was actually sent is handed to
     * [WaffledHttp.unwrap] — which is what makes a **staggered** 401 cheap: a caller
     * that is merely behind gets the current token instead of triggering a second
     * rotation of a single-use refresh token.
     */
    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

    /** As [send], for a response with no body to decode (a 204). */
    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit = {},
    ) {
        execute(method, path, configure) { }
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

/** Attach a pre-built JSON tree as the request body. */
private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}

/**
 * A value, or an explicit `JsonNull`.
 *
 * Spelled out at every clearing site because `explicitNulls = false` would otherwise drop
 * the key entirely, turning "clear this" into "leave it alone".
 */
private fun jsonOrNull(value: String?): kotlinx.serialization.json.JsonElement =
    value?.let(::JsonPrimitive) ?: kotlinx.serialization.json.JsonNull
