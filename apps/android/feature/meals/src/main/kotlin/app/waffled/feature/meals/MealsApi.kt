package app.waffled.feature.meals

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledApiException
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
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The meal-PLANNER slice of the REST API.
 *
 * Meal plans are online-only REST by design — they are not one of the synced tables — so
 * every write here goes straight to the server and the screens reload rather than leaning
 * on a local mirror.
 *
 * Bodies are built as [JsonObject] rather than serialised from data classes. `WaffledJson`
 * sets `explicitNulls = false`, so a nullable property is silently DROPPED from the wire,
 * and for `POST /api/meals/plan` — a full upsert that nulls every key it does not receive
 * — the difference between "omit" and "send null" is the difference between clearing a
 * night's recipe and leaving it attached.
 */
class MealsApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    @Serializable private data class WeekEnvelope(val entries: List<WeekEntryDTO> = emptyList())
    @Serializable private data class MealsEnvelope(val meals: List<MealDTO> = emptyList())
    @Serializable private data class MealEnvelope(val meal: MealDTO)
    @Serializable private data class AddedEnvelope(val added: Int = 0)
    @Serializable private data class ScheduledEnvelope(val meal: MealDTO? = null)

    // ---- reads -----------------------------------------------------------------

    /**
     * The planned meals over a date range starting at [start] (`yyyy-MM-dd`).
     *
     * [days] (1-45) widens the window past one week — the month grid fetches 42. Omitted,
     * the server uses its default of 7.
     */
    suspend fun mealsWeek(start: String, days: Int? = null): List<WeekEntryDTO> =
        send<WeekEnvelope>(HttpMethod.Get, "api/meals/week") {
            parameter("start", start)
            if (days != null) parameter("days", days)
        }.entries

    /**
     * [mealsWeek], or null when the fetch failed.
     *
     * The planner keeps what is already on screen rather than blanking the week — a
     * refresh retries. Distinguishing "failed" from "genuinely empty" is why this returns
     * a nullable list instead of an empty one.
     */
    suspend fun mealsWeekOrNull(start: String, days: Int? = null): List<WeekEntryDTO>? =
        runCatching { mealsWeek(start, days) }.getOrNull()

    /**
     * The saved-plate library. [q] matches the plate name OR any dish title, so searching
     * "chicken" finds "BBQ Sunday".
     */
    suspend fun savedMeals(q: String? = null, limit: Int? = null): List<MealDTO> =
        send<MealsEnvelope>(HttpMethod.Get, "api/meals") {
            if (!q.isNullOrBlank()) parameter("q", q)
            if (limit != null) parameter("limit", limit)
        }.meals

    /** One plate, with its full dish detail. */
    suspend fun meal(id: String): MealDTO =
        send<MealEnvelope>(HttpMethod.Get, "api/meals/$id").meal

    // ---- planning one slot ------------------------------------------------------

    /**
     * Upsert one planned slot.
     *
     * A slot points at EITHER a recipe or a Meal Builder plate — the server answers 400
     * for both at once. Only a genuinely free-text night ("eating out") carries a
     * [title]: sending a plate's name alongside its [mealId] would freeze that name in
     * the row, so renaming the plate would stop showing here.
     *
     * Every key omitted is written as null server-side, which is exactly what makes
     * replacing a recipe night with free text actually clear the recipe.
     */
    suspend fun planMeal(
        date: String,
        mealType: String,
        recipeId: String? = null,
        title: String? = null,
        cookPersonId: String? = null,
        mealId: String? = null,
    ) {
        sendUnit(HttpMethod.Post, "api/meals/plan") {
            jsonBody(
                buildJsonObject {
                    put("date", date)
                    put("mealType", mealType)
                    if (recipeId != null) put("recipeId", recipeId)
                    if (mealId != null) put("mealId", mealId)
                    if (title != null) put("title", title)
                    if (cookPersonId != null) put("cookPersonId", cookPersonId)
                },
            )
        }
    }

    /**
     * Clear a planned slot.
     *
     * A 404 means nothing was planned there, which is the ordinary outcome of a
     * compensating write after a move onto an empty night — so it is swallowed rather
     * than surfaced as a failure the user has to think about.
     */
    suspend fun clearMeal(date: String, mealType: String) {
        try {
            sendUnit(HttpMethod.Delete, "api/meals/plan") {
                parameter("date", date)
                parameter("mealType", mealType)
            }
        } catch (e: WaffledApiException) {
            if (e.status != 404) throw e
        }
    }

    /**
     * Execute one write from a move's plan — upsert the slot, or clear it.
     *
     * Mirrors what the optimistic move math assumed the server would do, so
     * [MealPlanSwap.writes]' loss-safe ordering means what it says.
     */
    suspend fun perform(op: MealPlanSwap.Op) {
        val e = op.entry ?: return clearMeal(op.date, op.mealType)
        // Recipe, plate, or neither. Only that last case needs a title.
        val freeText = e.recipeId == null && !e.isMealBacked
        planMeal(
            date = op.date,
            mealType = op.mealType,
            recipeId = e.recipeId,
            title = if (freeText) (e.title ?: e.displayTitle) else null,
            cookPersonId = e.cook?.personId,
            mealId = e.mealId,
        )
    }

    /** Execute one op from a "plan my week/month" apply. */
    suspend fun perform(op: MealPlanApply.Op) {
        when (op) {
            is MealPlanApply.Op.Set ->
                planMeal(op.date, op.mealType, recipeId = op.recipeId, title = op.title, mealId = op.mealId)
            is MealPlanApply.Op.Clear -> clearMeal(op.date, op.mealType)
            is MealPlanApply.Op.Rebuild -> rebuildGrocery(op.weekStart)
        }
    }

    /**
     * Rebuild the auto-added grocery items from one week's planned meals.
     *
     * Covers exactly ONE week, which is why an apply issues one call per week it touched —
     * see [GroceryWeeks.weekStarts]. Hand-added rows (`source` `manual`) and explicit
     * off-plan recipe adds (`source` `recipe`) are deliberately untouched; only the
     * derived `auto` rows are recomputed. Getting that backwards destroys user data.
     */
    suspend fun rebuildGrocery(weekStart: String) {
        sendUnit(HttpMethod.Post, "api/lists/grocery/rebuild") {
            parameter("weekStart", weekStart)
        }
    }

    // ---- drafting ---------------------------------------------------------------

    /**
     * Ask the household's LLM to draft a dish for each named night. Nothing is saved — the
     * client applies accepted cards through [perform].
     */
    suspend fun planWeek(
        start: String,
        mealType: String,
        dates: List<String>?,
        cookingFor: Int?,
        keepInMind: String?,
        useUp: List<String>?,
        avoidTitles: List<String>?,
        wantToTry: List<String>?,
        trySomethingNew: Boolean?,
    ): PlanWeekResult = send(HttpMethod.Post, "api/meals/plan-week") {
        jsonBody(
            buildJsonObject {
                put("start", start)
                put("mealType", mealType)
                putStrings("dates", dates)
                // Omitted (not zero) so the server falls back to the whole family.
                if (cookingFor != null) put("cookingFor", cookingFor)
                if (!keepInMind.isNullOrEmpty()) put("keepInMind", keepInMind)
                putStrings("useUp", useUp)
                putStrings("avoidTitles", avoidTitles)
                putStrings("wantToTry", wantToTry)
                if (trySomethingNew == true) put("trySomethingNew", true)
            },
        )
    }

    /**
     * Ask the LLM to draft a month of dinners as a rotation with guardrails. [dates]
     * re-drafts specific nights instead of the whole month.
     */
    suspend fun planMonth(
        start: String,
        weekdays: List<Int>?,
        skipDates: List<String>?,
        dates: List<String>?,
        cookingFor: Int?,
        keepInMind: String?,
        useUp: List<String>?,
        avoidTitles: List<String>?,
        allowRepeats: Boolean,
        repeatGapDays: Int,
        weekdayThemes: Map<String, String>?,
        weeknightMaxMin: Int?,
        leftovers: Boolean,
    ): PlanMonthResult = send(HttpMethod.Post, "api/meals/plan-month") {
        jsonBody(
            buildJsonObject {
                put("start", start)
                if (!weekdays.isNullOrEmpty()) {
                    putJsonArray("weekdays") { weekdays.forEach { add(it) } }
                }
                putStrings("skipDates", skipDates)
                putStrings("dates", dates)
                if (cookingFor != null) put("cookingFor", cookingFor)
                if (!keepInMind.isNullOrEmpty()) put("keepInMind", keepInMind)
                putStrings("useUp", useUp)
                putStrings("avoidTitles", avoidTitles)
                // Unconditional: `false` here really means false, not "you decide".
                put("allowRepeats", allowRepeats)
                put("repeatGapDays", repeatGapDays)
                if (!weekdayThemes.isNullOrEmpty()) {
                    putJsonObject("weekdayThemes") { weekdayThemes.forEach { (k, v) -> put(k, v) } }
                }
                if (weeknightMaxMin != null) put("weeknightMaxMin", weeknightMaxMin)
                put("leftovers", leftovers)
            },
        )
    }

    // ---- plate actions ----------------------------------------------------------

    /**
     * Put a whole plate's shopping on the grocery list without scheduling it. Returns how
     * many NEW rows were added (merges into existing rows don't count).
     *
     * Those rows are `source='recipe'`, which the weekly rebuild deliberately never wipes.
     */
    suspend fun addMealToGrocery(id: String, weekStart: String? = null): Int =
        send<AddedEnvelope>(HttpMethod.Post, "api/meals/$id/add-to-list") {
            if (weekStart != null) parameter("weekStart", weekStart)
        }.added

    /**
     * Schedule a saved plate onto a night.
     *
     * This deliberately COPIES the plate, so editing next week's copy can't rewrite the
     * one that already went out — which is why the planner's move uses `planMeal(mealId=)`
     * instead, relocating the same plate.
     */
    suspend fun scheduleMeal(
        id: String,
        date: String,
        mealType: String,
        cookPersonId: String? = null,
    ) {
        sendUnit(HttpMethod.Post, "api/meals/$id/schedule") {
            jsonBody(
                buildJsonObject {
                    put("date", date)
                    put("mealType", mealType)
                    if (cookPersonId != null) put("cookPersonId", cookPersonId)
                },
            )
        }
    }

    // ---- the request helper every feature slice copies ---------------------------

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

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
 * Put a string array under [key], or omit the key entirely when there is nothing to say.
 *
 * An empty array is not the same as an absent one to these endpoints: `"useUp": []` reads
 * as an instruction, an absent key as "no preference".
 */
private fun kotlinx.serialization.json.JsonObjectBuilder.putStrings(key: String, values: List<String>?) {
    if (values.isNullOrEmpty()) return
    putJsonArray(key) { values.forEach { add(it) } }
}
