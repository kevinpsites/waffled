package app.waffled.android.shell

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The phone keeps one push stack per tab (iOS lifts five `NavigationStack` paths to the
 * root). Switching tabs keeps each stack; re-tapping the current tab pops it to root;
 * system Back pops the current tab's stack and, at root, is not consumed.
 */
class NavStateTest {

    private val start = NavState<String>(tab = "today")

    @Test
    fun pushesOntoTheCurrentTabOnly() {
        val s = start.push("goals").push("goal:1")
        assertEquals("goal:1", s.top)
        assertEquals(listOf("goals", "goal:1"), s.stackOf("today"))
        assertEquals(emptyList(), s.stackOf("calendar"))
    }

    @Test
    fun switchingTabsKeepsEachStack() {
        val s = start.push("goals").select("flex").push("recipe:1").select("today")
        assertEquals("today", s.tab)
        assertEquals("goals", s.top)
        assertEquals(listOf("recipe:1"), s.stackOf("flex"))
    }

    @Test
    fun reselectingTheCurrentTabPopsToRoot() {
        val s = start.push("goals").push("goal:1").select("today")
        assertEquals("today", s.tab)
        assertNull(s.top)
    }

    @Test
    fun backPopsOneAndIsNotConsumedAtRoot() {
        val s = start.push("goals").push("goal:1")
        assertEquals("goals", s.pop()!!.top)
        assertNull(start.pop())
    }

    @Test
    fun replaceTopSwapsWithoutGrowingTheStack() {
        val s = start.push("recipe:1").replaceTop("cook:1")
        assertEquals(listOf("cook:1"), s.stackOf("today"))
    }

    @Test
    fun selectAndPushLandsOnAnotherTabAlreadyPushed() {
        val s = start.open(tab = "family", route = "pantry")
        assertEquals("family", s.tab)
        assertEquals(listOf("pantry"), s.stackOf("family"))
    }
}
