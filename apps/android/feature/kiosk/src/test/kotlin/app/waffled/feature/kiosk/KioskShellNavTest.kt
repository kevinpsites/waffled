package app.waffled.feature.kiosk

import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate
import app.waffled.core.sync.SyncState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Rail taps, re-tap resets, module self-correction and the boot cover. */
class KioskShellNavTest {

    @Test fun startsOnToday() {
        assertEquals(KioskNav.Today, KioskShellNav().selection)
    }

    @Test fun tappingAnotherItemSelectsItWithoutResetting() {
        val nav = KioskShellNav().tap(KioskNav.Goals)
        assertEquals(KioskNav.Goals, nav.selection)
        assertEquals(0, nav.resetKey(KioskNav.Goals))
    }

    @Test fun reTappingTheOpenItemResetsItsPageOnly() {
        val nav = KioskShellNav().tap(KioskNav.Goals).tap(KioskNav.Goals)
        assertEquals(KioskNav.Goals, nav.selection)
        assertEquals(1, nav.resetKey(KioskNav.Goals))
        assertEquals(0, nav.resetKey(KioskNav.Meals))
    }

    @Test fun navigatingFromAPageNeverResets() {
        val nav = KioskShellNav().tap(KioskNav.More).navigate(KioskNav.Pantry).navigate(KioskNav.Pantry)
        assertEquals(KioskNav.Pantry, nav.selection)
        assertEquals(0, nav.resetKey(KioskNav.Pantry))
    }

    @Test fun aDisabledModuleSelfCorrectsToToday() {
        val goalsOff = ModuleGate(flags = mapOf(WaffledModule.Goals to false), loaded = true)
        val nav = KioskShellNav().tap(KioskNav.Goals).corrected(goalsOff, rewardsOn = true)
        assertEquals(KioskNav.Today, nav.selection)
        val kept = KioskShellNav().tap(KioskNav.Family).corrected(goalsOff, rewardsOn = true)
        assertEquals(KioskNav.Family, kept.selection)
    }

    @Test fun bootCoverShowsOnlyWhileTheFirstSyncHasNoMembers() {
        assertTrue(KioskBoot.isBooting(membersEmpty = true, SyncState.Idle))
        assertTrue(KioskBoot.isBooting(membersEmpty = true, SyncState.Connecting))
        assertFalse(KioskBoot.isBooting(membersEmpty = true, SyncState.Offline))
        assertFalse(KioskBoot.isBooting(membersEmpty = true, SyncState.Connected))
        assertFalse(KioskBoot.isBooting(membersEmpty = false, SyncState.Connecting))
    }

    @Test fun theStallEscapeArrivesAfterEightSeconds() {
        assertEquals(8_000L, KioskBoot.STALL_AFTER_MS)
    }

    @Test fun firstNameIsTheFirstWord() {
        assertEquals("Maya", KioskBoot.firstName("Maya Lopez"))
        assertEquals("Sam", KioskBoot.firstName("  Sam "))
        assertEquals("", KioskBoot.firstName(""))
    }
}
