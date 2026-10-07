package app.waffled.feature.kiosk

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Port of `KioskRailHighlightTests.swift`. A page opened from the More grid has no tile of
 * its own, so the More tile must light up for it rather than the rail showing nothing.
 */
class KioskRailHighlightTest {

    private val defaultPins = listOf(KioskNav.Meals, KioskNav.Family)

    @Test fun everyPageInMoreHasItsOwnIcon() {
        for (nav in KioskRail.choosable) {
            val d = KioskMore.descriptor(nav)
            assertNotEquals("•", d.emoji, "$nav has no More tile icon")
            assertNotEquals(KioskMore.FALLBACK_EMOJI, d.emoji, "$nav fell through to the default tile")
            assertTrue(d.subtitle.isNotEmpty(), "$nav has no More tile subtitle")
        }
    }

    @Test fun ownTileHighlightsForDirectSelection() {
        assertTrue(KioskRail.isHighlighted(KioskNav.Calendar, KioskNav.Calendar, defaultPins))
        assertTrue(KioskRail.isHighlighted(KioskNav.Meals, KioskNav.Meals, defaultPins))
        assertFalse(KioskRail.isHighlighted(KioskNav.More, KioskNav.Meals, defaultPins))
        assertFalse(KioskRail.isHighlighted(KioskNav.Today, KioskNav.Calendar, defaultPins))
    }

    @Test fun moreLightsUpForOverflowPages() {
        val overflow = listOf(KioskNav.Goals, KioskNav.Lists, KioskNav.Tasks, KioskNav.Pantry, KioskNav.Photos, KioskNav.Rewards)
        for (page in overflow) {
            assertTrue(KioskRail.isHighlighted(KioskNav.More, page, defaultPins), "More should light for $page when it isn't pinned")
            assertFalse(KioskRail.isHighlighted(KioskNav.Today, page, defaultPins))
        }
    }

    @Test fun pinnedPageLightsItsOwnTileNotMore() {
        val pins = listOf(KioskNav.Goals, KioskNav.Meals)
        assertTrue(KioskRail.isHighlighted(KioskNav.Goals, KioskNav.Goals, pins))
        assertFalse(KioskRail.isHighlighted(KioskNav.More, KioskNav.Goals, pins))
    }

    @Test fun moreGridItselfHighlightsMore() {
        assertTrue(KioskRail.isHighlighted(KioskNav.More, KioskNav.More, defaultPins))
    }

    @Test fun fixedTilesNeverFallThroughToMore() {
        assertTrue(KioskRail.isHighlighted(KioskNav.Settings, KioskNav.Settings, defaultPins))
        assertFalse(KioskRail.isHighlighted(KioskNav.More, KioskNav.Settings, defaultPins))
        assertFalse(KioskRail.isHighlighted(KioskNav.More, KioskNav.Today, defaultPins))
        assertFalse(KioskRail.isHighlighted(KioskNav.More, KioskNav.Calendar, defaultPins))
    }
}
