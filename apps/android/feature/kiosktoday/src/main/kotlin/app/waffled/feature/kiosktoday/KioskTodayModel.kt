package app.waffled.feature.kiosktoday

import app.waffled.core.network.RestState
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.lists.ListItemDTO
import app.waffled.feature.today.TodayApi
import app.waffled.feature.today.TonightMeal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class KioskMeals(val tonight: TonightMeal? = null, val week: List<TodayApi.WeekEntry> = emptyList())

class KioskTodayModel(
    private val fetchChores: suspend () -> List<TodayApi.PersonChores>,
    private val fetchMeals: suspend (String) -> List<TodayApi.WeekEntry>,
    private val fetchGrocery: suspend () -> List<ListItemDTO>,
    private val fetchGoals: suspend () -> List<GoalsApi.Goal>,
    private val fetchWeather: suspend () -> TodayApi.Weather?,
    private val addGroceryItem: suspend (String) -> Unit = {},
    private val setGroceryChecked: suspend (String, Boolean) -> Unit = { _, _ -> },
) {
    val chores: List<TodayApi.PersonChores> get() = emptyList()
    val tonight: TonightMeal? get() = null
    val weekDinners: List<TodayApi.WeekEntry> get() = emptyList()
    val grocery: List<ListItemDTO> get() = emptyList()
    val groceryActive: List<ListItemDTO> get() = emptyList()
    val goals: List<GoalsApi.Goal> get() = emptyList()
    val weather: StateFlow<TodayApi.Weather?> = MutableStateFlow(null)

    val choresState: RestState get() = RestState.Loading
    val mealsState: RestState get() = RestState.Loading
    val groceryState: RestState get() = RestState.Loading
    val goalsState: RestState get() = RestState.Loading
    val choresLoaded: Boolean get() = true
    val mealsLoaded: Boolean get() = true
    val groceryLoaded: Boolean get() = true
    val goalsLoaded: Boolean get() = true

    suspend fun load(todayKey: String) {}
    suspend fun loadChores() {}
    suspend fun loadMeals(todayKey: String) {}
    suspend fun loadGrocery() {}
    suspend fun loadGoals() {}
    suspend fun loadWeather() {}
    suspend fun addGrocery(name: String) {}
    suspend fun toggleGrocery(id: String, scope: CoroutineScope) {}

    companion object {
        const val SETTLE_MILLIS = 2_000L
    }
}
