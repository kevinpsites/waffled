package app.waffled.feature.goals

import app.waffled.core.model.Person
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The copy rules the screens rely on, lifted out of the composables so they can be
 * asserted — `assembleDebug` proves a screen COMPILES, not that it says the right thing,
 * and there is no JVM smoke test for a Composable in this project.
 */
class GoalsUiLogicTest {

    private fun participant(id: String, name: String) =
        GoalsApi.Participant(personId = id, name = name)

    // ---- the Today hero's scope label -------------------------------------------

    @Test
    fun aGoalEveryoneIsInReadsAsAFamilyGoal() {
        val goal = GoalsApi.Goal(
            id = "g",
            participants = listOf(participant("p1", "Kevin"), participant("p2", "Kelly")),
        )
        assertEquals("Family Goal", scopeLabel(goal, setOf("p1", "p2"), "p1"))
    }

    @Test
    fun aSoloGoalIsMineOrTheirs() {
        val mine = GoalsApi.Goal(id = "g", participants = listOf(participant("p1", "Kevin Sites")))
        assertEquals("My Goal", scopeLabel(mine, setOf("p1", "p2"), "p1"))
        assertEquals("Kevin Sites's Goal", scopeLabel(mine, setOf("p1", "p2"), "p2"))
    }

    @Test
    fun aSubsetOfTheHouseholdIsAGroupGoal() {
        val goal = GoalsApi.Goal(
            id = "g",
            participants = listOf(participant("p1", "Kevin"), participant("p2", "Kelly")),
        )
        assertEquals("Group Goal", scopeLabel(goal, setOf("p1", "p2", "p3"), "p1"))
    }

    @Test
    fun aGoalWithNoParticipantsIsJustAGoal() {
        assertEquals("Goal", scopeLabel(GoalsApi.Goal(id = "g"), setOf("p1"), "p1"))
    }

    @Test
    fun aOnePersonHouseholdDoesNotClaimFamily() {
        // "Family" needs more than one person to mean anything.
        val goal = GoalsApi.Goal(id = "g", participants = listOf(participant("p1", "Kevin")))
        assertEquals("My Goal", scopeLabel(goal, setOf("p1"), "p1"))
    }

    // ---- the list header --------------------------------------------------------

    @Test
    fun aListSublineNamesTheMembersItCanAndCountsTheRest() {
        fun list(vararg names: String) = GoalsApi.GoalList(
            id = "l",
            members = names.mapIndexed { i, n -> GoalsApi.GoalList.Member("p$i", n) },
        )

        assertEquals("Personal", listSubtitle(list("Kevin Sites")))
        assertEquals("Kevin & Kelly", listSubtitle(list("Kevin Sites", "Kelly Sites")))
        assertEquals("Everyone · 4 people", listSubtitle(list("A", "B", "C", "D")))
        assertEquals("No members yet", listSubtitle(list()))
    }

    // ---- the detail hero's subtitle ---------------------------------------------

    @Test
    fun theHeroSubtitleChainsWhatItActuallyKnows() {
        val detail = GoalsApi.GoalDetail(
            id = "g1",
            createdAt = "2026-01-05T00:00:00Z",
            target = 1000.0,
            totalProgress = 221.0,
            streakDays = 4,
            deadline = "2026-12-31",
        )
        val subtitle = heroSubtitle(detail, GoalsApi.Goal(id = "g1"))

        assertTrue(subtitle.contains("Started Jan 5"), subtitle)
        assertTrue(subtitle.contains("22% complete"), subtitle)
        assertTrue(subtitle.contains("🔥 4-day streak"), subtitle)
        assertTrue(subtitle.contains("by Dec 31"), subtitle)
    }

    @Test
    fun theHeroSubtitleSkipsWhatItDoesNot() {
        val subtitle = heroSubtitle(
            GoalsApi.GoalDetail(id = "g1", createdAt = "", target = null, streakDays = 0),
            GoalsApi.Goal(id = "g1"),
        )
        assertEquals("", subtitle, "an open goal with no history has nothing to say")
    }

    @Test
    fun aPercentNeverExceedsOneHundred() {
        val detail = GoalsApi.GoalDetail(id = "g1", createdAt = "", target = 10.0, totalProgress = 50.0)
        assertTrue(heroSubtitle(detail, GoalsApi.Goal(id = "g1")).contains("100% complete"))
    }

    @Test
    fun aHealthLinkedGoalSaysSoWithoutNamingTheMetric() {
        // The metric catalog is a HealthKit concern; Android only needs to explain WHY
        // progress appears that nobody logged here.
        val detail = GoalsApi.GoalDetail(id = "g1", createdAt = "", healthMetric = "steps")
        assertTrue(heroSubtitle(detail, GoalsApi.Goal(id = "g1")).contains("⌚ Auto-filled from Health"))
    }

