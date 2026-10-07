package app.waffled.feature.family

/**
 * Every destination the Family hub (and Today) can push — the port of the iOS `HubRoute`.
 *
 * The table lives here so it can be tested; RENDERING a route is the `app` module's job,
 * because nearly every destination belongs to another feature. Routes carry ids rather
 * than another feature's wire type, so this module never depends on one.
 */
sealed interface HubRoute {
    data object Chores : HubRoute
    data object Goals : HubRoute
    data object Rewards : HubRoute
    data object Lists : HubRoute
    data object Photos : HubRoute
    data object Settings : HubRoute
    data object Pantry : HubRoute
    data object Rhythms : HubRoute
    data object WeeklyPlanning : HubRoute
    data object Approvals : HubRoute
    data object ReviewEvents : HubRoute

    data class ListDetail(val listId: String) : HubRoute
    data class Goal(val goalId: String) : HubRoute
    data class Person(val personId: String) : HubRoute
    data class WaffledBites(val personId: String, val personName: String) : HubRoute
    data class Recipe(val recipeId: String, val cook: Boolean = false) : HubRoute
    data class Meal(val mealId: String) : HubRoute
    data class RewardShop(val personId: String) : HubRoute

    data object SettingsAccount : HubRoute
    data object SettingsFamily : HubRoute
    data object SettingsModules : HubRoute
    data object SettingsChoresRewards : HubRoute
    data object SettingsCalendars : HubRoute
    data object SettingsAI : HubRoute
    data object SettingsMeals : HubRoute
    data object SettingsPantry : HubRoute
    data object SettingsFamilyNight : HubRoute
    data object SettingsWeeklyPlanning : HubRoute
    data object SettingsDisplay : HubRoute
    data object SettingsNotifications : HubRoute
    data object SettingsAppearance : HubRoute
    data object SettingsPermissions : HubRoute
    data object SettingsAbout : HubRoute

    companion object {
        /**
         * The deep-link names (`WAFFLED_OPEN_HUB` on iOS). An unknown name is null, never a
         * default: a typo must leave you where you were.
         */
        fun forName(name: String): HubRoute? = when (name) {
            "planning" -> WeeklyPlanning
            "chores" -> Chores
            "goals" -> Goals
            "rewards" -> Rewards
            "lists" -> Lists
            "pantry" -> Pantry
            "photos" -> Photos
            "settings" -> Settings
            // A Settings sub-route, not a top-level page.
            "display" -> SettingsDisplay
            // The Weekly Planning CONFIG panel; "planning" is the session itself.
            "settingsPlanning" -> SettingsWeeklyPlanning
            else -> null
        }
    }
}
