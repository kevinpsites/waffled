package app.waffled.feature.family

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// Port of FamilyHubRouteTests.swift — the hub's deep-link name table. A green build
// proves a destination exists; it cannot prove anything navigates there.
class FamilyHubRouteTest {

    @Test fun planningIsReachableByName() {
        assertEquals(HubRoute.WeeklyPlanning, HubRoute.forName("planning"))
    }

    @Test fun theEstablishedNamesStillResolve() {
        assertEquals(HubRoute.Chores, HubRoute.forName("chores"))
        assertEquals(HubRoute.Goals, HubRoute.forName("goals"))
        assertEquals(HubRoute.Settings, HubRoute.forName("settings"))
        // "display" deliberately maps to a SETTINGS sub-route, not a top-level page.
        assertEquals(HubRoute.SettingsDisplay, HubRoute.forName("display"))
    }

    @Test fun anUnknownNameIsNilRatherThanADefault() {
        // A typo must leave you where you were — a wrong screen reads as a bug in the screen.
        assertNull(HubRoute.forName("planing"))
        assertNull(HubRoute.forName(""))
    }

    @Test fun theSettingsPanelHasItsOwnName() {
        assertEquals(HubRoute.SettingsWeeklyPlanning, HubRoute.forName("settingsPlanning"))
        assertEquals(HubRoute.WeeklyPlanning, HubRoute.forName("planning"))
    }

    @Test fun theRemainingTileNamesResolve() {
        assertEquals(HubRoute.Rewards, HubRoute.forName("rewards"))
        assertEquals(HubRoute.Lists, HubRoute.forName("lists"))
        assertEquals(HubRoute.Pantry, HubRoute.forName("pantry"))
        assertEquals(HubRoute.Photos, HubRoute.forName("photos"))
    }
}
