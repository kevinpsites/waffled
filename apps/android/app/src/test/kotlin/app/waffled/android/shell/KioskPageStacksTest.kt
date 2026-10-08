package app.waffled.android.shell

import app.waffled.feature.kiosk.KioskNav
import app.waffled.feature.kiosktoday.KioskTodayDestination
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The tablet keeps one drill-in stack per rail page, above the shell, so leaving a page
 * and coming back restores where you were. Re-tapping the open rail item (its reset key
 * goes UP) pops that page to root; a key that went back to 0 (a rotation restored the
 * shell's selection without its counters) must not.
 */
class KioskPageStacksTest {

    private val start = KioskPageStacks<String>()

    @Test
    fun eachPageHasItsOwnStack() {
        val s = start.push(KioskNav.Today, "recipe").push(KioskNav.Meals, "meal")
        assertEquals("recipe", s.top(KioskNav.Today))
        assertEquals("meal", s.top(KioskNav.Meals))
        assertNull(s.top(KioskNav.Calendar))
    }

    @Test
    fun popAndReplaceTouchOnlyThatPage() {
        val s = start.push(KioskNav.Today, "a").push(KioskNav.Today, "b").push(KioskNav.Meals, "m")
        assertEquals("a", s.pop(KioskNav.Today).top(KioskNav.Today))
        assertEquals("c", s.replaceTop(KioskNav.Today, "c").top(KioskNav.Today))
        assertEquals("m", s.pop(KioskNav.Today).top(KioskNav.Meals))
        assertEquals(start, start.pop(KioskNav.Today))
    }

    @Test
    fun aRisingResetKeyPopsToRoot() {
        val s = start.observeReset(KioskNav.Today, 0).push(KioskNav.Today, "a")
        assertEquals("a", s.observeReset(KioskNav.Today, 0).top(KioskNav.Today))
        assertNull(s.observeReset(KioskNav.Today, 1).top(KioskNav.Today))
    }

    @Test
    fun aResetKeyThatFellBackKeepsTheStack() {
        val s = start.observeReset(KioskNav.Today, 2).push(KioskNav.Today, "a")
        val restored = s.observeReset(KioskNav.Today, 0)
        assertEquals("a", restored.top(KioskNav.Today))
        // …and the next real re-tap (0 → 1) still pops.
        assertNull(restored.observeReset(KioskNav.Today, 1).top(KioskNav.Today))
    }

    @Test
    fun todayDrillInsLandOnTheirRailPage() {
        assertEquals(KioskNav.Calendar, kioskNavFor(KioskTodayDestination.Calendar))
        assertEquals(KioskNav.Meals, kioskNavFor(KioskTodayDestination.Meals))
        assertEquals(KioskNav.Tasks, kioskNavFor(KioskTodayDestination.Tasks))
        assertEquals(KioskNav.Lists, kioskNavFor(KioskTodayDestination.Lists))
        assertEquals(KioskNav.Goals, kioskNavFor(KioskTodayDestination.Goals))
        assertEquals(KioskNav.Pantry, kioskNavFor(KioskTodayDestination.Pantry))
        assertEquals(KioskNav.Rhythms, kioskNavFor(KioskTodayDestination.Rhythms))
    }
}
