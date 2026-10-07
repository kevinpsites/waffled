package app.waffled.feature.kiosktoday

import app.waffled.feature.goals.GoalsApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The Kotlin port of `apps/ios/Tests/KioskGoalPickTests.swift`: the Family Goal card's
 * pick order — pinned (if it still exists) → Spotlight → Pinned tier (isFeatured) → a
 * whole-family goal (multi-member households only) → the first goal.
 */
private fun goal(
    id: String,
    spotlight: Boolean = false,
    featured: Boolean = false,
    participants: List<String> = emptyList(),
) = GoalsApi.Goal(
    id = id, title = id, isFeatured = featured, isSpotlight = spotlight,
    target = 10.0, totalProgress = 2.0,
    participants = participants.map { GoalsApi.Participant(personId = it, name = it) },
)

class KioskGoalPickTest {

    @Test
    fun pinnedGoalWinsWhenItStillExists() {
        val goals = listOf(goal("a", spotlight = true), goal("b"))
        assertEquals("b", KioskGoalPick.featured(goals, pinnedId = "b", memberIds = emptySet())?.id)
    }

    @Test
    fun stalePinFallsThroughToSpotlight() {
        val goals = listOf(goal("a"), goal("b", spotlight = true))
        assertEquals("b", KioskGoalPick.featured(goals, pinnedId = "gone", memberIds = emptySet())?.id)
    }

    @Test
    fun spotlightBeatsFeatured() {
        val goals = listOf(goal("pinned-tier", featured = true), goal("hero", spotlight = true))
        assertEquals("hero", KioskGoalPick.featured(goals, pinnedId = "", memberIds = emptySet())?.id)
    }

    @Test
    fun wholeFamilyGoalWhenNothingIsFeatured() {
        val goals = listOf(
            goal("solo", participants = listOf("a")),
            goal("family", participants = listOf("a", "b", "c")),
        )
        assertEquals("family", KioskGoalPick.featured(goals, pinnedId = "", memberIds = setOf("a", "b"))?.id)
    }

    /** With one member every goal is "whole family" — fall to the first goal instead. */
    @Test
    fun singleMemberHouseholdSkipsTheFamilyRule() {
        val goals = listOf(goal("first", participants = listOf("a")), goal("second", participants = listOf("a")))
        assertEquals("first", KioskGoalPick.featured(goals, pinnedId = "", memberIds = setOf("a"))?.id)
    }

    @Test
    fun noGoalsMeansNoCard() {
        assertNull(KioskGoalPick.featured(emptyList(), pinnedId = "x", memberIds = setOf("a")))
    }
}
