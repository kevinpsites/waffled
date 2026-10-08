package app.waffled.android.today

import app.waffled.feature.goals.GoalsApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Port of iOS `KioskGoalPickTests` — the Today goal hero's pick order. */
class TodayGoalPickTest {

    private fun goal(
        id: String,
        spotlight: Boolean = false,
        featured: Boolean = false,
        participants: List<String> = emptyList(),
    ) = GoalsApi.Goal(
        id = id,
        title = id,
        isFeatured = featured,
        isSpotlight = spotlight,
        participants = participants.map { GoalsApi.Participant(personId = it, name = it) },
    )

    @Test
    fun pinnedGoalWinsWhenItStillExists() {
        val goals = listOf(goal("a", spotlight = true), goal("b"))
        assertEquals("b", TodayGoalPick.featured(goals, pinnedId = "b", memberIds = emptySet())?.id)
    }

    @Test
    fun stalePinFallsThroughToSpotlight() {
        val goals = listOf(goal("a"), goal("b", spotlight = true))
        assertEquals("b", TodayGoalPick.featured(goals, pinnedId = "gone", memberIds = emptySet())?.id)
    }

    @Test
    fun spotlightBeatsFeatured() {
        val goals = listOf(goal("pinned-tier", featured = true), goal("hero", spotlight = true))
        assertEquals("hero", TodayGoalPick.featured(goals, pinnedId = "", memberIds = emptySet())?.id)
    }

    @Test
    fun wholeFamilyGoalWhenNothingIsFeatured() {
        val goals = listOf(
            goal("solo", participants = listOf("a")),
            goal("family", participants = listOf("a", "b", "c")),
        )
        assertEquals("family", TodayGoalPick.featured(goals, pinnedId = "", memberIds = setOf("a", "b"))?.id)
    }

    @Test
    fun singleMemberHouseholdSkipsTheFamilyRule() {
        val goals = listOf(goal("first", participants = listOf("a")), goal("second", participants = listOf("a")))
        assertEquals("first", TodayGoalPick.featured(goals, pinnedId = "", memberIds = setOf("a"))?.id)
    }

    @Test
    fun noGoalsMeansNoCard() {
        assertNull(TodayGoalPick.featured(emptyList(), pinnedId = "x", memberIds = setOf("a")))
    }
}
