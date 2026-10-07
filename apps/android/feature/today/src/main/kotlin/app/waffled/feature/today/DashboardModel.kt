package app.waffled.feature.today

import androidx.compose.runtime.Immutable
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.RestDomain
import app.waffled.core.network.RestFetch
import app.waffled.core.network.RestState
import app.waffled.core.model.Person
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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
 * Each domain lives in its own [RestDomain] and exposes its [RestState] independently. A
 * failed fetch keeps confirmed values and reports why (stale, offline, sign-in); only a
 * successful response authorises empty copy. The fetchers THROW rather than return null,
 * so the failure can be classified.
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
    private val fetchMeals: suspend (String) -> List<TodayApi.WeekEntry>,
    private val fetchChores: suspend () -> List<TodayApi.PersonChores>,
    private val fetchGrocery: suspend () -> List<TodayApi.GroceryItem>,
    private val fetchGoals: suspend () -> List<TodayApi.Goal>,
    private val fetchRecap: suspend () -> List<TodayApi.GoalRecapItem>,
    private val fetchSuggestions: suspend () -> List<TodayApi.GoalSuggestionItem>,
    /**
     * Current conditions for the greeting row. Defaulted so the ported spec tests, which
     * know nothing about weather, construct the model unchanged.
     */
    private val fetchWeather: suspend () -> TodayApi.Weather? = { null },
    private val fetchChoreInstances: suspend (String) -> List<TodayApi.ChoreInstance> = { emptyList() },
    /** (instance id, true = complete / false = uncomplete). */
    private val setChoreComplete: suspend (String, Boolean) -> Unit = { _, _ -> },
) {

    private val tonightD = RestDomain<List<TonightMeal>>()
    private val choresD = RestDomain<List<TodayApi.PersonChores>>()
    private val groceryD = RestDomain<Int>(isEmpty = { it == 0 })
    private val goalsD = RestDomain<List<TodayApi.Goal>>()
    private val recapD = RestDomain<List<TodayApi.GoalRecapItem>>()
    private val suggestionsD = RestDomain<List<TodayApi.GoalSuggestionItem>>()
    private val weatherD = RestDomain<TodayApi.Weather>()

    /** Per-card snapshots the composables collect, so one slow card never blocks another. */
    val tonightSnapshot: StateFlow<RestDomain.Snapshot<List<TonightMeal>>> = tonightD.state
    val choresSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.PersonChores>>> = choresD.state
    val grocerySnapshot: StateFlow<RestDomain.Snapshot<Int>> = groceryD.state
    val goalsSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.Goal>>> = goalsD.state
    val recapSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.GoalRecapItem>>> = recapD.state
    val suggestionsSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.GoalSuggestionItem>>> =
        suggestionsD.state
    val weatherSnapshot: StateFlow<RestDomain.Snapshot<TodayApi.Weather>> = weatherD.state

    val tonight: TonightMeal? get() = tonightD.value?.firstOrNull()
    val chores: List<TodayApi.PersonChores> get() = choresD.value.orEmpty()
    val groceryRemaining: Int get() = groceryD.value ?: 0

    val mealsState: RestState get() = tonightD.restState
    val choresState: RestState get() = choresD.restState
    val groceryState: RestState get() = groceryD.restState
    val goalsState: RestState get() = goalsD.restState
    val reviewState: RestState get() = RestState.combined(listOf(recapD.restState, suggestionsD.restState))

    /** The meals/chores/grocery domains all hold an authoritative answer. */
    val loaded: Boolean
        get() = mealsState.isAuthoritative && choresState.isAuthoritative && groceryState.isAuthoritative

    val goals: List<TodayApi.Goal> get() = goalsD.value.orEmpty()
    val reviewRecap: List<TodayApi.GoalRecapItem> get() = recapD.value.orEmpty()
    val reviewSuggestions: List<TodayApi.GoalSuggestionItem> get() = suggestionsD.value.orEmpty()

    /**
     * The goals card keys its empty state off THIS, not [loaded]: the dash fetch usually
     * finishes first, which used to flash "Set a family goal →" before goals arrived.
     */
    val goalsLoaded: Boolean get() = goalsState.isAuthoritative

    val weather: TodayApi.Weather? get() = weatherD.value

    private var loadGeneration = 0
    private var goalsGeneration = 0

    /**
     * Today's individual chores, behind the card's one-person view. The per-person totals
     * above stay the server's (stars are approval-aware), never summed from these.
     */
    private val choreInstancesD = RestDomain<List<TodayApi.ChoreInstance>>()
    val choreInstancesSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.ChoreInstance>>> =
        choreInstancesD.state
    val choreInstances: List<TodayApi.ChoreInstance> get() = choreInstancesD.value.orEmpty()
    val choreInstancesState: RestState get() = choreInstancesD.restState

    /** Everyone the chores call knows, including people with nothing due — the picker. */
    private val _choreRoster = MutableStateFlow<List<TodayApi.PersonChores>>(emptyList())
    val choreRoster: StateFlow<List<TodayApi.PersonChores>> = _choreRoster.asStateFlow()

    private val togglingChoreIds = mutableSetOf<String>()

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
        val generation = ++loadGeneration
        tonightD.beginLoading(); choresD.beginLoading(); groceryD.beginLoading()
        choreInstancesD.beginLoading()
        // Each fetch is wrapped inside its own async: a bare throw would cancel siblings.
        val meals = async { RestFetch.result { fetchMeals(todayKey) } }
        val people = async { RestFetch.result { fetchChores() } }
        val grocery = async { RestFetch.result { fetchGrocery() } }
        val instances = async { RestFetch.result { fetchChoreInstances(todayKey) } }
        val m = meals.await(); val c = people.await(); val g = grocery.await()
        val i = instances.await()
        if (generation != loadGeneration) return@coroutineScope

        c.getOrNull()?.let { _choreRoster.value = it }
        choreInstancesD.apply(i)

        tonightD.apply(
            m.map { entries ->
                entries.filter { it.mealType == "dinner" && it.date == todayKey }
                    .take(1)
                    .map { TonightMeal(it) }
            },
        )
        // People with nothing on today's board are dropped — an empty avatar row reads
        // as a bug, not as "nothing assigned".
        choresD.apply(c.map { all -> all.filter { it.total > 0 } })
        groceryD.apply(g.map { items -> items.count { !it.checked } })
    }

    /**
     * Tick or untick in place, optimistically; a failed write puts the row back. The caller
     * bumps the chores bus on success so the totals and approvals reload. A second tap
     * mid-write would race the first one's rollback, so it is ignored.
     */
    suspend fun toggleChore(inst: TodayApi.ChoreInstance): Boolean {
        if (inst.id in togglingChoreIds) return false
        val current = choreInstances.firstOrNull { it.id == inst.id } ?: return false
        togglingChoreIds += inst.id
        try {
            val previous = current.status
            setInstanceStatus(inst.id, TodayChoreRules.toggledStatus(current))
            val sent = try {
                RestFetch.result { setChoreComplete(inst.id, previous == TodayApi.STATUS_PENDING) }
            } catch (cancelled: CancellationException) {
                setInstanceStatus(inst.id, previous)
                throw cancelled
            }
            if (sent.isFailure) setInstanceStatus(inst.id, previous)
            return sent.isSuccess
        } finally {
            togglingChoreIds -= inst.id
        }
    }

    private fun setInstanceStatus(id: String, status: String) {
        choreInstancesD.mutate { rows -> rows?.map { if (it.id == id) it.copy(status = status) else it } }
    }

    /**
     * Load the goals card + the goal↔calendar review queues concurrently. Same failure
     * semantics as [load].
     */
    suspend fun loadGoals() = coroutineScope {
        val generation = ++goalsGeneration
        goalsD.beginLoading(); recapD.beginLoading(); suggestionsD.beginLoading()
        val goalRows = async { RestFetch.result { fetchGoals() } }
        val recapRows = async { RestFetch.result { fetchRecap() } }
        val suggestionRows = async { RestFetch.result { fetchSuggestions() } }
        val g = goalRows.await(); val r = recapRows.await(); val s = suggestionRows.await()
        if (generation != goalsGeneration) return@coroutineScope

        goalsD.apply(g)
        recapD.apply(r)
        suggestionsD.apply(s)
    }

    /** The greeting's temperature chip. Its own load: nothing else waits on the weather. */
    suspend fun loadWeather() {
        weatherD.apply(RestFetch.result { fetchWeather() }.getOrNull())
    }

    companion object {
        /** The production wiring. Fetchers throw; the model classifies the failure. */
        fun from(api: TodayApi) = DashboardModel(
            fetchMeals = { api.mealsWeek(it) },
            fetchChores = { api.choresToday() },
            fetchGrocery = { api.groceryItems() },
            fetchGoals = { api.goals() },
            fetchRecap = { api.goalRecap() },
            fetchSuggestions = { api.goalSuggestions() },
            fetchWeather = { api.weather() },
            fetchChoreInstances = { api.choreInstances(it) },
            setChoreComplete = { id, complete ->
                if (complete) api.completeChore(id) else api.uncompleteChore(id)
            },
        )

        /** The stored pick that means "the whole family" rather than one person. */
        const val FAMILY_CHORES_KEY = "family"

        /**
         * Everyone the chores card can show: the synced members, then anyone the chores
         * call knows that sync hasn't delivered yet, so the picker works before first sync.
         */
        fun chorePeople(synced: List<Person>, roster: List<TodayApi.PersonChores>): List<ChorePerson> {
            val fromSync = synced.map { ChorePerson(it.id, it.name, it.avatarEmoji, it.colorHex) }
            val known = fromSync.mapTo(HashSet()) { it.id }
            return fromSync + roster.filter { it.id !in known }
                .map { ChorePerson(it.id, it.name, it.avatarEmoji, it.colorHex) }
        }

        /**
         * Whose chores the card shows; null is the family summary. An empty [stored] means
         * "me", and a pick who is no longer a member falls back the same way.
         */
        fun chorePersonId(
            stored: String,
            currentPersonId: String?,
            fallbackId: String?,
            memberIds: Set<String>,
        ): String? = when {
            stored == FAMILY_CHORES_KEY -> null
            stored in memberIds -> stored
            currentPersonId != null && currentPersonId in memberIds -> currentPersonId
            fallbackId != null && fallbackId in memberIds -> fallbackId
            else -> null
        }

        /** One person's chores. Up-for-grabs rows stay on the Chores screen, which claims them. */
        fun chores(personId: String, instances: List<TodayApi.ChoreInstance>): List<TodayApi.ChoreInstance> =
            TodayChoreRules.sort(instances.filter { it.personId == personId })

        fun needsPhotoToFinish(inst: TodayApi.ChoreInstance): Boolean = TodayChoreRules.needsPhotoToFinish(inst)

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
