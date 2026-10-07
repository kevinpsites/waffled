package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.RecipeRef
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.LocalDate

/** Where a plan sheet is in its config → draft → review flow. */
enum class PlanPhase { Config, Loading, Review, Empty, Failed }

/**
 * Shared state for the two AI plan sheets.
 *
 * The sheets are deliberately dumb executors of [MealPlanApply]: what an apply SENDS is a
 * tested value, not something either sheet decides inline. That split exists because with
 * the derivation inline, a revert to a single `rebuildGrocery(monthStart)` call — the
 * original grocery bug — passed every test.
 */
abstract class PlanSheetModel(
    protected val api: MealsApi,
    protected val libraryRecipes: List<RecipeRef>,
    protected val householdWeekStart: HouseholdWeekStart?,
    val familySize: Int,
) {
    protected val _phase = MutableStateFlow(PlanPhase.Config)
    protected val _suggestions = MutableStateFlow<List<PlanCardDTO>>(emptyList())
    protected val _locked = MutableStateFlow(emptySet<String>())
    protected val _draftingDates = MutableStateFlow(emptySet<String>())
    protected val _redrafting = MutableStateFlow(false)
    protected val _applying = MutableStateFlow(false)
    protected val _via = MutableStateFlow<String?>(null)
    protected val _errorMessage = MutableStateFlow<String?>(null)
    protected val _notice = MutableStateFlow<String?>(null)

    /** Dish titles shuffled away — kept out of later drafts. */
    protected val rejected = LinkedHashSet<String>()

    val phase: StateFlow<PlanPhase> = _phase.asStateFlow()
    val suggestions: StateFlow<List<PlanCardDTO>> = _suggestions.asStateFlow()
    val locked: StateFlow<Set<String>> = _locked.asStateFlow()
    val draftingDates: StateFlow<Set<String>> = _draftingDates.asStateFlow()
    val redrafting: StateFlow<Boolean> = _redrafting.asStateFlow()
    val applying: StateFlow<Boolean> = _applying.asStateFlow()
    val via: StateFlow<String?> = _via.asStateFlow()
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()
    val notice: StateFlow<String?> = _notice.asStateFlow()

    /** "Use up first" chips and the half-typed entry behind them. */
    val useUp = MutableStateFlow<List<String>>(emptyList())
    val useUpInput = MutableStateFlow("")
    val keepInMind = MutableStateFlow("")

    /** 0 means "the whole family" — omitted from the request so the server decides. */
    val cookingFor = MutableStateFlow(0)

    val servings: Int get() = cookingFor.value.takeIf { it > 0 } ?: familySize

    val unlockedDates: List<String>
        get() = _suggestions.value.map { it.date }.filterNot { it in _locked.value }

    fun toggleLock(date: String) {
        _locked.value = _locked.value.let { if (date in it) it - date else it + date }
    }

    fun backToConfig() {
        _phase.value = PlanPhase.Config
    }

    /**
     * Fold a half-typed chip entry into the list. Called on submit AND before drafting, so
     * a pending input isn't silently lost when the user taps Plan.
     */
    fun addUseUp() {
        val v = useUpInput.value.trim()
        useUpInput.value = ""
        if (v.isEmpty() || v in useUp.value || useUp.value.size >= USE_UP_CAP) return
        useUp.value = useUp.value + v
    }

    fun removeUseUp(item: String) {
        useUp.value = useUp.value - item
    }

    protected fun capped(values: List<String>): List<String>? =
        values.take(USE_UP_CAP).takeIf { it.isNotEmpty() }

    /** Merge a draft's answer in, repairing echoes and gaps from [libraryRecipes]. */
    protected fun mergeDraft(dates: List<String>, drafted: List<PlanCardDTO>, mealType: String): Boolean {
        val result = PlanDraft.resolve(
            dates = dates,
            drafted = drafted,
            prior = _suggestions.value,
            avoid = rejected.toList(),
            pool = libraryRecipes,
            mealType = mealType,
            servings = servings,
        )
        _suggestions.value = result.suggestions
        return result.changed
    }

    protected fun failWith(message: String, full: Boolean) {
        _errorMessage.value = message
        if (full) _phase.value = PlanPhase.Failed
    }

    protected companion object {
        /** The chip cap both sheets and the server agree on. */
        const val USE_UP_CAP = 12
        const val NO_RESPONSE = "The AI provider didn't respond. Check your connection and try again."
    }
}

