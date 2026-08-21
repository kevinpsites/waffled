package app.waffled.feature.recipes

import app.waffled.core.network.TokenProvider
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
import io.ktor.http.encodeURLQueryComponent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Whose history a recently-viewed list reflects. */
enum class RecentRecipeScope(val wire: String) { Me("me"), Household("household") }

/**
 * The Recipes + Meal-Builder + recipe-media slice of the API — the Kotlin port of the
 * `recipes`, `meals` and `media` endpoints in `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Deliberately **not** a god-object client: each feature module owns the slice it calls,
 * so many agents can work in parallel without contending over one file. Everything
 * shared (the Ktor client, the 401 refresh, the error text) lives in `core:network`.
 *
 * Recipes and meals are **REST-only by design** — they are deliberately not in the
 * PowerSync schema, so every read here is a live fetch and every write is followed by a
 * `RefreshBus` bump at the model layer.
 *
 * ⚠️ Every PATCH body below is a hand-built [JsonObject] rather than a serialised data
 * class. `WaffledJson` sets `explicitNulls = false`, so a nullable property is **omitted**
 * from the body — which silently turns "clear this" into "leave it alone". The server
 * distinguishes the two on `cookPersonId` and on every key inside `overrides`.
 */
class RecipesApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    /** Base64 image bytes ready to POST — what `MediaImageEncoder.encode` produces. */
    data class EncodedImage(val data: String, val contentType: String)

    /**
     * The result of a blob upload: the opaque storage key to persist as an entity's
     * `storageKey`, its resolved (relative) URL, and the stored content type.
     */
    @Serializable
    data class UploadedMedia(val key: String, val url: String, val contentType: String)

    // ---- envelopes -------------------------------------------------------------

    @Serializable private data class RecipesEnvelope(val recipes: List<RecipeSummary> = emptyList())
    @Serializable private data class RecipeEnvelope(val recipe: RecipeSummary)
    @Serializable private data class SectionsEnvelope(val sections: List<String> = emptyList())
    @Serializable private data class SuggestionEnvelope(val suggestion: RecipeMetadataSuggestion? = null)
    @Serializable private data class MatchesEnvelope(val matches: List<RecipeMatch> = emptyList())
    @Serializable private data class MealsEnvelope(val meals: List<MealDTO> = emptyList())
    @Serializable private data class MealEnvelope(val meal: MealDTO)
    @Serializable private data class AddedEnvelope(val added: Int = 0)
    @Serializable private data class RemovedEnvelope(val removed: Int = 0)

    // ---- recipes: reads --------------------------------------------------------

    /** The whole recipe library. There is no server-side search — the client filters. */
    suspend fun library(): List<RecipeSummary> =
        send<RecipesEnvelope>(HttpMethod.Get, "api/recipes").recipes

    /** Full detail for one recipe: metadata + ingredients + steps. */
    suspend fun detail(id: String): RecipeDetailDTO =
        send(HttpMethod.Get, "api/recipes/$id")

    /** Recently-opened recipes, newest first — the caller's own, or the household's. */
    suspend fun recent(
        scope: RecentRecipeScope = RecentRecipeScope.Me,
        limit: Int = 12,
    ): List<RecipeSummary> =
        send<RecipesEnvelope>(HttpMethod.Get, "api/recipes/recent?scope=${scope.wire}&limit=$limit").recipes

    /**
     * Record that this recipe was opened, for the recently-viewed rail.
     *
     * Deliberately swallows everything: this is a convenience signal, and a failure to
     * record it must never surface as an error on the recipe the user is reading.
     */
    suspend fun recordView(id: String) {
        runCatching { sendUnit(HttpMethod.Post, "api/recipes/$id/view") { jsonBody(buildJsonObject { }) } }
    }

    /**
     * The recipe compiled into the blessed Markdown format for sharing, plus a suggested
     * `.md` filename. Server-side so it stays identical to the web export and round-trips
     * through the same parser.
     */
    suspend fun markdown(id: String): RecipeMarkdown =
        send(HttpMethod.Get, "api/recipes/$id/markdown")

    /**
     * The household's previously-used ingredient section names, for the editor's
     * section-name autocomplete. Merged client-side with the curated defaults.
     */
    suspend fun sections(): List<String> =
        send<SectionsEnvelope>(HttpMethod.Get, "api/recipes/sections").sections

    // ---- recipes: writes -------------------------------------------------------

    /** Toggle a recipe's favourite flag; returns the updated recipe. */
    suspend fun setFavorite(id: String, isFavorite: Boolean): RecipeSummary =
        send<RecipeEnvelope>(HttpMethod.Patch, "api/recipes/$id") {
            jsonBody(buildJsonObject { put("isFavorite", isFavorite) })
        }.recipe

    /** Mark a recipe cooked (bumps the count + timestamp); returns the updated recipe. */
    suspend fun markCooked(id: String): RecipeSummary =
        send<RecipeEnvelope>(HttpMethod.Post, "api/recipes/$id/cooked").recipe

    /**
     * Patch a recipe's user notes and/or its full overrides blob (tags, dietary,
     * substitutions, per-step notes).
     *
     * Omitted fields are left untouched server-side; [overrides], when sent, **replaces
     * the whole blob** — so pass the complete current object, read-modify-write style.
     * It is a [JsonObject] rather than [RecipeOverrides] precisely so a key set to
     * `JsonNull` reaches the server as a real null and actually clears.
     */
    suspend fun updateRecipe(
        id: String,
        userNotes: String? = null,
        overrides: JsonObject? = null,
    ): RecipeSummary =
        send<RecipeEnvelope>(HttpMethod.Patch, "api/recipes/$id") {
            jsonBody(
                buildJsonObject {
                    if (userNotes != null) put("userNotes", userNotes)
                    if (overrides != null) put("overrides", overrides)
                },
            )
        }.recipe

    /** Create a recipe from a full editor body (title + details + ingredients + steps). */
    suspend fun createRecipe(body: JsonObject): RecipeSummary =
        send<RecipeEnvelope>(HttpMethod.Post, "api/recipes") { jsonBody(body) }.recipe

    /** Replace a recipe's content from the editor (metadata + a full ingredient/step rewrite). */
    suspend fun saveRecipeContent(id: String, body: JsonObject): RecipeSummary =
        send<RecipeEnvelope>(HttpMethod.Patch, "api/recipes/$id") { jsonBody(body) }.recipe

    /** Delete a recipe (and its ingredients/steps, server-side). Answers 204. */
    suspend fun deleteRecipe(id: String) {
        sendUnit(HttpMethod.Delete, "api/recipes/$id")
    }

    // ---- AI import -------------------------------------------------------------

    /**
     * Which import paths this household can use: `text` (speech / free-form → recipe)
     * needs any non-heuristic provider, `vision` (photo → recipe) needs a vision-capable
     * model. The editor uses this to show or hide the two import buttons.
     */
    suspend fun ingestConfig(): RecipeIngestConfig =
        send(HttpMethod.Get, "api/recipes/ingest/config")

    /** Parse pasted Markdown into editable fields. Does NOT create the recipe. */
    suspend fun parseMarkdown(markdown: String): ParsedRecipe =
        send(HttpMethod.Post, "api/recipes/parse-markdown") {
            jsonBody(buildJsonObject { put("markdown", markdown) })
        }

    /** Dictated or typed free-form text → a recipe draft. Does NOT create the recipe. */
    suspend fun ingestVoice(text: String): ParsedRecipe =
        send(HttpMethod.Post, "api/recipes/ingest/voice") {
            jsonBody(buildJsonObject { put("text", text) })
        }

    /** One or more photos of a printed recipe → a draft, via a vision model. */
    suspend fun ingestPhotos(images: List<EncodedImage>): ParsedRecipe =
        send(HttpMethod.Post, "api/recipes/ingest/photo") {
            jsonBody(
                buildJsonObject {
                    put(
                        "images",
                        buildJsonArray {
                            for (i in images) {
                                add(
                                    buildJsonObject {
                                        put("data", i.data)
                                        put("contentType", i.contentType)
                                    },
                                )
                            }
                        },
                    )
                },
            )
        }

    /**
     * AI Details auto-fill: infer cuisine / protein / tags / … from the title, ingredient
     * names and step texts.
     *
     * Returns null on ANY failure (a 501 no-provider, a slow-model timeout, a network
     * blip) rather than throwing — the editor shows no suggestions and keeps probing,
     * which is the honest rendering of "we can't say".
     */
    suspend fun suggestMetadata(
        title: String,
        ingredients: List<String>,
        steps: List<String>,
    ): RecipeMetadataSuggestion? = runCatching {
        send<SuggestionEnvelope>(HttpMethod.Post, "api/recipes/suggest-metadata") {
            jsonBody(
                buildJsonObject {
                    put("title", title)
                    put("ingredients", stringArray(ingredients))
                    put("steps", stringArray(steps))
                },
            )
        }.suggestion
    }.getOrNull()

    // ---- media -----------------------------------------------------------------

    /**
     * Upload image bytes (base64) to the blob store.
     *
     * The container server buffers request bodies to a string, so uploads go as base64
     * inside JSON rather than as multipart. Encode with `MediaImageEncoder` from
     * `core:network` — it downscales and walks a quality ladder under the server's 10 MB
     * cap; do not roll your own.
     */
    suspend fun uploadMedia(base64Data: String, contentType: String): UploadedMedia =
        send(HttpMethod.Post, "api/media") {
            jsonBody(
                buildJsonObject {
                    put("data", base64Data)
                    put("contentType", contentType)
                },
            )
        }

    // ---- grocery + pantry ------------------------------------------------------

    /**
     * Add a recipe's ingredients straight to the grocery list — no meal-plan entry
     * needed. Returns how many NEW rows were added (merges into existing rows don't
     * count).
     *
     * [ingredientIds] adds only the picked subset; omit it to add every non-staple
     * ingredient. [weekStart] scopes the off-plan add to the week being shopped.
     */
    suspend fun groceryFromRecipe(
        recipeId: String,
        weekStart: String? = null,
        ingredientIds: List<String>? = null,
    ): Int {
        val q = weekStart?.let { "?weekStart=$it" }.orEmpty()
        val path = "api/lists/grocery/from-recipe/$recipeId$q"
        return send<AddedEnvelope>(HttpMethod.Post, path) {
            if (ingredientIds != null) {
                jsonBody(buildJsonObject { put("ingredientIds", stringArray(ingredientIds)) })
            }
        }.added
    }

    /** Undo the off-plan add. Keeps rows another recipe still needs. */
    suspend fun removeRecipeFromGrocery(recipeId: String, weekStart: String? = null): Int {
        val q = weekStart?.let { "?weekStart=$it" }.orEmpty()
        return send<RemovedEnvelope>(HttpMethod.Delete, "api/lists/grocery/from-recipe/$recipeId$q").removed
    }

    /**
     * On-hand items a just-cooked recipe likely used, each with a suggested consume
     * action. Empty when the pantry module is off or nothing matched — the caller then
     * skips the confirm sheet entirely.
     */
    suspend fun pantryForRecipe(recipeId: String): List<RecipeMatch> =
        send<MatchesEnvelope>(HttpMethod.Get, "api/pantry/for-recipe/$recipeId").matches

    // ---- plates ----------------------------------------------------------------

    /** Create a plate. Returns it so the caller can adopt the server's id immediately. */
    suspend fun createMeal(name: String, servings: Int? = null, isSaved: Boolean? = null): MealDTO =
        send<MealEnvelope>(HttpMethod.Post, "api/meals") {
            jsonBody(
                buildJsonObject {
                    put("name", name)
                    if (servings != null) put("servings", servings)
                    if (isSaved != null) put("isSaved", isSaved)
                },
            )
        }.meal

    /**
     * The saved-plate library. [q] matches the plate name OR any dish title, so searching
     * "chicken" finds "BBQ Sunday".
     */
    suspend fun savedMeals(q: String? = null, limit: Int? = null): List<MealDTO> {
        val parts = buildList {
            if (!q.isNullOrEmpty()) {
                // `%20`, not `+`: plate names are free text and the server's query parser
                // is not form-decoding. Matches the iOS wire format.
                add("q=" + q.encodeURLQueryComponent(spaceToPlus = false))
            }
            if (limit != null) add("limit=$limit")
        }
        val path = "api/meals" + if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
        return send<MealsEnvelope>(HttpMethod.Get, path).meals
    }

    suspend fun meal(id: String): MealDTO =
        send<MealEnvelope>(HttpMethod.Get, "api/meals/$id").meal

    /** Rename / re-serve / save-to-library. Omitted fields are left alone. */
    suspend fun updateMeal(
        id: String,
        name: String? = null,
        servings: Int? = null,
        isSaved: Boolean? = null,
    ): MealDTO =
        send<MealEnvelope>(HttpMethod.Patch, "api/meals/$id") {
            jsonBody(
                buildJsonObject {
                    if (name != null) put("name", name)
                    if (servings != null) put("servings", servings)
                    if (isSaved != null) put("isSaved", isSaved)
                },
            )
        }.meal

    /**
     * Add a recipe to the plate. Re-adding a recipe already on the plate is an upsert
     * that **keeps** whatever role, cook and position it had unless this call names new
     * ones — which is why the builder always sends an explicit [role].
     */
    suspend fun addDish(
        mealId: String,
        recipeId: String,
        role: String? = null,
        sortOrder: Int? = null,
        cookPersonId: String? = null,
    ): MealDTO =
        send<MealEnvelope>(HttpMethod.Post, "api/meals/$mealId/recipes") {
            jsonBody(
                buildJsonObject {
                    put("recipeId", recipeId)
                    if (role != null) put("role", role)
                    if (sortOrder != null) put("sortOrder", sortOrder)
                    if (cookPersonId != null) put("cookPersonId", cookPersonId)
                },
            )
        }.meal

    /**
     * Add a SAVED plate to the plate under construction — it **flattens**, so its dishes
     * arrive as individual, editable rows keeping their own roles. Meals never nest.
     */
    suspend fun flattenMeal(intoMealId: String, savedMealId: String): MealDTO =
        send<MealEnvelope>(HttpMethod.Post, "api/meals/$intoMealId/recipes") {
            jsonBody(buildJsonObject { put("mealId", savedMealId) })
        }.meal

    /**
     * Change a dish's role, position, or cook.
     *
     * [cook] must say explicitly whether it is clearing the cook or leaving it alone —
     * see [CookAssignment]. `Clear` writes a real `JsonNull`, because a nullable field on
     * a data class would vanish from the body under `explicitNulls = false` and make
     * un-assigning a cook quietly impossible.
     */
    suspend fun patchDish(
        mealId: String,
        recipeId: String,
        role: String? = null,
        sortOrder: Int? = null,
        cook: CookAssignment = CookAssignment.Unchanged,
    ): MealDTO =
        send<MealEnvelope>(HttpMethod.Patch, "api/meals/$mealId/recipes/$recipeId") {
            jsonBody(
                buildJsonObject {
                    if (role != null) put("role", role)
                    if (sortOrder != null) put("sortOrder", sortOrder)
                    when (cook) {
                        CookAssignment.Unchanged -> Unit
                        CookAssignment.Clear -> put("cookPersonId", JsonNull)
                        is CookAssignment.Person -> put("cookPersonId", cook.personId)
                    }
                },
            )
        }.meal

    /** Reorder the whole plate in one write (the ids in their new order). */
    suspend fun reorderDishes(mealId: String, recipeIds: List<String>): MealDTO =
        send<MealEnvelope>(HttpMethod.Put, "api/meals/$mealId/recipes/order") {
            jsonBody(buildJsonObject { put("recipeIds", stringArray(recipeIds)) })
        }.meal

    suspend fun removeDish(mealId: String, recipeId: String): MealDTO =
        send<MealEnvelope>(HttpMethod.Delete, "api/meals/$mealId/recipes/$recipeId").meal

    /**
     * Put the plate on a day + slot.
     *
     * Scheduling a SAVED plate **copies** it server-side, so editing next week's BBQ
     * Sunday never rewrites the one that already went out last week. The reply therefore
     * carries the *copy*, not this plate — don't repaint the builder from it.
     */
    suspend fun scheduleMeal(
        id: String,
        date: String,
        mealType: String,
        cookPersonId: String? = null,
    ): ScheduledMealDTO =
        send(HttpMethod.Post, "api/meals/$id/schedule") {
            jsonBody(
                buildJsonObject {
                    put("date", date)
                    put("mealType", mealType)
                    if (cookPersonId != null) put("cookPersonId", cookPersonId)
                },
            )
        }

    /**
     * Put the whole plate's shopping on the grocery list without scheduling it anywhere.
     * Returns how many new rows were added.
     */
    suspend fun addMealToGrocery(id: String, weekStart: String? = null): Int {
        val q = weekStart?.let { "?weekStart=$it" }.orEmpty()
        return send<AddedEnvelope>(HttpMethod.Post, "api/meals/$id/add-to-list$q").added
    }

    /**
     * Undo the add above. Those rows are `source='recipe'`, which the weekly rebuild
     * deliberately never wipes, so this is the ONLY way a plate comes back off the list.
     */
    suspend fun removeMealFromGrocery(id: String, weekStart: String? = null): Int {
        val q = weekStart?.let { "?weekStart=$it" }.orEmpty()
        return send<RemovedEnvelope>(HttpMethod.Delete, "api/meals/$id/add-to-list$q").removed
    }

    // ---- the request helper every feature slice copies --------------------------

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
        // A 204 has no body at all, so the parse lambda must not touch it.
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

private fun stringArray(values: List<String>): JsonArray =
    JsonArray(values.map { JsonPrimitive(it) as JsonElement })
