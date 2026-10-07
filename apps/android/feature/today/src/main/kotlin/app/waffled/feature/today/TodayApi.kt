package app.waffled.feature.today

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import androidx.compose.runtime.Immutable

/**
 * The Today dashboard's slice of the API — the Kotlin port of the Today-dashboard reads
 * in `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Today is a dashboard over several domains, so this touches meals, chores, grocery,
 * goals, the goal↔calendar review queues, weather and the card layout. Per the port's
 * convention (see `PhotosApi`) each feature owns the slice it calls rather than sharing
 * one god-object client; the wire types here are deliberately **lean** — Today renders a
 * summary, so it decodes the handful of fields the cards read and lets
 * `ignoreUnknownKeys` drop the rest. The goals feature owns the full 25-field goal.
 */
class TodayApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types: the meal plan ---------------------------------------------

    /**
     * One dinner/lunch/etc. slot in the planned week.
     *
     * A slot points at EITHER a single recipe ([recipeId]) or a Meal Builder plate
     * ([mealId]). **Never decide what a slot means by testing `recipeId` alone** — it is
     * null for a plate-backed slot, which on the web silently broke four surfaces at once
     * (the Tonight card announced "No recipe attached yet" about a meal with three
     * dishes). Use [TonightMeal.isMealBacked].
     */
    @Serializable
    data class WeekEntry(
        val id: String,
        val date: String,
        val mealType: String,
        val title: String? = null,
        val recipeId: String? = null,
        /** Set when this slot holds a plate. Optional so a pre-Meal-Builder server decodes. */
        val mealId: String? = null,
        val meal: MealSlot? = null,
        val recipe: RecipeInfo? = null,
    )

    /**
     * The plate behind a meal-backed slot.
     *
     * [name] is nullable because the server builds this off a `left join meals … and
     * deleted_at is null`: an entry pointing at a soft-deleted plate serialises
     * `name: null`. Non-nullable, that one row throws and takes the WHOLE `mealsWeek`
     * fetch with it — blanking the Tonight card.
     */
    @Serializable
    data class MealSlot(
        val id: String,
        val name: String? = null,
        val servings: Int? = null,
        val recipes: List<Dish> = emptyList(),
    )

    @Serializable
    data class Dish(
        val recipeId: String,
        val title: String? = null,
        val emoji: String? = null,
        val role: String = "side",
        val sortOrder: Int = 0,
    )

    @Serializable
    data class RecipeInfo(
        val title: String? = null,
        val emoji: String? = null,
        val category: String? = null,
        val prepTimeMinutes: Int? = null,
        val cookTimeMinutes: Int? = null,
        val servings: Int? = null,
        val imageUrl: String? = null,
    )

    // ---- wire types: the summary cards -----------------------------------------

    /** A person's chore tally for today. */
    @Serializable
    data class PersonChores(
        val id: String,
        val name: String,
        val avatarEmoji: String? = null,
        val colorHex: String? = null,
        val total: Int = 0,
        val done: Int = 0,
        val stars: Int = 0,
    )

    /**
     * One of today's chores, as the one-person chores card renders it. A lean copy of the
     * chores feature's instance (Today does not depend on that module); every field past
     * the identity trio defaults so an older self-hosted server still decodes.
     */
    @Immutable
    @Serializable
    data class ChoreInstance(
        val id: String,
        val choreId: String,
        val choreTitle: String,
        val emoji: String? = null,
        val personId: String? = null,
        /** `pending` | `done` | `awaiting`. */
        val status: String = STATUS_PENDING,
        val rewardAmount: Int = 0,
        val rewardCurrency: String? = null,
        /** `HH:mm`, 24h; null = no set time. */
        val dueTime: String? = null,
        val requiresApproval: Boolean = false,
        val requiresPhoto: Boolean = false,
    ) {
        val isDone: Boolean get() = status == STATUS_DONE
        val isAwaiting: Boolean get() = status == STATUS_AWAITING
        val isPending: Boolean get() = status == STATUS_PENDING
    }

    /** Only the two fields the Today count needs — the board itself is the lists feature. */
    @Serializable
    data class GroceryItem(val id: String, val checked: Boolean = false)

    /** A lean goal: what the Today card and its picker render. */
    @Serializable
    data class Goal(
        val id: String,
        val title: String,
        val goalListId: String? = null,
        val emoji: String? = null,
        val category: String? = null,
        val goalType: String = "total",
        val unit: String? = null,
        val isFeatured: Boolean = false,
        val isSpotlight: Boolean? = null,
        val trackingMode: String? = null,
        val target: Double? = null,
        val totalProgress: Double = 0.0,
        val streakDays: Int = 0,
    ) {
        /** 0…1 for a progress bar; 0 for a target-less goal, which has no computable %. */
        val fraction: Double
            get() = target?.takeIf { it > 0 }?.let { (totalProgress / it).coerceIn(0.0, 1.0) } ?: 0.0
    }

    @Serializable
    data class GoalList(
        val id: String,
        val name: String,
        val emoji: String? = null,
        val colorHex: String? = null,
        val goalCount: Int = 0,
        val members: List<GoalListMember> = emptyList(),
    )

    @Serializable
    data class GoalListMember(
        val personId: String,
        val name: String? = null,
        val avatarEmoji: String? = null,
        val colorHex: String? = null,
    )

    /** A confirmed calendar↔goal link awaiting review. */
    @Serializable
    data class GoalRecapItem(
        val eventId: String,
        val occurrenceDate: String = "",
        val title: String,
        val goalId: String,
        val goalTitle: String,
        val goalEmoji: String? = null,
    )

    /** An untagged event that might count toward a goal. */
    @Serializable
    data class GoalSuggestionItem(
        val eventId: String,
        val title: String,
        val goalId: String,
        val goalTitle: String,
        val goalEmoji: String? = null,
        val via: String? = null,
    )

    /** Current conditions; [configured] is false when the household has no location. */
    @Serializable
    data class Weather(
        val configured: Boolean = false,
        val tempF: Double? = null,
        val emoji: String? = null,
        val label: String? = null,
        val location: String? = null,
    )

    // ---- wire types: the card layout -------------------------------------------

    @Serializable
    data class TodayLayout(
        val order: List<String> = emptyList(),
        val hidden: List<String> = emptyList(),
    )

    @Serializable
    data class LayoutResponse(
        val resolved: TodayLayout = TodayLayout(),
        /** "user" | "family" | "default" — which tier the resolved layout came from. */
        val source: String = "default",
        /** Every card key this server knows about. */
        val cards: List<String> = emptyList(),
        val canEditFamily: Boolean = false,
    )

    @Serializable private data class SaveLayoutBody(val scope: String, val layout: TodayLayout)

    // ---- envelopes --------------------------------------------------------------

    @Serializable private data class WeekEnvelope(val entries: List<WeekEntry> = emptyList())
    @Serializable private data class ChoresEnvelope(val people: List<PersonChores> = emptyList())
    @Serializable private data class InstancesEnvelope(val instances: List<ChoreInstance> = emptyList())
    @Serializable private data class GroceryEnvelope(val items: List<GroceryItem> = emptyList())
    @Serializable private data class GoalsEnvelope(val goals: List<Goal> = emptyList())
    @Serializable private data class GoalListsEnvelope(val lists: List<GoalList> = emptyList())
    @Serializable private data class RecapEnvelope(val items: List<GoalRecapItem> = emptyList())
    @Serializable private data class SuggestionsEnvelope(val items: List<GoalSuggestionItem> = emptyList())

    // ---- reads ------------------------------------------------------------------

    /** The planned meals for the week starting [start] (YYYY-MM-DD). */
    suspend fun mealsWeek(start: String): List<WeekEntry> =
        send<WeekEnvelope>(HttpMethod.Get, "api/meals/week?start=$start").entries

    /** Per-person chore progress for today. */
    suspend fun choresToday(): List<PersonChores> =
        send<ChoresEnvelope>(HttpMethod.Get, "api/chores/today").people

    /** Today's chore instances (`yyyy-MM-dd`), behind the one-person chores card. */
    suspend fun choreInstances(date: String): List<ChoreInstance> =
        send<InstancesEnvelope>(HttpMethod.Get, "api/chore-instances/today?date=$date").instances

    /**
     * Tick a chore off. Never call this for a photo-required chore — the server answers
     * 422 without a proof; the card sends those to the Chores board instead.
     */
    suspend fun completeChore(id: String) {
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/complete") { emptyJsonBody() }
    }

    /** Un-tick a chore (also how an awaiting one is taken back). */
    suspend fun uncompleteChore(id: String) {
        sendUnit(HttpMethod.Post, "api/chore-instances/$id/uncomplete") { emptyJsonBody() }
    }

    /** The grocery board's items — Today only counts the unchecked ones. */
    suspend fun groceryItems(): List<GroceryItem> =
        send<GroceryEnvelope>(HttpMethod.Get, "api/lists/grocery").items

    /** Every goal across the household, featured-first as the server orders them. */
    suspend fun goals(): List<Goal> =
        send<GoalsEnvelope>(HttpMethod.Get, "api/goals").goals

    /** The goal lists, for grouping the Today goal picker. */
    suspend fun goalLists(): List<GoalList> =
        send<GoalListsEnvelope>(HttpMethod.Get, "api/goal-lists").lists

    /** Confirmed calendar↔goal links awaiting review (household-wide). */
    suspend fun goalRecap(): List<GoalRecapItem> =
        send<RecapEnvelope>(HttpMethod.Get, "api/goal-calendar/recap").items

    /** Untagged events that might count toward a goal (household-wide). */
    suspend fun goalSuggestions(): List<GoalSuggestionItem> =
        send<SuggestionsEnvelope>(HttpMethod.Get, "api/goal-calendar/suggestions").items

    suspend fun weather(): Weather = send(HttpMethod.Get, "api/weather")

    // ---- the card layout --------------------------------------------------------

    /**
     * The **mobile** Today layout: order + hidden, resolved from the user's override over
     * the family default over the built-in.
     *
     * ⚠️ Mobile and web keep SEPARATE layouts — the web's is 3-column and reorder-only,
     * with a different card set. Reading or writing `today-layout/web` from here would
     * silently reshape the other platform's home screen.
     */
    suspend fun todayLayout(): LayoutResponse =
        send(HttpMethod.Get, "api/today-layout/mobile")

    /** Save to a tier: "user" (your own override) or "family" (admins). */
    suspend fun saveTodayLayout(scope: String, order: List<String>, hidden: List<String>) {
        sendUnit(HttpMethod.Put, "api/today-layout/mobile") {
            contentType(ContentType.Application.Json)
            setBody(SaveLayoutBody(scope = scope, layout = TodayLayout(order = order, hidden = hidden)))
        }
    }

    /** Reset a tier back to inheriting (user → family, family → the built-in default). */
    suspend fun resetTodayLayout(scope: String) {
        sendUnit(HttpMethod.Delete, "api/today-layout/mobile?scope=$scope")
    }

    // ---- request plumbing -------------------------------------------------------

    private fun io.ktor.client.request.HttpRequestBuilder.emptyJsonBody() {
        contentType(ContentType.Application.Json)
        setBody(JsonObject(emptyMap()))
    }

    companion object {
        const val STATUS_PENDING = "pending"
        const val STATUS_DONE = "done"
        const val STATUS_AWAITING = "awaiting"
    }

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: io.ktor.client.request.HttpRequestBuilder.() -> Unit = {},
    ): T = withContext(Dispatchers.IO) {
        WaffledHttp.authorized(client, tokens, method, path, configure) { it.body<T>() }
    }

    /** As [send], for a response whose body we don't decode (a 204, or an ignored ack). */
    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: io.ktor.client.request.HttpRequestBuilder.() -> Unit = {},
    ) {
        withContext(Dispatchers.IO) {
            WaffledHttp.authorized(client, tokens, method, path, configure) { }
        }
    }
}