/**
 * "Plan my week ✨" — a short config, one draft call, then a per-night review the user
 * curates (lock / swap / pick / move / reshuffle). Nothing is saved until Add.
 */
class PlanWeekModel(
    api: MealsApi,
    libraryRecipes: List<RecipeRef>,
    householdWeekStart: HouseholdWeekStart?,
    familySize: Int,
    private val start: String,
    weekDays: List<LocalDate>,
) : PlanSheetModel(api, libraryRecipes, householdWeekStart, familySize) {

    val days: List<LocalDate> = weekDays

    val mealType = MutableStateFlow("dinner")

    /** Defaults to Mon-Fri, matching the web kiosk. */
    val selectedDays = MutableStateFlow(
        weekDays.filter { it.dayOfWeek.value in 1..5 }.map(MealsFormat::ymd).toSet(),
    )

    /** A novelty nudge, plus specific dishes to feature. */
    val trySomethingNew = MutableStateFlow(false)
    val wantToTry = MutableStateFlow<List<String>>(emptyList())
    val wantToTryInput = MutableStateFlow("")

    fun toggleDay(ymd: String) {
        selectedDays.value = selectedDays.value.let { if (ymd in it) it - ymd else it + ymd }
    }

    fun addWantToTry() {
        val v = wantToTryInput.value.trim()
        wantToTryInput.value = ""
        if (v.isEmpty() || v in wantToTry.value || wantToTry.value.size >= USE_UP_CAP) return
        wantToTry.value = wantToTry.value + v
    }

    fun removeWantToTry(item: String) {
        wantToTry.value = wantToTry.value - item
    }

    suspend fun suggest() {
        addUseUp()
        addWantToTry()
        draft(selectedDays.value.sorted(), full = true)
    }

    /** Re-roll one night. */
    suspend fun swap(card: PlanCardDTO) {
        rejected.add(card.title)
        // Every other night's dish is off-limits too, so the week stays distinct.
        rejected.addAll(_suggestions.value.filter { it.date != card.date }.map { it.title })
        draft(listOf(card.date), full = false)
    }

    /** Re-roll every unlocked night, keeping the locked picks. */
    suspend fun reshuffle() {
        val dates = unlockedDates.sorted()
        rejected.addAll(_suggestions.value.filter { it.date in dates }.map { it.title })
        rejected.addAll(_suggestions.value.filter { it.date in _locked.value }.map { it.title })
        draft(dates, full = false)
    }

    /** Replace a night with a hand-picked library recipe. */
    fun pick(date: String, recipe: RecipeRef) {
        _suggestions.value.firstOrNull { it.date == date }?.let { rejected.add(it.title) }
        val card = PlanCardDTO(
            date = date, mealType = mealType.value, title = recipe.title, recipeId = recipe.id,
            emoji = recipe.emoji, servings = servings, note = "Your pick",
        )
        _suggestions.value = _suggestions.value.map { if (it.date == date) card else it }.sortedBy { it.date }
        _notice.value = null
    }

    /** Exchange two review nights. Locked nights refuse to move. */
    fun moveCard(srcDate: String, tgtDate: String) {
        PlanDraft.swapCards(_suggestions.value, srcDate, tgtDate, _locked.value)?.let {
            _suggestions.value = it
        }
    }

    private suspend fun draft(dates: List<String>, full: Boolean) {
        if (dates.isEmpty()) return
        _notice.value = null
        if (full) _phase.value = PlanPhase.Loading else {
            _redrafting.value = true
            _draftingDates.value = dates.toSet()
        }
        try {
            val result = runCatching {
                api.planWeek(
                    start = start,
                    mealType = mealType.value,
                    dates = dates,
                    cookingFor = cookingFor.value.takeIf { it > 0 },
                    keepInMind = keepInMind.value,
                    useUp = capped(useUp.value),
                    avoidTitles = rejected.toList().takeIf { it.isNotEmpty() },
                    // Novelty steering applies to the initial plan; re-rolls steer by avoid.
                    wantToTry = if (full) capped(wantToTry.value) else null,
                    trySomethingNew = if (full) trySomethingNew.value else null,
                )
            }.getOrElse { return failWith(NO_RESPONSE, full) }

            _via.value = result.via
            val err = result.error
            if (err != null && result.suggestions.isEmpty()) return failWith(MealPlanText.friendly(err), full)

            val changed = mergeDraft(dates, result.suggestions, mealType.value)
            if (_suggestions.value.isEmpty()) {
                if (full) _phase.value = PlanPhase.Empty
                return
            }
            _phase.value = PlanPhase.Review
            if (!full && !changed) {
                _notice.value = "No fresh options left for that night — tap Pick to choose any recipe."
            }
        } finally {
            _redrafting.value = false
            _draftingDates.value = emptySet()
        }
    }

    /**
     * Send the plan.
     *
     * What goes out is decided by [MealPlanApply.week] — including the case that bit us: a
     * week off the planner grid is cut on the DEVICE's first day while the grocery list is
     * keyed by the HOUSEHOLD's, so a grid week can straddle two household weeks and both
     * have to be rebuilt.
     */
    suspend fun apply(): Boolean {
        _applying.value = true
        try {
            for (op in MealPlanApply.week(_suggestions.value, householdWeekStart)) {
                runCatching { api.perform(op) }
            }
        } finally {
            _applying.value = false
        }
        return true
    }
}

