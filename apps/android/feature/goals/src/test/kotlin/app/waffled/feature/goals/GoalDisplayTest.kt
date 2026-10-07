package app.waffled.feature.goals

import app.waffled.core.network.WaffledJson
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/GoalDisplayTests.swift` (itself mirroring the web
 * `goals-display.test.ts`), so a goal reads the same number on every platform.
 *
 * A habit displays THIS period's count and never its lifetime total; a checklist displays
 * steps; everything else displays the cumulative total against its target.
 */
class GoalDisplayTest {

    private fun goal(
        goalType: String = "total",
        target: Double? = null,
        totalProgress: Double = 0.0,
        habitPeriod: String? = null,
        habitTargetPerPeriod: Int? = null,
        periodDone: Double? = null,
        stepTotal: Int? = null,
        stepDone: Int? = null,
        streakDays: Int = 0,
        targetBasis: String? = null,
        people: Int = 0,
        loggedTodayBy: List<String>? = null,
        unit: String? = null,
    ) = GoalsApi.Goal(
        id = "g",
        title = "G",
        goalType = goalType,
        unit = unit,
        habitPeriod = habitPeriod,
        habitTargetPerPeriod = habitTargetPerPeriod,
        targetBasis = targetBasis,
        target = target,
        totalProgress = totalProgress,
        streakDays = streakDays,
        participants = (0 until people).map { GoalsApi.Participant("p$it", "P$it", target = target) },
        periodDone = periodDone,
        stepTotal = stepTotal,
        stepDone = stepDone,
        loggedTodayBy = loggedTodayBy,
    )

    private fun near(expected: Double, actual: Double) =
        assertTrue(abs(expected - actual) < 0.0001, "expected $expected, got $actual")

    // ---- a week's target, set in Weekly Planning ---------------------------------

    @Test
    fun aTargetForThisWeekReadsAgainstWhatIsLogged() {
        val g = goal(unit = "hours").copy(weekPlan = GoalsApi.Goal.WeekTarget("2026-09-13", 10.0, 3.5, current = true))
        assertEquals("This week: 3.5 of 10 hours", GoalDisplay.weekTargetLabel(g))
    }

    @Test
    fun aTargetForAWeekAheadNamesThatWeek() {
        val g = goal(unit = "hours").copy(weekPlan = GoalsApi.Goal.WeekTarget("2026-09-21", 10.0, 0.0, current = false))
        assertEquals("Week of Sep 21: 10 hours", GoalDisplay.weekTargetLabel(g))
    }

    @Test
    fun aWeekPlanReadsTheSameOnTheGoalsOwnPage() {
        val current = GoalsApi.Goal.WeekTarget("2026-09-13", 10.0, 3.0, current = true)
        val ahead = GoalsApi.Goal.WeekTarget("2026-09-20", 12.0, 0.0, current = false)
        assertEquals("3 of 10 hours", GoalDisplay.weekPlanAmount(current, unit = "hours"))
        assertEquals("Week of Sep 20: 12 hours", GoalDisplay.weekPlanLabel(ahead, unit = "hours"))
    }

    @Test
    fun aGoalWithoutAWeekTargetHasNoLabel() {
        assertNull(GoalDisplay.weekTargetLabel(goal()))
    }

    @Test
    fun theWeekPlansDecodeTolerantly() {
        val g = WaffledJson.decodeFromString<GoalsApi.Goal>(
            """{"id":"g1","weekPlan":{"weekStart":"2026-09-13","target":10,"done":3.5,"current":true}}""",
        )
        assertEquals(10.0, g.weekPlan?.target)
        val d = WaffledJson.decodeFromString<GoalsApi.GoalDetail>(
            """{"id":"g1","weekPlans":[{"weekStart":"2026-09-13","target":10,"done":3,"current":true},
               {"weekStart":"2026-09-20","target":12,"done":0,"current":false}]}""",
        )
        assertEquals(2, d.weekPlans?.size)
        assertNull(WaffledJson.decodeFromString<GoalsApi.GoalDetail>("""{"id":"g1"}""").weekPlans)
    }

    // ---- habit ------------------------------------------------------------------

    @Test
    fun habitShowsThisPeriodNotTheLifetimeTotal() {
        // 99 logs all-time, 2 of them this week: the ring is 2 of 5, not 99 of 5.
        val g = goal("habit", target = 5.0, totalProgress = 99.0, habitPeriod = "week", habitTargetPerPeriod = 5, periodDone = 2.0)
        assertEquals(2.0, GoalDisplay.progress(g))
        assertEquals(5.0, GoalDisplay.target(g))
        near(0.4, GoalDisplay.fraction(g))
    }

    @Test
    fun habitFallsBackToTheGoalTargetWhenCadenceIsMissing() {
        val g = goal("habit", target = 3.0, totalProgress = 9.0, habitPeriod = "week", periodDone = 1.0)
        assertEquals(3.0, GoalDisplay.target(g))
    }

    @Test
    fun habitFromAnOlderResponseWithoutPeriodDoneReadsZeroNotTheTotal() {
        // Never the lifetime total — a 0 makes a stale payload obvious instead.
        val g = goal("habit", target = 5.0, totalProgress = 99.0, habitPeriod = "week", habitTargetPerPeriod = 5)
        assertEquals(0.0, GoalDisplay.progress(g))
    }

    @Test
    fun habitPeriodLabelNamesTheWindow() {
        assertEquals("today", GoalDisplay.periodLabel(goal("habit", habitPeriod = "day")))
        assertEquals("this week", GoalDisplay.periodLabel(goal("habit", habitPeriod = "week")))
        assertEquals("this month", GoalDisplay.periodLabel(goal("habit", habitPeriod = "month")))
        // Unset cadence defaults to the week, matching the web goals list.
        assertEquals("this week", GoalDisplay.periodLabel(goal("habit", habitPeriod = null)))
        assertNull(GoalDisplay.periodLabel(goal("total")))
    }

    // ---- checklist --------------------------------------------------------------

    @Test
    fun checklistShowsStepsDoneOverStepTotal() {
        val g = goal("checklist", totalProgress = 3.0, stepTotal = 5, stepDone = 3)
        assertEquals(3.0, GoalDisplay.progress(g))
        assertEquals(5.0, GoalDisplay.target(g))
        near(0.6, GoalDisplay.fraction(g))
    }

    @Test
    fun emptyChecklistHasNoTargetAndAnEmptyBar() {
        val g = goal("checklist", stepTotal = 0, stepDone = 0)
        assertNull(GoalDisplay.target(g))
        assertEquals(0.0, GoalDisplay.fraction(g))
    }

    // ---- everything else --------------------------------------------------------

    @Test
    fun numericGoalStillShowsTheCumulativeTotal() {
        val g = goal("total", target = 1000.0, totalProgress = 312.0)
        assertEquals(312.0, GoalDisplay.progress(g))
        assertEquals(1000.0, GoalDisplay.target(g))
        near(0.312, GoalDisplay.fraction(g))
    }

    @Test
    fun perPersonTargetIsThePerPersonNumberTimesTheMembers() {
        // "read 12 books EACH", 2 people, both read 12 → 24 of 24, not 24 of 12.
        val g = goal("count", target = 12.0, totalProgress = 24.0, targetBasis = "per_person", people = 2)
        assertEquals(24.0, GoalDisplay.target(g))
        assertEquals(24.0, GoalDisplay.progress(g))
        assertEquals(1.0, GoalDisplay.fraction(g))
    }

    @Test
    fun perPersonWithNoMembersYetKeepsTheFlatTarget() {
        val g = goal("count", target = 12.0, targetBasis = "per_person", people = 0)
        assertEquals(12.0, GoalDisplay.target(g))
    }

    @Test
    fun familyBasisTargetIsTheFlatNumber() {
        val g = goal("total", target = 1000.0, totalProgress = 312.0, targetBasis = "family", people = 4)
        assertEquals(1000.0, GoalDisplay.target(g))
    }

    @Test
    fun fractionClampsAtFullAndSurvivesAMissingTarget() {
        assertEquals(1.0, GoalDisplay.fraction(goal("count", target = 10.0, totalProgress = 25.0)))
        assertEquals(0.0, GoalDisplay.fraction(goal("count", target = null, totalProgress = 25.0)))
        assertEquals(0.0, GoalDisplay.fraction(goal("count", target = 0.0, totalProgress = 25.0)))
    }

    @Test
    fun theRingCaptionNamesWhatTheNumberIsMeasuredAgainst() {
        val habit = goal("habit", habitPeriod = "week", habitTargetPerPeriod = 5, periodDone = 2.0)
        assertEquals("of 5 this week", GoalDisplay.targetCaption(habit, unit = null, fmt = ::goalFmt))
        val checklist = goal("checklist", stepTotal = 5, stepDone = 3)
        assertEquals("of 5 steps", GoalDisplay.targetCaption(checklist, unit = null, fmt = ::goalFmt))
        val total = goal("total", target = 1000.0, totalProgress = 312.0)
        assertEquals("of 1000 miles", GoalDisplay.targetCaption(total, unit = "miles", fmt = ::goalFmt))
    }

    // ---- milestones: the axis the SERVER used to decide `reached` -----------------

    @Test
    fun habitMilestonesAreMeasuredInStreakDays() {
        // A habit's "🔥 7 days" counts days in a row, never lifetime logs.
        val g = goal("habit", target = 5.0, totalProgress = 99.0, habitPeriod = "week",
            habitTargetPerPeriod = 5, periodDone = 2.0, streakDays = 3)
        assertEquals(3.0, GoalDisplay.milestoneAxis(g))
        assertEquals("4-day streak to go", GoalDisplay.milestoneToGo(g, threshold = 7.0, fmt = ::goalFmt))
    }

    @Test
    fun checklistMilestonesAreMeasuredInPercentComplete() {
        val g = goal("checklist", totalProgress = 3.0, stepTotal = 5, stepDone = 3)
        assertEquals(60.0, GoalDisplay.milestoneAxis(g))
        assertEquals("15% to go", GoalDisplay.milestoneToGo(g, threshold = 75.0, fmt = ::goalFmt))
    }

    @Test
    fun emptyChecklistIsZeroPercentNotADivideByZero() {
        assertEquals(0.0, GoalDisplay.milestoneAxis(goal("checklist", stepTotal = 0, stepDone = 0)))
    }

    @Test
    fun numericMilestonesStayOnTheCumulativeTotal() {
        val g = goal("total", target = 1000.0, totalProgress = 312.0)
        assertEquals(312.0, GoalDisplay.milestoneAxis(g))
        assertEquals("188 to go", GoalDisplay.milestoneToGo(g, threshold = 500.0, fmt = ::goalFmt))
    }

    @Test
    fun aPassedMilestoneNeverReadsNegative() {
        val g = goal("total", target = 1000.0, totalProgress = 900.0)
        assertEquals("0 to go", GoalDisplay.milestoneToGo(g, threshold = 500.0, fmt = ::goalFmt))
    }

    // ---- "already done today": a habit is once per day PER PERSON ------------------

    @Test
    fun aHabitIsDoneTodayWhenEveryonePickedHasAlreadyLogged() {
        val g = goal("habit", habitTargetPerPeriod = 5, periodDone = 1.0, loggedTodayBy = listOf("p0"))
        assertTrue(GoalDisplay.doneToday(g, who = setOf("p0")))
    }

    @Test
    fun aHabitIsNotDoneTodayWhileSomeonePickedStillOwesToday() {
        // The server dedupes per person, so the second person's completion is still live.
        val g = goal("habit", habitTargetPerPeriod = 5, periodDone = 1.0, loggedTodayBy = listOf("p0"))
        assertFalse(GoalDisplay.doneToday(g, who = setOf("p0", "p1")))
    }

    @Test
    fun aFamilyLogCountsUnderItsOwnSentinel() {
        val g = goal("habit", habitTargetPerPeriod = 5, periodDone = 1.0, loggedTodayBy = listOf("__family__"))
        assertTrue(GoalDisplay.doneToday(g, who = setOf("__family__")))
        assertFalse(GoalDisplay.doneToday(g, who = setOf("p0")))
    }

    @Test
    fun nothingIsBlockedWithNobodyPickedOrOnANonHabit() {
        val habit = goal("habit", habitTargetPerPeriod = 5, loggedTodayBy = listOf("p0"))
        assertFalse(GoalDisplay.doneToday(habit, who = emptySet()))
        // A count goal can be logged all day long.
        val count = goal("count", target = 20.0, loggedTodayBy = listOf("p0"))
        assertFalse(GoalDisplay.doneToday(count, who = setOf("p0")))
    }

    @Test
    fun aHabitWithNoParticipantsLogsForTheFamilyAndIsBlockedOnceItHas() {
        // No participants: the sheet picks nobody and the server writes a family row.
        val g = goal("habit", habitTargetPerPeriod = 5, people = 0, loggedTodayBy = listOf("__family__"))
        assertEquals(setOf("__family__"), GoalDisplay.logWho(g, picked = emptySet()))
        assertTrue(GoalDisplay.doneToday(g, who = GoalDisplay.logWho(g, picked = emptySet())))
    }

    @Test
    fun aGoalWithParticipantsKeepsTheLoggerPicksIncludingNone() {
        val g = goal("habit", habitTargetPerPeriod = 5, people = 2, loggedTodayBy = listOf("p0"))
        assertTrue(GoalDisplay.logWho(g, picked = emptySet()).isEmpty())
        assertEquals(setOf("p1"), GoalDisplay.logWho(g, picked = setOf("p1")))
    }

    @Test
    fun aFreshLoggedTodayOverridesTheListTheSheetWasOpenedWith() {
        val stale = goal("habit", habitTargetPerPeriod = 5, people = 1, loggedTodayBy = emptyList())
        assertFalse(GoalDisplay.doneToday(stale, who = setOf("p0")))
        assertTrue(GoalDisplay.doneToday(stale, who = setOf("p0"), loggedTodayBy = listOf("p0")))
    }

    @Test
    fun theHabitConfirmSaysAlreadySubmittedOnceDoneToday() {
        assertEquals("Already submitted today ✓", GoalDisplay.habitConfirmLabel(doneToday = true))
        assertEquals("Mark done for today", GoalDisplay.habitConfirmLabel(doneToday = false))
    }

    @Test
    fun anOlderResponseWithoutLoggedTodayByBlocksNothing() {
        // A missing field must not gate the button shut — the server still dedupes.
        val g = goal("habit", habitTargetPerPeriod = 5, loggedTodayBy = null)
        assertFalse(GoalDisplay.doneToday(g, who = setOf("p0")))
    }

    @Test
    fun onlyAnEntryDatedTodayIsBlocked() {
        // Backdating a missed day stays open even once today is done.
        val g = goal("habit", habitTargetPerPeriod = 5, people = 1, loggedTodayBy = listOf("p0"))
        val today = java.time.LocalDate.of(2026, 9, 14)
        assertTrue(GoalDisplay.blockedToday(g, picked = setOf("p0"), fresh = null, loggedOn = today, today = today))
        assertFalse(GoalDisplay.blockedToday(g, picked = setOf("p0"), fresh = null, loggedOn = today.minusDays(1), today = today))
    }

    @Test
    fun anEachTracksSpotlightSumsEveryonesOwnTarget() {
        val g = goal("habit", target = 5.0, people = 3)
        assertEquals(15.0, GoalDisplay.pooledTarget(g))
        assertEquals(5.0, GoalDisplay.pooledTarget(goal("habit", target = 5.0, people = 0)))
    }

    // ---- decoding: every new field is optional -----------------------------------

    @Test
    fun decodesAGoalPayloadCarryingTheNewFields() {
        val json = """
            {"id":"g1","goalListId":null,"title":"Move","emoji":null,"category":null,
             "goalType":"habit","unit":null,"habitPeriod":"week","habitTargetPerPeriod":5,
             "trackingMode":"shared_total","participantMode":"count_once","targetBasis":"family",
             "deadline":null,"isFeatured":false,"isSpotlight":false,"target":5,"totalProgress":9,
             "milestoneTotal":0,"milestoneReached":0,"periodDone":2,"stepTotal":0,"stepDone":0,
             "streakDays":3,"autoFromCalendar":false,"healthMetric":null,"createdAt":null,
             "participants":[]}
        """.trimIndent()
        val g = WaffledJson.decodeFromString<GoalsApi.Goal>(json)
        assertEquals(2.0, g.periodDone)
        assertEquals(2.0, GoalDisplay.progress(g))
    }

    @Test
    fun decodesAnOlderGoalPayloadWithoutTheNewFields() {
        // An older or cached response must still decode — a strict decode failure reads
        // to the user as a bogus "couldn't reach the server".
        val json = """
            {"id":"g1","goalListId":null,"title":"Move","emoji":null,"category":null,
             "goalType":"habit","unit":null,"habitPeriod":"week","habitTargetPerPeriod":5,
             "trackingMode":"shared_total","participantMode":"count_once","targetBasis":"family",
             "deadline":null,"isFeatured":false,"isSpotlight":false,"target":5,"totalProgress":9,
             "milestoneTotal":0,"milestoneReached":0,
             "streakDays":3,"autoFromCalendar":false,"healthMetric":null,"createdAt":null,
             "participants":[]}
        """.trimIndent()
        val g = WaffledJson.decodeFromString<GoalsApi.Goal>(json)
        assertNull(g.periodDone)
        assertNull(g.stepTotal)
        assertNull(g.loggedTodayBy)
    }

    @Test
    fun theDetailCarriesTheSameAxesSoItsHeroAgreesWithTheCard() {
        val json = """
            {"id":"g1","title":"Move","goalType":"checklist","totalProgress":3,
             "stepTotal":5,"stepDone":3,"periodDone":null,"loggedTodayBy":["p1"],
             "createdAt":"2026-07-07T12:00:00Z","participants":[],"milestones":[],"steps":[],"recent":[]}
        """.trimIndent()
        val d = WaffledJson.decodeFromString<GoalsApi.GoalDetail>(json)
        assertEquals(3.0, GoalDisplay.progress(d))
        assertEquals(5.0, GoalDisplay.target(d))
        assertEquals(listOf("p1"), d.loggedTodayBy)
    }
}
