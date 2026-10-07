package app.waffled.feature.kiosk

import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The per-device rail pins: parse, cap, module gating and the More overflow. */
class KioskRailTest {

    private val allOn = ModuleGate(
        flags = WaffledModule.entries.associateWith { true },
        loaded = true,
    )

    @Test fun defaultRawPinsMealsAndFamily() {
        assertEquals("meals,family", KioskRail.defaultRaw)
        assertEquals(listOf(KioskNav.Meals, KioskNav.Family), KioskRail.parse(KioskRail.defaultRaw))
    }

    @Test fun parseDropsUnknownFixedAndDuplicateTokens() {
        val parsed = KioskRail.parse(" goals ,today,bogus,goals,more,settings,calendar,lists")
        assertEquals(listOf(KioskNav.Goals, KioskNav.Lists), parsed)
    }

    @Test fun parseCapsAtFive() {
        val parsed = KioskRail.parse("meals,tasks,rewards,goals,lists,pantry,rhythms")
        assertEquals(5, parsed.size)
        assertEquals(KioskNav.Lists, parsed.last())
    }

    @Test fun parseOfNothingIsEmpty() {
        assertEquals(emptyList(), KioskRail.parse(""))
        assertEquals(emptyList(), KioskRail.parse(null))
    }

    @Test fun serializeRoundTrips() {
        val items = listOf(KioskNav.Photos, KioskNav.Planning, KioskNav.Tasks)
        assertEquals("photos,planning,tasks", KioskRail.serialize(items))
        assertEquals(items, KioskRail.parse(KioskRail.serialize(items)))
    }

    @Test fun coreDestinationsAreNeverGated() {
        val allOff = ModuleGate(flags = WaffledModule.entries.associateWith { false }, loaded = true)
        for (nav in listOf(KioskNav.Today, KioskNav.Calendar, KioskNav.Family, KioskNav.Photos, KioskNav.More, KioskNav.Settings)) {
            assertTrue(KioskRail.moduleEnabled(nav, allOff, rewardsOn = false), "$nav is core")
        }
    }

    @Test fun optionalDestinationsFollowTheirModule() {
        val off = ModuleGate(flags = mapOf(WaffledModule.Goals to false, WaffledModule.WeeklyPlanning to false), loaded = true)
        assertFalse(KioskRail.moduleEnabled(KioskNav.Goals, off, rewardsOn = true))
        assertFalse(KioskRail.moduleEnabled(KioskNav.Planning, off, rewardsOn = true))
        assertTrue(KioskRail.moduleEnabled(KioskNav.Meals, off, rewardsOn = true))
        // Pantry is default-off.
        assertFalse(KioskRail.moduleEnabled(KioskNav.Pantry, ModuleGate(), rewardsOn = true))
        assertTrue(KioskRail.moduleEnabled(KioskNav.Tasks, ModuleGate(), rewardsOn = false))
    }

    @Test fun rewardsFollowsTheRewardsSubFlagNotChoresAlone() {
        assertFalse(KioskRail.moduleEnabled(KioskNav.Rewards, allOn, rewardsOn = false))
        assertTrue(KioskRail.moduleEnabled(KioskNav.Rewards, allOn, rewardsOn = true))
    }

    @Test fun disablingAPinnedModuleDropsItFromTheRailWithoutTouchingStorage() {
        val raw = "goals,meals"
        val goalsOff = ModuleGate(flags = mapOf(WaffledModule.Goals to false), loaded = true)
        assertEquals(listOf(KioskNav.Meals), KioskRail.pinned(raw, goalsOff, rewardsOn = true))
        assertEquals(listOf(KioskNav.Goals, KioskNav.Meals), KioskRail.parse(raw))
    }

    @Test fun overflowIsEveryEnabledChoosableNotPinned() {
        val overflow = KioskRail.overflow("meals,family", allOn, rewardsOn = true)
        assertEquals(
            listOf(KioskNav.Tasks, KioskNav.Rewards, KioskNav.Goals, KioskNav.Lists, KioskNav.Pantry, KioskNav.Rhythms, KioskNav.Planning, KioskNav.Photos),
            overflow,
        )
        val noRewards = KioskRail.overflow("meals,family", allOn, rewardsOn = false)
        assertFalse(KioskNav.Rewards in noRewards)
    }

    @Test fun bottomBarRunsTodayCalendarPinsMoreSettings() {
        assertEquals(
            listOf(KioskNav.Today, KioskNav.Calendar, KioskNav.Goals, KioskNav.More, KioskNav.Settings),
            KioskRail.bottomBarItems(listOf(KioskNav.Goals)),
        )
    }

    @Test fun captureButtonSplitsTheBottomBarAtTheCentre() {
        // 6 entries (Today, Calendar, Meals, Family, More, Settings) → 3 | ✨ | 3.
        assertEquals(3, KioskRail.captureSplit(6))
        // With the user chip appended, 7 → 4 | ✨ | 3.
        assertEquals(4, KioskRail.captureSplit(7))
        assertEquals(0, KioskRail.captureSplit(0))
    }

    @Test fun pinningRespectsTheCapAndIgnoresDuplicates() {
        assertEquals("meals,family,goals", KioskRail.pin("meals,family", KioskNav.Goals, allOn, rewardsOn = true))
        assertEquals("meals,family", KioskRail.pin("meals,family", KioskNav.Meals, allOn, rewardsOn = true))
        val full = "meals,tasks,goals,lists,photos"
        assertEquals(full, KioskRail.pin(full, KioskNav.Family, allOn, rewardsOn = true))
    }

    @Test fun movingAndRemovingRewriteTheStoredOrder() {
        assertEquals("family,meals,goals", KioskRail.move("meals,family,goals", from = 1, to = 0, allOn, rewardsOn = true))
        assertEquals("meals,goals", KioskRail.remove("meals,family,goals", KioskNav.Family, allOn, rewardsOn = true))
    }

    @Test fun navRawValuesMatchIos() {
        assertEquals(KioskNav.Tasks, KioskNav.fromRaw("tasks"))
        assertEquals("Chores", KioskNav.Tasks.label)
        assertEquals(null, KioskNav.fromRaw("familyNight"))
    }
}