/**
 * "Plan my month ✨" — guardrails (weeknights, rotation + gap, quick-weeknight cap,
 * leftovers, theme nights) → one draft of the whole month → a per-night review grouped by
 * week, which the user curates (lock / swap / pick / move / skip / reshuffle).
 */
class PlanMonthModel(
    api: MealsApi,
    libraryRecipes: List<RecipeRef>,
    householdWeekStart: HouseholdWeekStart?,
    familySize: Int,
    private val monthStart: String,
) : PlanSheetModel(api, libraryRecipes, householdWeekStart, familySize) {

    /** Mon-Fri, as day-of-week indices with Sunday = 0 (the server's convention). */
    val weekdays = MutableStateFlow(setOf(1, 2, 3, 4, 5))
    val allowRepeats = MutableStateFlow(true)
    val repeatGapDays = MutableStateFlow(7)
    val quickWeeknights = MutableStateFlow(false)
    val weeknightMax = MutableStateFlow(30)
    val leftovers = MutableStateFlow(false)
    val themes = MutableStateFlow<Map<Int, String>>(emptyMap())

    /** Dates that already had a dinner when the draft ran. */
    private val _plannedDates = MutableStateFlow(emptySet<String>())

    /** Existing nights the user has since edited — these get rewritten. */
    private val _dirty = MutableStateFlow(emptySet<String>())
    private val _skipped = MutableStateFlow(emptySet<String>())
    private val _collapsedWeeks = MutableStateFlow(emptySet<String>())

    val plannedDates: StateFlow<Set<String>> = _plannedDates.asStateFlow()
    val dirty: StateFlow<Set<String>> = _dirty.asStateFlow()
    val collapsedWeeks: StateFlow<Set<String>> = _collapsedWeeks.asStateFlow()

    fun toggleWeekday(dow: Int) {
        weekdays.value = weekdays.value.let {
            if (dow in it) {
                themes.value = themes.value - dow
                it - dow
            } else {
                it + dow
            }
        }
    }

    fun setTheme(dow: Int, key: String?) {
        themes.value = if (key == null) themes.value - dow else themes.value + (dow to key)
    }

    fun toggleWeek(key: String) {
        _collapsedWeeks.value = _collapsedWeeks.value.let { if (key in it) it - key else it + key }
    }

    /**
     * The month's nights grouped by the household week they fall in, in date order —
     * the same cut as the planner grid behind the sheet. See [MealsFormat.reviewWeekKey].
     */
    fun weekGroups(cards: List<PlanCardDTO>): List<Pair<String, List<PlanCardDTO>>> =
        cards.groupBy { MealsFormat.reviewWeekKey(it.date, householdWeekStart ?: HouseholdWeekStart.Sunday) }
            .toSortedMap()
            .map { (k, v) -> k to v.sortedBy { it.date } }

    /**
     * Drop a night from the plan. One that was originally planned gets CLEARED on save —
     * otherwise its shopping stays on the list for a dinner nobody is cooking.
     */
    fun skip(card: PlanCardDTO) {
        _suggestions.value = _suggestions.value.filterNot { it.date == card.date }
        _skipped.value = _skipped.value + card.date
    }

    fun pick(date: String, recipe: RecipeRef) {
        _suggestions.value.firstOrNull { it.date == date }?.let { rejected.add(it.title) }
        val card = PlanCardDTO(
            date = date, mealType = "dinner", title = recipe.title, recipeId = recipe.id,
            emoji = recipe.emoji, servings = servings, note = "Your pick",
        )
        _suggestions.value = _suggestions.value.map { if (it.date == date) card else it }.sortedBy { it.date }
        _dirty.value = _dirty.value + date
        _notice.value = null
    }

    /**
     * Exchange two review nights. Both ends become dirty — unlike the week sheet, an
     * already-planned month night must be REWRITTEN once its dish has changed, or the
     * apply would leave the old dinner in place.
     */
    fun moveCard(srcDate: String, tgtDate: String) {
        PlanDraft.swapCards(_suggestions.value, srcDate, tgtDate, _locked.value)?.let {
            _suggestions.value = it
            _dirty.value = _dirty.value + srcDate + tgtDate
        }
    }

    suspend fun suggest() {
        addUseUp()
        draft(emptyList(), full = true)
    }

    suspend fun swap(card: PlanCardDTO) {
        rejected.add(card.title)
        draft(listOf(card.date), full = false)
    }

    suspend fun reshuffle() {
        val dates = unlockedDates.sorted()
        rejected.addAll(_suggestions.value.filter { it.date in dates }.map { it.title })
        rejected.addAll(_suggestions.value.filter { it.date in _locked.value }.map { it.title })
        draft(dates, full = false)
    }

    private suspend fun draft(dates: List<String>, full: Boolean) {
        _notice.value = null
        if (full) _phase.value = PlanPhase.Loading else {
            _redrafting.value = true
            _draftingDates.value = dates.toSet()
        }
        try {
            val result = runCatching {
                api.planMonth(
                    start = monthStart,
                    weekdays = if (full) weekdays.value.sorted() else null,
                    skipDates = if (full) _skipped.value.sorted() else null,
                    dates = if (full) null else dates,
                    cookingFor = cookingFor.value.takeIf { it > 0 },
                    keepInMind = keepInMind.value,
                    useUp = capped(useUp.value),
                    avoidTitles = rejected.toList().takeIf { it.isNotEmpty() },
                    allowRepeats = allowRepeats.value,
                    repeatGapDays = repeatGapDays.value,
                    weekdayThemes = themes.value
                        .filterKeys { it in weekdays.value }
                        .mapKeys { it.key.toString() }
                        .takeIf { it.isNotEmpty() },
                    weeknightMaxMin = weeknightMax.value.takeIf { quickWeeknights.value },
                    leftovers = leftovers.value,
                )
            }.getOrElse { return failWith(NO_RESPONSE, full) }

            _via.value = result.via
            val err = result.error
            if (err != null && result.suggestions.isEmpty()) return failWith(MealPlanText.friendly(err), full)

            if (full) {
                // Show the WHOLE month: freshly drafted empty nights plus the nights that
                // were already planned (editable, badged "Was planned").
                _plannedDates.value = result.existing.map { it.date }.toSet()
                _dirty.value = emptySet()
                _suggestions.value = (result.suggestions + result.existing).sortedBy { it.date }
                _phase.value = if (_suggestions.value.isEmpty()) PlanPhase.Empty else PlanPhase.Review
            } else {
                val changed = mergeDraft(dates, result.suggestions, "dinner")
                // A re-drafted existing night has been edited, so it must be rewritten.
                _dirty.value = _dirty.value + result.suggestions.map { it.date }.filter { it in dates }
                if (!changed) {
                    _notice.value = "No fresh options for that night — tap Pick to choose any recipe."
                }
            }
        } finally {
            _redrafting.value = false
            _draftingDates.value = emptySet()
        }
    }

    /**
     * Send the month.
     *
     * [MealPlanApply.month] decides what goes out — which weeks the month touches, that a
     * rebuild covers only ONE of them, and that every rebuild follows every write. This is
     * deliberately just the executor: with the derivation inline it was untestable, and a
     * revert to a single rebuild call went unnoticed.
     */
    suspend fun apply(): Boolean {
        _applying.value = true
        try {
            val ops = MealPlanApply.month(
                suggestions = _suggestions.value,
                plannedDates = _plannedDates.value,
                dirty = _dirty.value,
                skipped = _skipped.value,
                firstDay = householdWeekStart,
            )
            for (op in ops) runCatching { api.perform(op) }
        } finally {
            _applying.value = false
        }
        return true
    }
}
