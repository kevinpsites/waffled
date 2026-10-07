package app.waffled.android.shell

import app.waffled.feature.family.HubRoute
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The debug deep-link keys (the twin of iOS `DemoHooks.hubRoute`) and the hub's routes. */
class AppRouteTest {

    @Test
    fun knownKeysMapToTheirRoute() {
        assertEquals(AppRoute.Goals, AppRoute.fromDebugKey("goals"))
        assertEquals(AppRoute.Pantry, AppRoute.fromDebugKey("pantry"))
        assertEquals(AppRoute.RecipesLibrary(), AppRoute.fromDebugKey("recipes"))
        assertEquals(AppRoute.GROCERY, AppRoute.fromDebugKey("grocery"))
        assertEquals(AppRoute.Settings, AppRoute.fromDebugKey("settings"))
        assertEquals(AppRoute.Approvals, AppRoute.fromDebugKey("approvals"))
        assertEquals(AppRoute.Rhythms, AppRoute.fromDebugKey("rhythms"))
    }

    @Test
    fun idCarryingKeysTakeTheIdAfterTheColon() {
        assertEquals(AppRoute.Person("p1"), AppRoute.fromDebugKey("person:p1"))
        assertEquals(AppRoute.RewardShop("p1"), AppRoute.fromDebugKey("shop:p1"))
        assertEquals(AppRoute.WaffledBites("p1", "Jerry"), AppRoute.fromDebugKey("bites:p1:Jerry"))
        assertNull(AppRoute.fromDebugKey("person:"))
    }

    @Test
    fun groceryIsTheBoardNotAUserList() {
        // iOS `grocerySummary`: ListDetailModel loads the board for listType grocery.
        assertEquals("grocery", AppRoute.GROCERY.list.listType)
    }

    @Test
    fun unknownOrAbsentKeyIsNoDeepLink() {
        assertNull(AppRoute.fromDebugKey(null))
        assertNull(AppRoute.fromDebugKey("nope"))
    }

    @Test
    fun hubTilesMapToTheirScreens() {
        assertEquals(AppRoute.Chores, AppRoute.fromHub(HubRoute.Chores))
        assertEquals(AppRoute.Goals, AppRoute.fromHub(HubRoute.Goals))
        assertEquals(AppRoute.Rewards, AppRoute.fromHub(HubRoute.Rewards))
        assertEquals(AppRoute.Lists, AppRoute.fromHub(HubRoute.Lists))
        assertEquals(AppRoute.Photos, AppRoute.fromHub(HubRoute.Photos))
        assertEquals(AppRoute.Pantry, AppRoute.fromHub(HubRoute.Pantry))
        assertEquals(AppRoute.Rhythms, AppRoute.fromHub(HubRoute.Rhythms))
        assertEquals(AppRoute.Settings, AppRoute.fromHub(HubRoute.Settings))
        assertEquals(AppRoute.Approvals, AppRoute.fromHub(HubRoute.Approvals))
        assertEquals(AppRoute.ReviewEvents, AppRoute.fromHub(HubRoute.ReviewEvents))
    }

    @Test
    fun personScopedHubRoutesKeepTheirIds() {
        assertEquals(AppRoute.Person("p1"), AppRoute.fromHub(HubRoute.Person("p1")))
        assertEquals(AppRoute.RewardShop("p1"), AppRoute.fromHub(HubRoute.RewardShop("p1")))
        assertEquals(AppRoute.WaffledBites("p1", "Kid"), AppRoute.fromHub(HubRoute.WaffledBites("p1", "Kid")))
    }

    @Test
    fun idOnlyHubRoutesOpenAPlaceholderTheDetailReloads() {
        val goal = AppRoute.fromHub(HubRoute.Goal("g1")) as AppRoute.Goal
        assertEquals("g1", goal.goal.id)
        val list = AppRoute.fromHub(HubRoute.ListDetail("l1")) as AppRoute.ListDetail
        assertEquals("l1", list.list.id)
        val recipe = AppRoute.fromHub(HubRoute.Recipe("r1", cook = true)) as AppRoute.Recipe
        assertEquals("r1", recipe.summary.id)
        assertEquals(true, recipe.autoCook)
        val meal = AppRoute.fromHub(HubRoute.Meal("m1")) as AppRoute.Meal
        assertEquals("m1", meal.meal.id)
    }

    @Test
    fun settingsSubRoutesLandOnTheSettingsHub() {
        // SettingsScreen takes no initial panel, so a sub-route can only open the landing.
        assertEquals(AppRoute.Settings, AppRoute.fromHub(HubRoute.SettingsDisplay))
        assertEquals(AppRoute.Settings, AppRoute.fromHub(HubRoute.SettingsAbout))
    }

    @Test
    fun weeklyPlanningHasNoAndroidScreenYet() {
        assertNull(AppRoute.fromHub(HubRoute.WeeklyPlanning))
    }
}
