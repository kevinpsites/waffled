package app.waffled.feature.kiosktoday

import app.waffled.core.network.RestDomain
import app.waffled.core.network.RestFetch
import app.waffled.core.network.RestState
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.lists.ListItemDTO
import app.waffled.feature.lists.ListsApi
import app.waffled.feature.today.TodayApi
import app.waffled.feature.today.TonightMeal
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.coroutineScope

/** Tonight's dinner plus the week's dinners, sorted by date. */
data class KioskMeals(val tonight: TonightMeal? = null, val week: List<TodayApi.WeekEntry> = emptyList())

/**
 * REST-backed state for the iPad-style Today page — chores, dinners, the grocery board
 * (with optimistic check-off), goals and weather. Port of iOS `KioskTodayModel`.
 *
 * Each domain is its own [RestDomain], so a fast fetch can't flash a slower card's empty
 * state and a network blip on the always-on display never blanks a card that has data.
 * Fetchers throw on failure so the failure is classified (offline / sign-in / stale).
 */
class KioskTodayModel(
    private val fetchChores: suspend () -> List<TodayApi.PersonChores>,
    private val fetchMeals: suspend (String) -> List<TodayApi.WeekEntry>,
    private val fetchGrocery: suspend () -> List<ListItemDTO>,
    private val fetchGoals: suspend () -> List<GoalsApi.Goal>,
    private val fetchWeather: suspend () -> TodayApi.Weather?,
    private val addGroceryItem: suspend (String) -> Unit = {},
    private val setGroceryChecked: suspend (String, Boolean) -> Unit = { _, _ -> },
    private val fetchRecap: suspend () -> List<TodayApi.GoalRecapItem> = { emptyList() },
    private val fetchSuggestions: suspend () -> List<TodayApi.GoalSuggestionItem> = { emptyList() },
) {
    private val recapD = RestDomain<List<TodayApi.GoalRecapItem>>()
    private val suggestionsD = RestDomain<List<TodayApi.GoalSuggestionItem>>()
    val recapSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.GoalRecapItem>>> = recapD.state
    val suggestionsSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.GoalSuggestionItem>>> = suggestionsD.state
    val reviewRecap: List<TodayApi.GoalRecapItem> get() = recapD.value.orEmpty()
    val reviewSuggestions: List<TodayApi.GoalSuggestionItem> get() = suggestionsD.value.orEmpty()
    val reviewState: RestState get() = RestState.combined(listOf(recapD.restState, suggestionsD.restState))

    private val choresD = RestDomain<List<TodayApi.PersonChores>>()
    private val mealsD = RestDomain<KioskMeals>(isEmpty = { it.tonight == null && it.week.isEmpty() })
    private val groceryD = RestDomain<List<ListItemDTO>>()
    private val goalsD = RestDomain<List<GoalsApi.Goal>>()

    val choresSnapshot: StateFlow<RestDomain.Snapshot<List<TodayApi.PersonChores>>> = choresD.state
    val mealsSnapshot: StateFlow<RestDomain.Snapshot<KioskMeals>> = mealsD.state
    val grocerySnapshot: StateFlow<RestDomain.Snapshot<List<ListItemDTO>>> = groceryD.state
    val goalsSnapshot: StateFlow<RestDomain.Snapshot<List<GoalsApi.Goal>>> = goalsD.state

    private val _weather = MutableStateFlow<TodayApi.Weather?>(null)
    val weather: StateFlow<TodayApi.Weather?> = _weather.asStateFlow()

    /** Rows just checked off, held on screen briefly so the tap reads before they leave. */
    private val _settling = MutableStateFlow<Set<String>>(emptySet())
    val settling: StateFlow<Set<String>> = _settling.asStateFlow()

    val chores: List<TodayApi.PersonChores> get() = choresD.value.orEmpty()
    val tonight: TonightMeal? get() = mealsD.value?.tonight
    val weekDinners: List<TodayApi.WeekEntry> get() = mealsD.value?.week.orEmpty()
    val grocery: List<ListItemDTO> get() = groceryD.value.orEmpty()
    val groceryActive: List<ListItemDTO> get() = activeGrocery(grocery, _settling.value)
    val goals: List<GoalsApi.Goal> get() = goalsD.value.orEmpty()

    val choresState: RestState get() = choresD.restState
    val mealsState: RestState get() = mealsD.restState
    val groceryState: RestState get() = groceryD.restState
    val goalsState: RestState get() = goalsD.restState
    val choresLoaded: Boolean get() = choresState.isAuthoritative
    val mealsLoaded: Boolean get() = mealsState.isAuthoritative
    val groceryLoaded: Boolean get() = groceryState.isAuthoritative
    val goalsLoaded: Boolean get() = goalsState.isAuthoritative

    private val toggling = mutableSetOf<String>()

    suspend fun load(todayKey: String) = coroutineScope {
        launch { loadChores() }
        launch { loadMeals(todayKey) }
        launch { loadGrocery() }
        launch { loadWeather() }
        launch { loadGoals() }
    }

    suspend fun loadChores() {
        choresD.beginLoading()
        // People with nothing assigned today drop out — an empty ring reads as a bug.
        choresD.apply(RestFetch.result { fetchChores() }.map { all -> all.filter { it.total > 0 } })
    }

    suspend fun loadMeals(todayKey: String) {
        mealsD.beginLoading()
        mealsD.apply(
            RestFetch.result { fetchMeals(todayKey) }.map { entries ->
                val dinners = entries.filter { it.mealType == "dinner" }
                KioskMeals(
                    tonight = dinners.firstOrNull { it.date == todayKey }?.let { TonightMeal(it) },
                    week = dinners.sortedBy { it.date },
                )
            },
        )
    }

    suspend fun loadGrocery() {
        groceryD.beginLoading()
        groceryD.apply(RestFetch.result { fetchGrocery() })
    }

    suspend fun loadGoals() {
        goalsD.beginLoading()
        goalsD.apply(RestFetch.result { fetchGoals() })
    }

    /** The goal↔calendar review queues behind the "Review & log" banner. */
    suspend fun loadReview() = coroutineScope {
        recapD.beginLoading(); suggestionsD.beginLoading()
        launch { recapD.apply(RestFetch.result { fetchRecap() }) }
        launch { suggestionsD.apply(RestFetch.result { fetchSuggestions() }) }
    }

    suspend fun loadWeather() {
        RestFetch.result { fetchWeather() }.getOrNull()?.let { _weather.value = it }
    }

    suspend fun addGrocery(name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        RestFetch.result { addGroceryItem(trimmed) }
        loadGrocery()
    }

    /**
     * Check or uncheck in place, optimistically; a failed write puts the row back. A
     * checked row settles out after [SETTLE_MILLIS], scheduled on [scope] so it outlives
     * this call. A second tap mid-write would race the rollback, so it is ignored.
     */
    suspend fun toggleGrocery(id: String, scope: CoroutineScope) {
        if (id in toggling) return
        val current = grocery.firstOrNull { it.id == id } ?: return
        val target = !current.checked
        toggling += id
        try {
            setChecked(id, target)
            if (target) {
                _settling.update { it + id }
                scope.launch {
                    delay(SETTLE_MILLIS)
                    if (grocery.firstOrNull { it.id == id }?.checked == true) _settling.update { it - id }
                }
            } else {
                _settling.update { it - id }
            }
            val sent = try {
                RestFetch.result { setGroceryChecked(id, target) }
            } catch (cancelled: CancellationException) {
                setChecked(id, !target)
                throw cancelled
            }
            if (sent.isFailure) {
                setChecked(id, !target)
                _settling.update { it - id }
            }
        } finally {
            toggling -= id
        }
    }

    private fun setChecked(id: String, checked: Boolean) {
        groceryD.mutate { rows -> rows?.map { if (it.id == id) it.copy(checked = checked) else it } }
    }

    companion object {
        const val SETTLE_MILLIS = 2_000L

        /** Unchecked rows, plus checked ones still settling. */
        fun activeGrocery(items: List<ListItemDTO>, settling: Set<String>): List<ListItemDTO> =
            items.filter { !it.checked || it.id in settling }

        /** The production wiring. The grocery rows come from the board, as on iOS. */
        fun from(today: TodayApi, lists: ListsApi, goals: GoalsApi) = KioskTodayModel(
            fetchChores = { today.choresToday() },
            fetchMeals = { today.mealsWeek(it) },
            fetchGrocery = { lists.groceryBoard().items },
            fetchGoals = { goals.goalsIn(null) },
            fetchWeather = { today.weather() },
            addGroceryItem = { lists.addGroceryItem(it) },
            setGroceryChecked = { id, checked -> lists.patchItem(id, checked = checked) },
            fetchRecap = { today.goalRecap() },
            fetchSuggestions = { today.goalSuggestions() },
        )
    }
}
