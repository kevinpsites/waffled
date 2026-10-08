package app.waffled.feature.kiosktoday

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** When the Today header drops the capture bar under the greeting instead of squeezing it. */
class KioskHeaderLayoutTest {
    @Test
    fun aPortraitTabletStacksTheCaptureBar() {
        assertTrue(KioskTodayRules.headerStacks(width = 600f))
        assertTrue(KioskTodayRules.headerStacks(width = 719f))
    }

    @Test
    fun aLandscapeTabletKeepsOneRow() {
        assertFalse(KioskTodayRules.headerStacks(width = 720f))
        assertFalse(KioskTodayRules.headerStacks(width = 1280f))
    }

    @Test
    fun theThresholdLeavesRoomForGreetingMenuAndBar() {
        assertEquals(720f, KioskTodayRules.HEADER_ONE_ROW_MIN_WIDTH)
    }
}
