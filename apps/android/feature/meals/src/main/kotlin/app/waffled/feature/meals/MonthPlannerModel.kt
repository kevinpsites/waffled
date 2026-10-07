package app.waffled.feature.meals

import androidx.compose.runtime.Immutable
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/** One cell of the month grid, with everything the cell would otherwise recompute. */
@Immutable
data class MonthCell(
    val date: LocalDate,
    val ymd: String,
    val dayNumber: String,
    val inMonth: Boolean,
    val isToday: Boolean,
    /** The dinner planned that night, if any. */
    val entry: WeekEntryDTO?,
) {
    /** A free-text "eating out" night gets a fork; a real plate never does. */
    val emoji: String
        get() = entry?.let {
            it.recipe?.emoji ?: if (MealsFormat.isEatingOut(it)) "🍴" else "🍽️"
        } ?: "🍽️"
}

/**
 * The monthly planner's state — a 6x7 grid of the month's **dinners**, mirroring the web's
 * dinner-only month view.
 *
 * Reads the same week endpoint with a 42-day window; writes go through the same one-slot
 * upsert as the week planner, so a move here obeys the identical loss-safe ordering.
 */
class MonthPlannerModel(
    /** Public so the plan sheet can issue its own writes against the same slice. */
    val api: MealsApi,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val locale: Locale = Locale.getDefault(),
    /** The household's live `week_start` (null until synced, read as Sunday). See [WeekPlannerModel]. */
    private val firstDay: () -> HouseholdWeekStart?,
    private val refreshBus: RefreshBus? = null,
    private val today: () -> LocalDate = { MealsFormat.today(zone) },
) {

    private val _anchor = MutableStateFlow(today())
    private val _entries = MutableStateFlow<List<WeekEntryDTO>>(emptyList())
    private val _loading = MutableStateFlow(false)
    private val _moveError = MutableStateFlow<String?>(null)

    val anchor: StateFlow<LocalDate> = _anchor.asStateFlow()
    val entries: StateFlow<List<WeekEntryDTO>> = _entries.asStateFlow()
    val loading: StateFlow<Boolean> = _loading.asStateFlow()
    val moveError: StateFlow<String?> = _moveError.asStateFlow()

    private val gate = MealPlanSwap.Gate()

    val monthStart: LocalDate get() = MealsFormat.monthStart(_anchor.value)
    val monthLabel: String get() = MealsFormat.monthLabel(_anchor.value, locale)
    val monthYearLabel: String get() = MealsFormat.monthYearLabel(_anchor.value, locale)
    val isCurrentMonth: Boolean get() = MealsFormat.monthStart(today()) == monthStart

    private val cut: HouseholdWeekStart get() = firstDay() ?: HouseholdWeekStart.Sunday

    /** The column headings, opening on the household's first day like the grid. */
    val weekdaySymbols: List<String> get() = MealsFormat.weekdaySymbols(cut)

    /** The 42 cells, with their dinners already attached. */
    fun cells(entries: List<WeekEntryDTO>): List<MonthCell> {
        val start = monthStart
        val todayDate = today()
        val byDate = entries.associateBy { it.date }
        return MealsFormat.monthGridDays(start, cut).map { day ->
            val key = MealsFormat.ymd(day)
            MonthCell(
                date = day,
                ymd = key,
                dayNumber = day.dayOfMonth.toString(),
                inMonth = day.month == start.month && day.year == start.year,
                isToday = day == todayDate,
                entry = byDate[key],
            )
        }
    }

    fun dismissMoveError() {
        _moveError.value = null
    }

    // ---- loading ---------------------------------------------------------------

    suspend fun load() {
        _loading.value = true
        try {
            val start = MealsFormat.ymd(MealsFormat.monthGridStart(monthStart, cut))
            api.mealsWeekOrNull(start, days = 42)?.let { all ->
                _entries.value = all.filter { it.mealType == "dinner" }
            }
        } finally {
            _loading.value = false
        }
    }

    suspend fun reloadIfAllowed() {
        if (gate.shouldReloadNow()) load()
    }

    suspend fun step(months: Int) {
        _anchor.value = monthStart.plusMonths(months.toLong())
        reloadIfAllowed()
    }

    suspend fun jumpToThisMonth() {
        _anchor.value = today()
        reloadIfAllowed()
    }

    // ---- writes ----------------------------------------------------------------

    suspend fun plan(date: String, recipeId: String) {
        runCatching { api.planMeal(date = date, mealType = "dinner", recipeId = recipeId) }
        refreshBus?.bump(RefreshDomain.Meals)
        load()
    }

    suspend fun clear(date: String) {
        runCatching { api.clearMeal(date, "dinner") }
        refreshBus?.bump(RefreshDomain.Meals)
        load()
    }

    /**
     * Move (or swap) two nights' dinners.
     *
     * Same loss-safe ordering as the week planner: the moved meal lands in the TARGET
     * first, so a failure between the writes duplicates it rather than losing it.
     */
    suspend fun move(srcDate: String, dstDate: String) {
        val current = _entries.value
        val swapped = MealPlanSwap.apply(current, srcDate, "dinner", dstDate, "dinner") ?: return
        val plan = MealPlanSwap.writes(current, srcDate, "dinner", dstDate, "dinner") ?: return

        val snapshot = current
        // The month on screen when the move started. Paging away mid-flight and then
        // failing would otherwise write the PREVIOUS month's dinners back into `_entries`,
        // drawing last month's meals under this month's dates.
        val month = monthStart
        _entries.value = swapped
        _moveError.value = null
        gate.begin()

        var failed = false
        if (runCatching { api.perform(plan.ordered[0]) }.isSuccess) {
            if (runCatching { api.perform(plan.ordered[1]) }.isFailure) {
                failed = true
                runCatching { api.perform(plan.compensation) }
            }
        } else {
            failed = true
        }
        refreshBus?.bump(RefreshDomain.Meals)

        if (failed) {
            _moveError.value = "Couldn't move that dinner. Check your connection and try again."
            if (gate.mayApplyResult && monthStart == month) {
                _entries.value = snapshot
            } else {
                gate.requestSettleReload()
            }
        }
        if (gate.finish()) load()
    }

    /**
     * Which in-month nights this dinner may move to. Dinner-only, so the slot never
     * varies — and out-of-month cells are excluded because they belong to the neighbouring
     * month's grid rather than to this one.
     */
    fun moveTargets(srcDate: String): List<MoveTargets.Target> {
        val inMonth = cells(_entries.value).filter { it.inMonth }.map { it.ymd }
        return MoveTargets.of(_entries.value, inMonth, listOf("dinner"), srcDate, "dinner")
    }
}
