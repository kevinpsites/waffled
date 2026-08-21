package app.waffled.feature.today

import androidx.compose.runtime.Immutable
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.RestDomain
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow

/**
 * Tonight's dinner, derived from the planned week. Handles a recipe, a Meal Builder
 * **plate** (several dishes under one name), a recipe-less ("Fish") plan, or an
 * eating-out night — mirroring the web `TonightCard` and the iOS `TonightMeal`.
 */
@Immutable
data class TonightMeal(
    val title: String,
    val emoji: String,
    val cookTimeMinutes: Int?,
    val servings: Int?,
    val eatingOut: Boolean,
    val hasRecipe: Boolean,
    val recipeId: String?,
    val category: String?,
    /** Set when tonight is a plate rather than a single recipe. */
    val mealId: String?,
    /** How many dishes the plate has (0 for a single-recipe or free-text night). */
    val dishCount: Int,
) {
    /** Tonight is a plate rather than a single recipe. */
    val isMealBacked: Boolean get() = mealId != null

    /**
     * There is something here to open and cook — a recipe OR a plate.
     *
     * The card's buttons gate on this. Gating on [recipeSummary] alone told people
     * "No recipe attached yet" about a meal with three dishes.
     */
    val isCookable: Boolean get() = hasRecipe || isMealBacked

    /**
     * A placeholder recipe so the Today card can open tonight's recipe.
     *
     * Deliberately null for a plate: a plate has no single recipe to stand in for it, and
     * inventing one would open the wrong screen. Route on [mealId] instead.
     */
    val recipeSummary: TonightRecipe?
        get() = recipeId?.let {
            TonightRecipe(it, title, emoji, category, cookTimeMinutes, servings)
        }

    companion object {
        operator fun invoke(entry: TodayApi.WeekEntry): TonightMeal {
            // A plate is a real meal with real dishes, so the eating-out heuristic must
            // not reach it: someone who names a plate "Takeout Night" still cooked four
            // things.
            val isMealBacked = entry.mealId != null
            val out = entry.recipeId == null && !isMealBacked && isEatingOut(entry.title)
            return TonightMeal(
                title = if (out) {
                    "Eating out"
                } else {
                    entry.recipe?.title ?: entry.meal?.name ?: entry.title ?: "Dinner"
                },
                emoji = entry.recipe?.emoji ?: if (out) "🍴" else "🍽️",
                cookTimeMinutes = entry.recipe?.cookTimeMinutes,
                servings = entry.recipe?.servings ?: entry.meal?.servings,
                eatingOut = out,
                hasRecipe = entry.recipeId != null,
                recipeId = entry.recipeId,
                category = entry.recipe?.category,
                mealId = entry.mealId,
                dishCount = entry.meal?.recipes?.size ?: 0,
            )
        }

        /**
         * A recipe-less plan whose title reads like an eating-out night ("takeout",
         * "delivery", "going out", …). Mirrors the web regex.
         */
        private val eatingOutPatterns = listOf(
            Regex("""\b(eating|eat|dining|going)\s*out\b"""),
            Regex("""take\s*-?out"""),
            Regex("""\border(ing)?\s+in\b"""),
            Regex("""\bdelivery\b"""),
            Regex("""\btakeaway\b"""),
        )

        fun isEatingOut(title: String?): Boolean {
            val t = title?.lowercase() ?: return false
            return eatingOutPatterns.any { it.containsMatchIn(t) }
        }
    }
}

/** The bit of a recipe the Tonight card needs to hand to whoever opens it. */
@Immutable
data class TonightRecipe(
    val id: String,
    val title: String,
    val emoji: String,
    val category: String?,
    val cookTimeMinutes: Int?,
    val servings: Int?,
)

/**
 * REST-backed state for the Today dashboard's non-synced cards (tonight's meal, chores,
 * grocery count, plus the goals card and its review queues). Agenda events come from
 * PowerSync; these domains aren't synced tables, so they load over the API — refreshed on
 * appear, pull-down, the [RefreshBus], and on returning to the foreground.
 *
 * Each domain lives in its own [RestDomain], which carries the loading-state contract the
 * cards rely on: `loaded` / `goalsLoaded` flip true only after their fetch completes, so a
 * card can tell "still loading" (placeholder) apart from "loaded and empty" (empty state).
 * A failed fetch (offline, expired token) keeps the prior values rather than blanking the
 * cards.
 *
 * ⚠️ Tonight is a `RestDomain<List<TonightMeal>>`, not a nullable single value, and that
 * is load-bearing: `RestDomain.apply(null)` means "the fetch FAILED, keep what we had", so
 * a nullable-single domain could never express "the fetch succeeded and there is no dinner
 * tonight" — a meal deleted elsewhere would haunt the card forever. An empty list says it
 * cleanly. (Swift got this from double optionality, which Kotlin has no equivalent of.)
 *
 * Fetchers are constructor parameters so the whole state machine is drivable from a plain
 * JVM test — same reasoning as `PhotosModel`: no scope, no main-dispatcher rule.
 */
