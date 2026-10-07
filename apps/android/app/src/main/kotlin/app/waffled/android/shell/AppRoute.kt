package app.waffled.android.shell

import app.waffled.feature.family.HubRoute
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.lists.ListSummary
import app.waffled.feature.meals.MealDTO
import app.waffled.feature.recipes.MealBuilderStart
import app.waffled.feature.recipes.RecipeDetailDTO
import app.waffled.feature.recipes.RecipeSummary
import app.waffled.feature.settings.SettingsPanelId

/**
 * A screen pushed over a tab's root — the Android twin of iOS `HubRoute` + `MealsRoute`.
 */
sealed interface AppRoute {
    /** Weekly Planning — the lobby, its steps and the recap. */
    data object Planning : AppRoute

    /** Settings, opened on [panel] (a `SettingsPanelId`) when a sub-route asks for one. */
    data class Settings(val panel: String? = null) : AppRoute

    data object Goals : AppRoute
    data class Goal(val goal: GoalsApi.Goal) : AppRoute
    data object ReviewEvents : AppRoute
    data object Chores : AppRoute
    data object Rewards : AppRoute
    data object Lists : AppRoute
    data class ListDetail(val list: ListSummary) : AppRoute
    data object Pantry : AppRoute
    data object Photos : AppRoute
    data object Approvals : AppRoute
    data object Rhythms : AppRoute
    data class Person(val personId: String) : AppRoute
    data class RewardShop(val personId: String) : AppRoute
    data class WaffledBites(val personId: String, val personName: String) : AppRoute

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
         * `DemoHooks.hubRoute`, for headless verification. `person:<id>`, `shop:<id>` and
         * `bites:<id>:<name>` carry an id.
         */
        fun fromDebugKey(key: String?): AppRoute? {
            val parts = key?.split(':').orEmpty()
            val id = parts.getOrNull(1)?.takeIf { it.isNotEmpty() }
            return when (parts.firstOrNull()) {
                "goals" -> Goals
                "chores" -> Chores
                "rewards" -> Rewards
                "lists" -> Lists
                "grocery" -> GROCERY
                "pantry" -> Pantry
                "photos" -> Photos
                "recipes" -> RecipesLibrary()
                "review" -> ReviewEvents
                "settings" -> Settings(id)
                "planning" -> Planning
                "approvals" -> Approvals
                "rhythms" -> Rhythms
                "person" -> id?.let(::Person)
                "shop" -> id?.let(::RewardShop)
                "bites" -> id?.let { WaffledBites(it, parts.getOrNull(2).orEmpty()) }
                else -> null
            }
        }

        /**
         * Where a Family-hub tap lands. Hub routes carry ids, not another feature's wire
         * type, so id-only destinations open a placeholder that the detail screen reloads.
         */
        fun fromHub(route: HubRoute): AppRoute = when (route) {
            HubRoute.Chores -> Chores
            HubRoute.Goals -> Goals
            HubRoute.Rewards -> Rewards
            HubRoute.Lists -> Lists
            HubRoute.Photos -> Photos
            HubRoute.Pantry -> Pantry
            HubRoute.Rhythms -> Rhythms
            HubRoute.Approvals -> Approvals
            HubRoute.ReviewEvents -> ReviewEvents
            HubRoute.WeeklyPlanning -> Planning
            is HubRoute.Person -> Person(route.personId)
            is HubRoute.RewardShop -> RewardShop(route.personId)
            is HubRoute.WaffledBites -> WaffledBites(route.personId, route.personName)
            is HubRoute.Goal -> Goal(GoalsApi.Goal(id = route.goalId))
            is HubRoute.ListDetail -> ListDetail(ListSummary(id = route.listId, name = "", listType = "list"))
            is HubRoute.Recipe -> Recipe(RecipeSummary(id = route.recipeId, title = ""), autoCook = route.cook)
            is HubRoute.Meal -> Meal(MealDTO.placeholder(id = route.mealId, name = ""))
            // Account has no panel of its own, so it opens the landing.
            HubRoute.Settings, HubRoute.SettingsAccount -> Settings()
            HubRoute.SettingsFamily -> Settings(SettingsPanelId.FAMILY)
            HubRoute.SettingsModules -> Settings(SettingsPanelId.MODULES)
            HubRoute.SettingsChoresRewards -> Settings(SettingsPanelId.CHORES_REWARDS)
            HubRoute.SettingsCalendars -> Settings(SettingsPanelId.CALENDARS)
            HubRoute.SettingsAI -> Settings(SettingsPanelId.AI)
            HubRoute.SettingsMeals -> Settings(SettingsPanelId.MEALS)
            HubRoute.SettingsPantry -> Settings(SettingsPanelId.PANTRY)
            HubRoute.SettingsFamilyNight -> Settings(SettingsPanelId.FAMILY_NIGHT)
            HubRoute.SettingsWeeklyPlanning -> Settings(SettingsPanelId.WEEKLY_PLANNING)
            HubRoute.SettingsDisplay -> Settings(SettingsPanelId.DISPLAY)
            HubRoute.SettingsNotifications -> Settings(SettingsPanelId.NOTIFICATIONS)
            HubRoute.SettingsAppearance -> Settings(SettingsPanelId.APPEARANCE)
            HubRoute.SettingsPermissions -> Settings(SettingsPanelId.PERMISSIONS)
            HubRoute.SettingsAbout -> Settings(SettingsPanelId.ABOUT)
        }
    }
}
