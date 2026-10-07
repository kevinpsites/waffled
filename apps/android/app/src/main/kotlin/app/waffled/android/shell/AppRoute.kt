package app.waffled.android.shell

import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.lists.ListSummary
import app.waffled.feature.meals.MealDTO
import app.waffled.feature.recipes.MealBuilderStart
import app.waffled.feature.recipes.RecipeDetailDTO
import app.waffled.feature.recipes.RecipeSummary

/**
 * A screen pushed over a tab's root — the Android twin of iOS `HubRoute` + `MealsRoute`.
 * Only destinations that exist on Android are here; Settings, Family, Rhythms, Planning
 * and the person spotlight land with their own waves.
 */
sealed interface AppRoute {
    data object Goals : AppRoute
    data class Goal(val goal: GoalsApi.Goal) : AppRoute
    data object ReviewEvents : AppRoute
    data object Chores : AppRoute
    data object Rewards : AppRoute
    data object Lists : AppRoute
    data class ListDetail(val list: ListSummary) : AppRoute
    data object Pantry : AppRoute
    data object Photos : AppRoute

    /** A recipe's detail; [autoCook] opens Cook Mode once the steps load (Today's Cook button). */
    data class Recipe(val summary: RecipeSummary, val autoCook: Boolean = false) : AppRoute

    /** One plate's detail. Meals owns the screen, so it carries the meals-side DTO. */
    data class Meal(val meal: MealDTO) : AppRoute
    data class RecipesLibrary(val protein: String? = null, val newOnly: Boolean = false) : AppRoute
    data class RecipeEditor(val editing: RecipeDetailDTO? = null) : AppRoute
    data class MealBuilder(val start: MealBuilderStart) : AppRoute

    companion object {
        /** iOS `TodayView.grocerySummary` — the grocery board as a list to push. */
        val GROCERY = ListDetail(ListSummary(id = "grocery", name = "Grocery", emoji = "🛒", listType = "grocery"))

        /**
         * Debug deep links (`am start … --es waffled.route goals`) — the twin of iOS
         * `DemoHooks.hubRoute`, for headless verification.
         */
        fun fromDebugKey(key: String?): AppRoute? = when (key) {
            "goals" -> Goals
            "chores" -> Chores
            "rewards" -> Rewards
            "lists" -> Lists
            "grocery" -> GROCERY
            "pantry" -> Pantry
            "photos" -> Photos
            "recipes" -> RecipesLibrary()
            "review" -> ReviewEvents
            else -> null
        }
    }
}