    @Test
    fun healthAutoFillIsOffForThisPort() {
        // The affordance is gated exactly as iOS gates on isHealthDataAvailable().
        assertFalse(HealthAutoFill.isAvailable)
        assertEquals(null, HealthAutoFill.linkedBadge(null))
        assertEquals(null, HealthAutoFill.linkedBadge("  "))
    }

    // ---- the review queue's copy -------------------------------------------------

    @Test
    fun theCreditLineNamesWhoItCanAndCountsTheRest() {
        fun person(name: String) = Person(id = name, name = name)

        assertEquals("anyone", peopleNames(emptyList()))
        assertEquals("Kevin", peopleNames(listOf(person("Kevin Sites"))))
        assertEquals("Kevin & Kelly", peopleNames(listOf(person("Kevin Sites"), person("Kelly Sites"))))
        assertEquals("3 people", peopleNames(List(3) { person("P$it") }))
    }

    @Test
    fun aMultiPersonConfirmSaysHowItWillCount() {
        val shared = GoalsApi.GoalRecapItem(eventId = "e", trackingMode = "shared_total")
        val each = GoalsApi.GoalRecapItem(eventId = "e", trackingMode = "each_tracks")

        assertEquals("", creditSuffix(shared, 1), "one person needs no explanation")
        assertEquals(" · split", creditSuffix(shared, 2))
        assertEquals(" · each", creditSuffix(each, 2))
    }

    @Test
    fun anEventTimeIsFormattedInTheHouseholdZone() {
        val chicago = ZoneId.of("America/Chicago")
        // 2026-07-17T22:00Z is 5pm on the 17th in Chicago — bucketing in UTC would be
        // right here but wrong for anything after 7pm local.
        assertEquals("Fri, Jul 17 · 5:00 PM", eventWhen("2026-07-17T22:00:00Z", allDay = false, chicago))
        assertEquals("Fri, Jul 17", eventWhen("2026-07-17T22:00:00Z", allDay = true, chicago))
    }

    @Test
    fun anEventTimeAfterMidnightUtcStaysOnTheLocalDay() {
        val chicago = ZoneId.of("America/Chicago")
        // 01:30Z on the 18th is still 8:30pm on the 17th in Chicago.
        assertTrue(eventWhen("2026-07-18T01:30:00Z", allDay = false, chicago).startsWith("Fri, Jul 17"))
    }

    @Test
    fun anUnparseableTimestampDegradesToItsDay() {
        assertEquals("not-a-date", eventWhen("not-a-date", allDay = false, ZoneId.of("UTC")))
    }

    // ---- the log sheet's note chips ---------------------------------------------

    @Test
    fun thisGoalsOwnNotesComeFirstAndTheDefaultsTopUp() {
        val chips = noteChips(listOf("Creek hike", "Fort building"))
        assertEquals(listOf("Creek hike", "Fort building"), chips.take(2))
        assertEquals(6, chips.size)
    }

    @Test
    fun aLearnedNoteThatMatchesADefaultIsNotShownTwice() {
        val chips = noteChips(listOf("park", "Reading"))
        assertEquals(chips.distinctBy { it.lowercase() }, chips)
        assertEquals(6, chips.size)
        assertEquals("park", chips.first(), "the goal's own casing wins")
    }

    @Test
    fun blankSuggestionsAreDropped() {
        val chips = noteChips(listOf("   ", "Creek hike"))
        assertEquals("Creek hike", chips.first())
    }

    @Test
    fun aColdStartGoalStillGetsChips() {
        assertEquals(6, noteChips(emptyList()).size)
    }

    // ---- the counting worked example --------------------------------------------

    @Test
    fun theCountingExampleSingularisesTheGoalsOwnUnit() {
        val total = GoalDraft.new(null).copy(goalType = "total", unit = "hours")
        assertEquals("2 people, 1 hour each → +2 hours", countExample(total, "full", people = 2))
        assertEquals("1 hour together, 2 people → +1 hour, ½ each", countExample(total, "split", people = 2))
    }

    @Test
    fun theCountingExampleFallsBackWhenNoUnitIsTypedYet() {
        val total = GoalDraft.new(null).copy(goalType = "total", unit = "  ")
        assertTrue(countExample(total, "full", people = 2).contains("hr"))

        val count = GoalDraft.new(null).copy(goalType = "count", unit = "")
        assertTrue(countExample(count, "each", people = 3).contains("+3"))
    }

    @Test
    fun theCountingExampleNeverClaimsFewerThanTwoPeople() {
        val count = GoalDraft.new(null).copy(goalType = "count", unit = "visits")
        assertEquals("2 at once → +2 (one each)", countExample(count, "each", people = 0))
    }
}
