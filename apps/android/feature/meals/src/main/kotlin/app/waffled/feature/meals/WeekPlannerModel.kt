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

/**
 * One day of the week list, with everything the row would otherwise recompute per frame.
 *
 * Building the labels and the per-slot lookup at LOAD time is the point: a scrolling list
 * recomposes constantly and date formatting in a row is the documented performance trap
 * inherited from iOS.
 */
@Immutable
data class PlannerDay(
    val date: LocalDate,
    val ymd: String,
    val weekdayLabel: String,
    val dayLabel: String,
    val isToday: Boolean,
    /** The planned entries for this day, in meal order. */
    val entries: List<WeekEntryDTO>,
) {
    fun entry(slot: String): WeekEntryDTO? = entries.firstOrNull { it.mealType == slot }
}

/**
 * The weekly planner's state — a day-by-day view of what is planned, with plan / change /
 * clear / move.
 *
 * Meal plans are REST-only (not a synced table), so every write goes to the server and the
 * week is reloaded; there is no local mirror to lean on. That is also why a move is
 * applied OPTIMISTICALLY and then committed in [MealPlanSwap.writes]' loss-safe order.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls, so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule.
 */
class WeekPlannerModel(
    /** Public so the plan sheet can issue its own writes against the same slice. */
    val api: MealsApi,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val locale: Locale = Locale.getDefault(),
    /**
     * The household's live `week_start` (null until synced, read as Sunday). A provider
     * so the grid follows the setting without rebuilding the model; no default, because
     * a forgotten one would silently cut every week on Sunday.
     */
    private val firstDay: () -> HouseholdWeekStart?,
    private val refreshBus: RefreshBus? = null,
    /**
     * Today, in the household's timezone. A provider rather than a constant so the week on
     * screen follows the clock across midnight — and so a test can pin a week instead of
     * having its fixtures rot the moment the real date moves on.
     */
    private val today: () -> LocalDate = { MealsFormat.today(zone) },
) {

    /** The meal rows the phone list offers an add button for, in the order a day reads. */
    val primarySlots = listOf("breakfast", "lunch", "dinner")

    /** Every slot a meal may be moved into — snacks included, since one can exist. */
    val allSlots = listOf("breakfast", "lunch", "dinner", "snack")

    private val _entries = MutableStateFlow<List<WeekEntryDTO>>(emptyList())
    private val _weekOffset = MutableStateFlow(0)
    private val _loading = MutableStateFlow(false)
    private val _moveError = MutableStateFlow<String?>(null)

    val entries: StateFlow<List<WeekEntryDTO>> = _entries.asStateFlow()
    val weekOffset: StateFlow<Int> = _weekOffset.asStateFlow()
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    /** A move the server rejected — shown as a dismissible banner. */
    val moveError: StateFlow<String?> = _moveError.asStateFlow()

    /**
     * One in-flight discipline for the optimistic moves. Every reload path asks the gate
     * first, so a half-committed move can never be fetched over the optimistic (or
     * rolled-back) entries, and the last move to settle replays exactly one reload.
     */
    private val gate = MealPlanSwap.Gate()

    /** The day the grid starts on — the household's first day, never the device's. */
    val weekStart: LocalDate
        get() = MealsFormat.weekStart(today(), firstDay() ?: HouseholdWeekStart.Sunday, _weekOffset.value)

    val weekDays: List<LocalDate> get() = MealsFormat.weekDays(weekStart)

    val weekLabel: String get() = MealsFormat.weekRangeLabel(weekStart, locale)

    val isThisWeek: Boolean get() = _weekOffset.value == 0

    /** The week as rows, with the labels and per-day entries precomputed. */
    fun days(entries: List<WeekEntryDTO>): List<PlannerDay> {
        val todayDate = today()
        val byDate = entries.groupBy { it.date }
        return weekDays.map { day ->
            val key = MealsFormat.ymd(day)
            PlannerDay(
                date = day,
                ymd = key,
                weekdayLabel = MealsFormat.weekdayShort(day, locale),
                dayLabel = MealsFormat.monthDay(day, locale),
                isToday = day == todayDate,
                entries = byDate[key].orEmpty().sortedBy { MealsFormat.slotOrder(it.mealType) },
            )
        }
    }

    /** Whether any night this week has no dinner — drives the "Plan my week" CTA. */
    fun hasEmptyNight(entries: List<WeekEntryDTO>): Boolean {
        val planned = entries.filter { it.mealType == "dinner" }.map { it.date }.toSet()
        return weekDays.any { MealsFormat.ymd(it) !in planned }
    }

    fun dismissMoveError() {
        _moveError.value = null
    }

    // ---- loading ---------------------------------------------------------------

    /**
     * Fetch the shown week.
     *
     * A failed fetch keeps what is already on screen instead of blanking the week — the
     * user may be offline right after a rolled-back move, and pull-to-refresh retries.
     */
    suspend fun load() {
        _loading.value = true
        try {
            api.mealsWeekOrNull(MealsFormat.ymd(weekStart))?.let { _entries.value = it }
        } finally {
            _loading.value = false
        }
    }

    /** A reload trigger — week paging, pull-to-refresh, a refresh-bus bump. */
    suspend fun reloadIfAllowed() {
        if (gate.shouldReloadNow()) load()
    }

    suspend fun step(weeks: Int) {
        _weekOffset.value += weeks
        reloadIfAllowed()
    }

    suspend fun jumpToThisWeek() {
        _weekOffset.value = 0
        reloadIfAllowed()
    }

    // ---- writes ----------------------------------------------------------------

    /** Plan a slot with a picked recipe, replacing whatever was there. */
    suspend fun plan(date: String, mealType: String, recipeId: String) {
        runCatching { api.planMeal(date = date, mealType = mealType, recipeId = recipeId) }
        refreshBus?.bump(RefreshDomain.Meals)
        load()
    }

    /** Clear a planned slot. */
    suspend fun clear(date: String, mealType: String) {
        runCatching { api.clearMeal(date, mealType) }
        refreshBus?.bump(RefreshDomain.Meals)
        load()
    }

    /**
     * Move (or swap) the meal at the source slot onto the target.
     *
     * The entries change the moment the user confirms — meal plans are REST-only, with no
     * local write to lean on — and the writes then commit in [MealPlanSwap.writes]' order:
     * the moved meal is upserted into the TARGET first (its own row untouched), and only
     * then is the source rewritten. A failure between the two therefore leaves the meal
     * planned twice (recoverable), never zero times, and a compensating write best-effort
     * restores the target.
     *
     * On failure the entries either roll back locally — only when this is the sole move in
     * flight, so the server is known untouched — or are left to the settle reload, because
     * against a half-committed server, fetched truth beats a guess.
     */
    suspend fun move(srcDate: String, srcSlot: String, dstDate: String, dstSlot: String) {
        val current = _entries.value
        val swapped = MealPlanSwap.apply(current, srcDate, srcSlot, dstDate, dstSlot) ?: return
        val plan = MealPlanSwap.writes(current, srcDate, srcSlot, dstDate, dstSlot) ?: return

        val snapshot = current
        val week = MealsFormat.ymd(weekStart)
        _entries.value = swapped
        _moveError.value = null
        gate.begin()

        var failed = false
        if (runCatching { api.perform(plan.ordered[0]) }.isSuccess) {
            if (runCatching { api.perform(plan.ordered[1]) }.isFailure) {
                failed = true
                // The moved meal is now in both slots. Restoring the target returns the
                // server to its exact pre-move state; if even this fails the duplicate is
                // visible and fixable — the meal is never lost.
                runCatching { api.perform(plan.compensation) }
            }
        } else {
            failed = true
        }
        refreshBus?.bump(RefreshDomain.Meals)

        if (failed) {
            _moveError.value = "Couldn't move that meal. Check your connection and try again."
            if (gate.mayApplyResult && MealsFormat.ymd(weekStart) == week) {
                _entries.value = snapshot
            } else {
                gate.requestSettleReload()
            }
        }
        // Settle LAST, after any rollback, so no reload can slip in between the decrement
        // and the entries write. The replayed load doubles as the success-path reconcile.
        if (gate.finish()) load()
    }

    /** Where the meal in this slot may move to, for the move sheet. */
    fun moveTargets(srcDate: String, srcSlot: String): List<MoveTargets.Target> =
        MoveTargets.of(_entries.value, weekDays.map(MealsFormat::ymd), allSlots, srcDate, srcSlot)
}