class DashboardModel(
    private val fetchMeals: suspend (String) -> List<TodayApi.WeekEntry>?,
    private val fetchChores: suspend () -> List<TodayApi.PersonChores>?,
    private val fetchGrocery: suspend () -> List<TodayApi.GroceryItem>?,
    private val fetchGoals: suspend () -> List<TodayApi.Goal>?,
    private val fetchRecap: suspend () -> List<TodayApi.GoalRecapItem>?,
    private val fetchSuggestions: suspend () -> List<TodayApi.GoalSuggestionItem>?,
    /**
     * Current conditions for the greeting row. Defaulted so the ported spec tests, which
     * know nothing about weather, construct the model unchanged.
     */
    private val fetchWeather: suspend () -> TodayApi.Weather? = { null },
) {

    private val tonightD = RestDomain<List<TonightMeal>>()
    private val choresD = RestDomain<List<TodayApi.PersonChores>>()
    private val groceryD = RestDomain<Int>()
    private val goalsD = RestDomain<List<TodayApi.Goal>>()
    private val recapD = RestDomain<List<TodayApi.GoalRecapItem>>()
    private val suggestionsD = RestDomain<List<TodayApi.GoalSuggestionItem>>()
    private val weatherD = RestDomain<TodayApi.Weather>()

    /** Per-card state the composables collect, so one slow card never blocks another. */
    val tonightState: StateFlow<RestDomain.Snapshot<List<TonightMeal>>> = tonightD.state
    val choresState: StateFlow<RestDomain.Snapshot<List<TodayApi.PersonChores>>> = choresD.state
    val groceryState: StateFlow<RestDomain.Snapshot<Int>> = groceryD.state
    val goalsState: StateFlow<RestDomain.Snapshot<List<TodayApi.Goal>>> = goalsD.state
    val recapState: StateFlow<RestDomain.Snapshot<List<TodayApi.GoalRecapItem>>> = recapD.state
    val suggestionsState: StateFlow<RestDomain.Snapshot<List<TodayApi.GoalSuggestionItem>>> =
        suggestionsD.state
    val weatherState: StateFlow<RestDomain.Snapshot<TodayApi.Weather>> = weatherD.state

    val tonight: TonightMeal? get() = tonightD.value?.firstOrNull()
    val chores: List<TodayApi.PersonChores> get() = choresD.value.orEmpty()
    val groceryRemaining: Int get() = groceryD.value ?: 0

    /** Whether the meals/chores/grocery load has completed at least once. */
    val loaded: Boolean get() = tonightD.loaded && choresD.loaded && groceryD.loaded

    val goals: List<TodayApi.Goal> get() = goalsD.value.orEmpty()
    val reviewRecap: List<TodayApi.GoalRecapItem> get() = recapD.value.orEmpty()
    val reviewSuggestions: List<TodayApi.GoalSuggestionItem> get() = suggestionsD.value.orEmpty()

    /**
     * Whether the goals load has completed at least once — the goals card must key its
     * empty state off THIS flag, not [loaded] (the dash fetch usually finishes first,
     * which used to flash "Set a family goal →" before goals arrived).
     */
    val goalsLoaded: Boolean get() = goalsD.loaded && recapD.loaded && suggestionsD.loaded

    val weather: TodayApi.Weather? get() = weatherD.value

    /** Aggregate chore progress across the family (for the compact summary card). */
    val choreDone: Int get() = chores.sumOf { it.done }
    val choreTotal: Int get() = chores.sumOf { it.total }
    val choreStars: Int get() = chores.sumOf { it.stars }

    /**
     * Load the meal/chores/grocery domains concurrently. Per the [RestDomain] contract, a
     * domain that fails keeps its prior value; one that succeeds empty clears (e.g.
     * tonight's dinner was removed elsewhere → back to "No dinner planned").
     */
    suspend fun load(todayKey: String) = coroutineScope {
        val meals = async { fetchMeals(todayKey) }
        val people = async { fetchChores() }
        val grocery = async { fetchGrocery() }

        tonightD.apply(
            meals.await()?.let { entries ->
                entries.filter { it.mealType == "dinner" && it.date == todayKey }
                    .take(1)
                    .map { TonightMeal(it) }
            },
        )
        // People with nothing on today's board are dropped — an empty avatar row reads
        // as a bug, not as "nothing assigned".
        choresD.apply(people.await()?.filter { it.total > 0 })
        groceryD.apply(grocery.await()?.count { !it.checked })
    }

    /**
     * Load the goals card + the goal↔calendar review queues concurrently. Same failure
     * semantics as [load].
     */
    suspend fun loadGoals() = coroutineScope {
        val goalRows = async { fetchGoals() }
        val recapRows = async { fetchRecap() }
        val suggestionRows = async { fetchSuggestions() }

        goalsD.apply(goalRows.await())
        recapD.apply(recapRows.await())
        suggestionsD.apply(suggestionRows.await())
    }

    /** The greeting's temperature chip. Its own load: nothing else waits on the weather. */
    suspend fun loadWeather() {
        weatherD.apply(fetchWeather())
    }

    companion object {
        /** The production wiring: every fetcher swallows its error so [RestDomain] sees null. */
        fun from(api: TodayApi) = DashboardModel(
            fetchMeals = { runCatching { api.mealsWeek(it) }.getOrNull() },
            fetchChores = { runCatching { api.choresToday() }.getOrNull() },
            fetchGrocery = { runCatching { api.groceryItems() }.getOrNull() },
            fetchGoals = { runCatching { api.goals() }.getOrNull() },
            fetchRecap = { runCatching { api.goalRecap() }.getOrNull() },
            fetchSuggestions = { runCatching { api.goalSuggestions() }.getOrNull() },
            fetchWeather = { runCatching { api.weather() }.getOrNull() },
        )

        /**
         * Which [RefreshDomain] bumps should re-run which load. A chore ticked or a
         * grocery item added elsewhere in the app has no synced table to notify anyone,
         * so the writer bumps the bus and Today re-fetches.
         */
        fun affectsDashboard(domain: RefreshDomain): Boolean = domain in setOf(
            RefreshDomain.Meals, RefreshDomain.Chores, RefreshDomain.Lists, RefreshDomain.Pantry,
        )

        fun affectsGoals(domain: RefreshDomain): Boolean =
            domain == RefreshDomain.Goals || domain == RefreshDomain.Rewards
    }
}
