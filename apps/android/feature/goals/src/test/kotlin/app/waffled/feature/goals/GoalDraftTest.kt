package app.waffled.feature.goals

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The goal editor's state machine and body builder, lifted out of the composable so the
 * parts that are easy to get wrong are testable: the counting model, the auto-derived
 * milestone ladder, and — most of all — which keys reach the wire as an explicit null and
 * which must not be sent at all.
 */
class GoalDraftTest {

    // ---- "nice" numbers --------------------------------------------------------

    @Test
    fun niceRoundSnapsTheLeadingDigit() {
        assertEquals(1, GoalDraft.niceRound(1.0))
        assertEquals(2, GoalDraft.niceRound(2.0))
        assertEquals(250, GoalDraft.niceRound(333.33))
        assertEquals(500, GoalDraft.niceRound(666.67))
        assertEquals(100, GoalDraft.niceRound(100.0))
        assertEquals(0, GoalDraft.niceRound(0.0))
        assertEquals(0, GoalDraft.niceRound(-5.0))
    }

    @Test
    fun niceRoundHandlesValuesBelowOne() {
        assertEquals(1, GoalDraft.niceRound(0.9))
        // A checkpoint below half a unit collapses to nothing — niceThirds drops it
        // rather than offering a milestone at zero.
        assertEquals(0, GoalDraft.niceRound(0.1))
    }

    @Test
    fun niceThirdsSplitsATargetIntoAscendingCheckpoints() {
        assertEquals(listOf(100, 200, 300), GoalDraft.niceThirds(300))
        assertEquals(listOf(250, 500, 750), GoalDraft.niceThirds(750))
        assertEquals(listOf(250, 500, 1000), GoalDraft.niceThirds(1000))
    }

    @Test
    fun niceThirdsDegradesForATinyTarget() {
        assertEquals(listOf(1), GoalDraft.niceThirds(1))
        assertEquals(listOf(1), GoalDraft.niceThirds(0))
        // A tiny target can't carry three distinct checkpoints; duplicates are dropped.
        val two = GoalDraft.niceThirds(2)
        assertEquals(two.sorted(), two)
        assertEquals(two.distinct(), two)
        assertEquals(2, two.last())
    }

    // ---- derived milestones ----------------------------------------------------

    @Test
    fun anAmountGoalGetsThreeThirdsWithNoRewardText() {
        val ms = GoalDraft.derivedMilestones("total", 300)
        assertEquals(listOf("100", "200", "300"), ms.map { it.threshold })
        assertEquals(listOf("🌱", "⛺", "🏆"), ms.map { it.emoji })
        // Goals stay about growth: the family fills in a reward only if they want one.
        assertTrue(ms.all { it.reward.isEmpty() })
    }

    @Test
    fun aHabitsMilestonesAreStreakDaysAndAChecklistsArePercent() {
        assertEquals(listOf("7", "30", "100"), GoalDraft.derivedMilestones("habit", 5).map { it.threshold })
        assertEquals(listOf("50", "100"), GoalDraft.derivedMilestones("checklist", 0).map { it.threshold })
    }

    @Test
    fun theLadderReDerivesUntilSomeoneHandEditsIt() {
        val start = GoalDraft.new(defaultListId = "l1").copy(target = "300")
            .let { it.copy(milestones = GoalDraft.derivedMilestones(it.goalType, 300), lastDerivedSignature = GoalDraft.signature(GoalDraft.derivedMilestones(it.goalType, 300))) }

        val retargeted = start.copy(target = "750").reDeriveIfUntouched()
        assertEquals(listOf("250", "500", "750"), retargeted.milestones.map { it.threshold })

        val handEdited = retargeted.copy(
            milestones = retargeted.milestones.mapIndexed { i, m -> if (i == 0) m.copy(reward = "Ice cream") else m },
        )
        val afterEdit = handEdited.copy(target = "1000").reDeriveIfUntouched()
        assertEquals("Ice cream", afterEdit.milestones[0].reward)
        assertEquals(listOf("250", "500", "750"), afterEdit.milestones.map { it.threshold })
    }

    @Test
    fun anEditedGoalKeepsItsOwnLadder() {
        val editing = GoalDraft.new(defaultListId = null).copy(isEditing = true, target = "300")
        assertEquals(editing.milestones, editing.copy(target = "9999").reDeriveIfUntouched().milestones)
    }

