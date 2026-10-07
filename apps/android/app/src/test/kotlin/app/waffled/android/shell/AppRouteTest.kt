package app.waffled.android.shell

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The debug deep-link keys (the twin of iOS `DemoHooks.hubRoute`). */
class AppRouteTest {

    @Test
    fun knownKeysMapToTheirRoute() {
        assertEquals(AppRoute.Goals, AppRoute.fromDebugKey("goals"))
        assertEquals(AppRoute.Pantry, AppRoute.fromDebugKey("pantry"))
        assertEquals(AppRoute.RecipesLibrary(), AppRoute.fromDebugKey("recipes"))
        assertEquals(AppRoute.GROCERY, AppRoute.fromDebugKey("grocery"))
    }

    @Test
    fun groceryIsTheBoardNotAUserList() {
        // iOS `grocerySummary`: ListDetailModel loads the board for listType grocery.
        assertEquals("grocery", AppRoute.GROCERY.list.listType)
    }

    @Test
    fun unknownOrAbsentKeyIsNoDeepLink() {
        assertNull(AppRoute.fromDebugKey(null))
        assertNull(AppRoute.fromDebugKey("settings"))
    }
}
