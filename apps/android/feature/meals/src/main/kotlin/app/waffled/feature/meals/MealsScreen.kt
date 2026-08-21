package app.waffled.feature.meals

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.waffled.core.design.WF
import app.waffled.core.model.RecipeRef
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.flow.filter

/** The three sections of the Meals tab. */
enum class MealsSection(val label: String) {
    Week("Week"),
    Month("Month"),
    Recipes("Recipes"),
}

/**
 * The Meals tab shell: a segmented Week / Month / Recipes switch over the two planners and
 * a host-supplied recipes section.
 *
 * **The recipes half is a slot, not a dependency.** The recipe library, its detail, the
 * editor, Meal Builder and Cook Mode belong to the recipes feature; this module is the
 * PLANNER and meets recipes only through three seams:
 *
 * - [recipesTab] renders whatever the host wants under the third segment,
 * - [recipePicker] answers a pick with a [RecipeRef] (`core:model`),
 * - [onOpenRecipe] hands a recipe id back for the host to route.
 *
 * That keeps the two features buildable in parallel and stops either one growing a copy of
 * the other's wire types.
 */
@Composable
fun MealsScreen(
    weekModel: WeekPlannerModel,
    monthModel: MonthPlannerModel,
    /**
     * The household's `week_start`, or **null when no household row has synced yet**.
     *
     * Null is not "Sunday": an unknown preference makes an apply rebuild BOTH week cuts,
     * which is idempotent, where guessing wrong leaves a week of shopping unbuilt. See
     * [GroceryWeeks.weekStarts].
     */
    householdWeekStart: HouseholdWeekStart?,
    familySize: Int,
    /** The pool the plan sheets fall back to when the model repeats or skips a night. */
    libraryRecipes: List<RecipeRef>,
    onOpenRecipe: (String) -> Unit,
    onOpenMeal: (MealDTO) -> Unit,
    recipePicker: @Composable (onPick: (RecipeRef) -> Unit, onDismiss: () -> Unit) -> Unit,
    recipesTab: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    refreshBus: RefreshBus? = null,
    initialSection: MealsSection = MealsSection.Week,
) {
    var section by rememberSaveable { mutableStateOf(initialSection) }

    LaunchedEffect(weekModel) { weekModel.load() }
    LaunchedEffect(monthModel) { monthModel.load() }

    // Meals are REST-only, so nothing else would ever tell these screens a plan changed —
    // the bus is the only channel. Both planners ask their gate first, so a bump arriving
    // mid-move is deferred rather than fetching half-committed state.
    if (refreshBus != null) {
        LaunchedEffect(refreshBus) {
            refreshBus.events.filter { it == RefreshDomain.Meals }.collect {
                weekModel.reloadIfAllowed()
                monthModel.reloadIfAllowed()
            }
        }
    }

    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        Box(
            Modifier
                .statusBarsPadding()
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            SegmentedRow(
                options = MealsSection.entries.map { it.name },
                selected = section.name,
                label = { name -> MealsSection.valueOf(name).label },
                onSelect = { section = MealsSection.valueOf(it) },
            )
        }
        when (section) {
            MealsSection.Week -> WeekPlannerScreen(
                model = weekModel,
                householdWeekStart = householdWeekStart,
                familySize = familySize,
                libraryRecipes = libraryRecipes,
                onOpenRecipe = onOpenRecipe,
                onOpenMeal = onOpenMeal,
                recipePicker = recipePicker,
            )
            MealsSection.Month -> MonthPlannerScreen(
                model = monthModel,
                householdWeekStart = householdWeekStart,
                familySize = familySize,
                libraryRecipes = libraryRecipes,
                onOpenRecipe = onOpenRecipe,
                onOpenMeal = onOpenMeal,
                recipePicker = recipePicker,
            )
            MealsSection.Recipes -> recipesTab()
        }
    }
}