    // ---- the counting model ----------------------------------------------------

    @Test
    fun aNewGoalDefaultsToEachTracksTheirOwn() {
        val d = GoalDraft.new(defaultListId = "l1")
        assertFalse(d.shared)
        assertEquals("each_tracks", d.trackingMode)
        assertEquals("per_person", d.targetBasis)
    }

    @Test
    fun sharedAndEachRoundTripForAnAmountGoal() {
        val each = GoalDraft.new(null).copy(goalType = "total").setEachMode()
        assertFalse(each.shared)
        assertEquals("each_tracks", each.trackingMode)
        assertEquals("per_person", each.targetBasis)

        val shared = each.setSharedMode()
        assertTrue(shared.shared)
        assertEquals("each_tracks", shared.trackingMode)
        assertEquals("family", shared.targetBasis, "a shared amount goal is a flat family target")
    }

    @Test
    fun sharedAndEachRoundTripForAHabit() {
        val shared = GoalDraft.new(null).copy(goalType = "habit").setSharedMode()
        assertTrue(shared.shared)
        assertEquals("shared_total", shared.trackingMode)

        val each = shared.setEachMode()
        assertFalse(each.shared)
        assertEquals("each_tracks", each.trackingMode)
        assertEquals("family", each.targetBasis, "a habit has no per-person target basis")
    }

    @Test
    fun theCountSubChoiceMapsOntoTheBackendTriple() {
        val total = GoalDraft.new(null).copy(goalType = "total")
        val full = total.setCountChoice("full")
        assertEquals("full", full.countChoice)
        assertEquals(Triple("each_tracks", "family", "count_once"), full.countingTriple())

        val split = total.setCountChoice("split")
        assertEquals("split", split.countChoice)
        assertEquals(Triple("shared_total", "family", "split"), split.countingTriple())

        val count = GoalDraft.new(null).copy(goalType = "count")
        val each = count.setCountChoice("each")
        assertEquals("each", each.countChoice)
        assertEquals(Triple("each_tracks", "family", "count_once"), each.countingTriple())

        val once = count.setCountChoice("once")
        assertEquals("once", once.countChoice)
        assertEquals(Triple("shared_total", "family", "count_once"), once.countingTriple())
    }

    @Test
    fun switchingMeasureFitsTheUnitAndKeepsTheSharedChoice() {
        val total = GoalDraft.new(null).copy(goalType = "total", unit = "hours").setSharedMode()
        val count = total.selectMeasure("count")
        assertEquals("count", count.goalType)
        assertEquals("", count.unit, "Count must not inherit the Total default of hours")
        assertTrue(count.shared, "flipping the measure must not silently un-share the goal")

        val backToTotal = count.selectMeasure("total")
        assertEquals("hours", backToTotal.unit)
    }

    @Test
    fun switchingMeasureKeepsAHandTypedUnit() {
        val d = GoalDraft.new(null).copy(goalType = "total", unit = "miles").selectMeasure("count")
        assertEquals("miles", d.unit)
    }

    // ---- validation ------------------------------------------------------------

    @Test
    fun anAmountGoalNeedsATitleATargetAndAUnit() {
        val base = GoalDraft.new(null).copy(goalType = "total", title = "Outside", target = "1000", unit = "hours")
        assertTrue(base.canSave)
        assertFalse(base.copy(title = "   ").canSave)
        assertFalse(base.copy(target = "0").canSave)
        assertFalse(base.copy(target = "").canSave)
        assertFalse(base.copy(unit = " ").canSave)
    }

    @Test
    fun aHabitNeedsAPositiveCadence() {
        val base = GoalDraft.new(null).copy(goalType = "habit", title = "Stretch", habitPer = "5")
        assertTrue(base.canSave)
        assertFalse(base.copy(habitPer = "0").canSave)
        assertFalse(base.copy(habitPer = "").canSave)
    }

    @Test
    fun aChecklistNeedsAtLeastOneNamedStep() {
        val blank = GoalDraft.new(null).copy(goalType = "checklist", title = "Ladder")
        assertFalse(blank.canSave, "three empty rows are not steps")
        val filled = blank.copy(steps = listOf(GoalDraft.StepDraft(label = "Pick a book"), GoalDraft.StepDraft(label = "  ")))
        assertTrue(filled.canSave)
        assertEquals(1, filled.filledSteps.size)
    }

