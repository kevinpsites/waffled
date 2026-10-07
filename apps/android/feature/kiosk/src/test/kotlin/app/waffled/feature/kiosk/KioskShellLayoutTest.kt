package app.waffled.feature.kiosk

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Port of `KioskShellLayoutTests.swift`. The layout is judged from the FULL container
 * (insets added back) so the keyboard — which arrives as a large bottom inset — can't
 * flip a portrait tablet into the landscape layout mid-typing.
 */
class KioskShellLayoutTest {

    @Test fun portraitWithoutKeyboard() {
        assertTrue(KioskShellLayout.isPortrait(820f, 1136f, KioskInsets(top = 24f, bottom = 20f)))
    }

    @Test fun portraitKeepsLayoutWhileKeyboardIsUp() {
        val width = 820f
        val height = 696f
        assertTrue(height < width) // the regression trigger
        assertTrue(KioskShellLayout.isPortrait(width, height, KioskInsets(top = 24f, bottom = 460f)))
    }

    @Test fun landscapeWithoutKeyboard() {
        assertFalse(KioskShellLayout.isPortrait(1180f, 776f, KioskInsets(top = 24f, bottom = 20f)))
    }

    @Test fun landscapeKeepsLayoutWhileKeyboardIsUp() {
        assertFalse(KioskShellLayout.isPortrait(1180f, 396f, KioskInsets(top = 24f, bottom = 400f)))
    }

    @Test fun sideInsetsCountTowardWidth() {
        assertFalse(KioskShellLayout.isPortrait(800f, 820f, KioskInsets(left = 40f, right = 40f)))
    }

    @Test fun tabletThresholdIsTheSmallestWidth() {
        assertTrue(KioskShellLayout.isTablet(smallestScreenWidthDp = 600))
        assertTrue(KioskShellLayout.isTablet(smallestScreenWidthDp = 800))
        assertFalse(KioskShellLayout.isTablet(smallestScreenWidthDp = 411))
    }
}