    // ---- the body --------------------------------------------------------------

    private fun amountDraft() = GoalDraft.new(defaultListId = "l1").copy(
        title = "  1,000 Hours Outside  ",
        goalType = "total",
        unit = " hours ",
        target = "1000",
        category = "physical",
    )

    @Test
    fun theBodyCarriesTheRequiredFields() {
        val body = amountDraft().body(participantIds = listOf("p1", "p2"))

        assertEquals("1,000 Hours Outside", body["title"]?.jsonPrimitive?.content)
        assertEquals("total", body["goalType"]?.jsonPrimitive?.content)
        assertEquals("physical", body["category"]?.jsonPrimitive?.content)
        assertEquals("hours", body["unit"]?.jsonPrimitive?.content)
        assertEquals("1000.0", body["targetValue"]?.jsonPrimitive?.content)
        assertEquals("quick_log", body["logMethod"]?.jsonPrimitive?.content)
        assertEquals(listOf("p1", "p2"), body["participantIds"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun aClearedListDeadlineOrUnitReachesTheServerAsAnExplicitNull() {
        // explicitNulls = false means an omitted key reads as "leave it alone", so every
        // clearable field has to be sent deliberately or removing it looks broken.
        val body = amountDraft().copy(goalListId = null, hasDeadline = false, unit = "  ").body(emptyList())

        assertEquals(JsonNull, body["goalListId"])
        assertEquals(JsonNull, body["deadline"])
        assertEquals(JsonNull, body["unit"])
    }

    @Test
    fun aDeadlineIsSentAsAPlainDay() {
        val body = amountDraft().copy(hasDeadline = true, deadline = LocalDate.of(2026, 12, 31)).body(emptyList())
        assertEquals("2026-12-31", body["deadline"]?.jsonPrimitive?.content)
    }

    @Test
    fun theAppleHealthKeysAreNEVERSent() {
        // Android has no health source, so it must not have an opinion about the link.
        // iOS sends an explicit null when its toggle is off; copying that would wipe an
        // Apple Health link off any goal the moment someone edited it from their phone.
        val body = amountDraft().copy(isEditing = true).body(emptyList())

        assertFalse("healthMetric" in body, "an Android edit must preserve the iOS health link")
        assertFalse("healthDailyTarget" in body)
    }

    @Test
    fun aHabitSendsItsCadenceThreeWays() {
        val body = GoalDraft.new(null)
            .copy(goalType = "habit", title = "Stretch", habitPer = "5", habitPeriod = "week")
            .body(emptyList())

        assertEquals("5", body["targetValue"]?.jsonPrimitive?.content)
        assertEquals("5", body["habitTargetPerPeriod"]?.jsonPrimitive?.content)
        assertEquals("week", body["habitPeriod"]?.jsonPrimitive?.content)
        assertEquals(JsonNull, body["unit"], "a habit has no unit")
    }

    @Test
    fun aChecklistSendsNamedStepsAndCarriesServerIdsOnEdit() {
        val body = GoalDraft.new(null).copy(
            goalType = "checklist",
            title = "Ladder",
            steps = listOf(
                GoalDraft.StepDraft(existingId = "s1", label = " Pick a book "),
                GoalDraft.StepDraft(existingId = null, label = "Read it"),
                GoalDraft.StepDraft(existingId = null, label = "   "),
            ),
        ).body(emptyList())

        val steps = body["steps"]!!.jsonArray
        assertEquals(2, steps.size, "blank rows are not steps")
        assertEquals("Pick a book", steps[0].jsonObject["label"]?.jsonPrimitive?.content)
        assertEquals("s1", steps[0].jsonObject["id"]?.jsonPrimitive?.content)
        assertNull(steps[1].jsonObject["id"], "a brand-new step has no server id yet")
        assertEquals(JsonNull, body["targetValue"])
    }

    @Test
    fun aChecklistNeverAutoCountsFromTheCalendar() {
        // Checklist progress comes from ticking steps; a matching event has nothing to add.
        val body = GoalDraft.new(null).copy(goalType = "checklist", autoFromCalendar = true).body(emptyList())
        assertEquals(false, body["autoFromCalendar"]?.jsonPrimitive?.content?.toBoolean())
    }

    @Test
    fun milestonesOnlyTravelWhenRewardsAreOn() {
        val withRewards = amountDraft().copy(hasRewards = true).body(emptyList())
        assertTrue(withRewards["milestones"]!!.jsonArray.isNotEmpty())

        val without = amountDraft().copy(hasRewards = false).body(emptyList())
        assertTrue(without["milestones"]!!.jsonArray.isEmpty(), "rewards off clears the ladder server-side")
    }

    @Test
    fun aMilestoneRowTravelsWithItsThresholdEmojiAndReward() {
        val body = amountDraft().copy(
            hasRewards = true,
            milestones = listOf(GoalDraft.MilestoneDraft(emoji = "🏆", threshold = "500", reward = "Pizza")),
        ).body(emptyList())

        val m = body["milestones"]!!.jsonArray.single().jsonObject
        assertEquals("500", m["threshold"]?.jsonPrimitive?.content)
        assertEquals("🏆", m["emoji"]?.jsonPrimitive?.content)
        assertEquals("Pizza", m["rewardText"]?.jsonPrimitive?.content)
    }

    @Test
    fun theTierFlagsTravelAsTheyWereChosen() {
        val spotlight = amountDraft().withTier(GoalDraft.Tier.Spotlight).body(emptyList())
        assertEquals("true", spotlight["isSpotlight"]?.jsonPrimitive?.content)
        assertEquals("false", spotlight["isFeatured"]?.jsonPrimitive?.content)

        val pinned = amountDraft().withTier(GoalDraft.Tier.Pinned).body(emptyList())
        assertEquals("false", pinned["isSpotlight"]?.jsonPrimitive?.content)
        assertEquals("true", pinned["isFeatured"]?.jsonPrimitive?.content)

        val normal = amountDraft().withTier(GoalDraft.Tier.Normal)
        assertEquals(GoalDraft.Tier.Normal, normal.tier)
    }

    // ---- prefill ---------------------------------------------------------------

    @Test
    fun editingPrefillsFromTheGoalsOwnValues() {
        val detail = GoalsApi.GoalDetail(
            id = "g1",
            goalListId = "l7",
            title = "Read 20 books",
            category = "intellectual",
            goalType = "count",
            unit = "books",
            target = 20.0,
            trackingMode = "shared_total",
            participantMode = "count_once",
            targetBasis = "family",
            isFeatured = true,
            isSpotlight = false,
            hasRewards = true,
            deadline = "2026-12-31T00:00:00Z",
            createdAt = "2026-01-01T00:00:00Z",
            autoFromCalendar = false,
            healthMetric = "steps",
            milestones = listOf(GoalsApi.GoalDetail.Milestone(id = "m1", threshold = 10.0, emoji = "🌱", rewardText = "Pizza")),
            steps = listOf(GoalsApi.GoalDetail.Step(id = "s1", label = "Pick a book")),
        )

        val d = GoalDraft.from(detail)

        assertTrue(d.isEditing)
        assertEquals("Read 20 books", d.title)
        assertEquals("l7", d.goalListId)
        assertEquals("count", d.goalType)
        assertEquals("books", d.unit)
        assertEquals("20", d.target, "a whole target must not prefill as 20.0")
        assertEquals(GoalDraft.Tier.Pinned, d.tier)
        assertTrue(d.hasRewards)
        assertTrue(d.hasDeadline)
        assertEquals(LocalDate.of(2026, 12, 31), d.deadline)
        assertEquals("Pizza", d.milestones.single().reward)
        assertEquals("s1", d.steps.single().existingId)
    }

    @Test
    fun anEditedGoalWithNoDeadlineDoesNotInventOne() {
        val d = GoalDraft.from(GoalsApi.GoalDetail(id = "g1", title = "Open", deadline = null))
        assertFalse(d.hasDeadline)
        assertEquals(JsonNull, d.body(emptyList())["deadline"])
    }

    @Test
    fun anEditRoundTripsTheHealthLinkedGoalWithoutTouchingIt() {
        val detail = GoalsApi.GoalDetail(
            id = "g1", title = "Steps", goalType = "total", unit = "steps", target = 10000.0,
            healthMetric = "steps", healthDailyTarget = 8000.0,
        )
        val body = GoalDraft.from(detail).body(listOf("p1"))

        assertFalse("healthMetric" in body)
        assertFalse("healthDailyTarget" in body)
        assertEquals("steps", body["unit"]?.jsonPrimitive?.content)
    }
}
