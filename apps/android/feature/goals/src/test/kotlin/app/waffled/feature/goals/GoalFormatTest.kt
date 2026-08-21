package app.waffled.feature.goals

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The little formatting rules every goal surface shares. They look trivial and are not:
 * amounts are stored EXACT (an hours+minutes log is 1h5m = 1.0833… h), so every display
 * has to go through [goalFmt] or the raw repeating decimal reaches the screen.
 */
class GoalFormatTest {

    // ---- goalFmt ---------------------------------------------------------------

    @Test
    fun aWholeNumberLosesItsDecimal() {
        assertEquals("3", goalFmt(3.0))
        assertEquals("0", goalFmt(0.0))
        assertEquals("1000", goalFmt(1000.0))
    }

    @Test
    fun aFractionKeepsAtMostTwoDecimalsWithNoTrailingZeros() {
        assertEquals("1.5", goalFmt(1.5))
        assertEquals("2.58", goalFmt(2.5833333))
        assertEquals("6.17", goalFmt(6.1666667))
        assertEquals("1.08", goalFmt(1.0833333))
    }

    @Test
    fun aNearWholeAmountRoundsCleanRatherThanShowingPointZeroZero() {
        assertEquals("3", goalFmt(2.999999))
        assertEquals("1", goalFmt(1.001))
    }

    @Test
    fun aNegativeCorrectionKeepsItsSign() {
        assertEquals("-2", goalFmt(-2.0))
        assertEquals("-1.5", goalFmt(-1.5))
    }

    @Test
    fun nothingToShowIsAnEmDash() {
        assertEquals("—", goalFmt(null))
    }

    // ---- ringFmt ---------------------------------------------------------------

    @Test
    fun theRingRoundsSmallValuesToAWholeNumber() {
        assertEquals("296", ringFmt(295.99))
        assertEquals("0", ringFmt(0.0))
        assertEquals("999", ringFmt(999.0))
    }

    @Test
    fun theRingAbbreviatesLargeValuesSoTheyStayReadable() {
        assertEquals("1K", ringFmt(1000.0))
        assertEquals("10K", ringFmt(10_000.0))
        assertEquals("1.5K", ringFmt(1500.0))
        assertEquals("1.2M", ringFmt(1_234_567.0))
        assertEquals("2.5B", ringFmt(2_500_000_000.0))
    }

    @Test
    fun anAbbreviationThatRoundsUpPastItsOwnSuffixPromotes() {
        // 999,999 must not render as "1000K".
        assertEquals("1M", ringFmt(999_999.0))
    }

    @Test
    fun theRingAbbreviatesNegativesToo() {
        assertEquals("-1.5K", ringFmt(-1500.0))
        assertEquals("—", ringFmt(null))
    }

    // ---- descriptors -----------------------------------------------------------

    @Test
    fun aFirstNameIsTheFirstWord() {
        assertEquals("Kevin", goalFirstName("Kevin Sites"))
        assertEquals("Kevin", goalFirstName("Kevin"))
        assertEquals("", goalFirstName(""))
    }

    @Test
    fun theDescriptorNamesTheMeasureAndItsQuantity() {
        assertEquals(
            "Count · in books",
            goalDescriptor(GoalsApi.Goal(id = "g", goalType = "count", unit = "books")),
        )
        assertEquals(
            "Habit · 5× a week",
            goalDescriptor(
                GoalsApi.Goal(id = "g", goalType = "habit", habitPeriod = "week", habitTargetPerPeriod = 5),
            ),
        )
        assertEquals(
            "Count · each logs visits",
            goalDescriptor(
                GoalsApi.Goal(id = "g", goalType = "count", unit = "visits", trackingMode = "each_tracks"),
            ),
        )
        assertEquals(
            "Total · shared total",
            goalDescriptor(GoalsApi.Goal(id = "g", goalType = "total", unit = null)),
        )
        assertEquals(
            "Milestones · shared total",
            goalDescriptor(GoalsApi.Goal(id = "g", goalType = "checklist")),
        )
    }

    @Test
    fun anUnknownMeasureFallsBackToItsOwnKey() {
        assertEquals("mystery · shared total", goalDescriptor(GoalsApi.Goal(id = "g", goalType = "mystery")))
    }

    @Test
    fun aHabitWithNoCadenceStillReads() {
        assertEquals("Habit · 0× a week", goalDescriptor(GoalsApi.Goal(id = "g", goalType = "habit")))
    }

    // ---- the Today review banner ------------------------------------------------

    @Test
    fun theReviewHeadlineCountsBothQueues() {
        assertEquals("2 to review · 3 to link", reviewRecapTitle(2, 3))
    }

    @Test
    fun theReviewHeadlineSingularisesEachQueueOnItsOwn() {
        assertEquals("1 event to log", reviewRecapTitle(1, 0))
        assertEquals("4 events to log", reviewRecapTitle(4, 0))
        assertEquals("1 event might count", reviewRecapTitle(0, 1))
        assertEquals("2 events might count", reviewRecapTitle(0, 2))
    }

    // ---- category glyphs -------------------------------------------------------

    @Test
    fun everyCategoryHasItsOwnGlyphAndTheRestFallBack() {
        assertEquals("🏃", goalCategoryEmoji("physical"))
        assertEquals("📚", goalCategoryEmoji("intellectual"))
        assertEquals("🧘", goalCategoryEmoji("spiritual"))
        assertEquals("🎨", goalCategoryEmoji("creative"))
        assertEquals("🤝", goalCategoryEmoji("social"))
        assertEquals("🎯", goalCategoryEmoji(null))
        assertEquals("🎯", goalCategoryEmoji("unheard-of"))
    }

    // ---- unit words -------------------------------------------------------------

    @Test
    fun aUnitIsSingularisedForExactlyOne() {
        assertEquals("hour", goalUnitLabel("hours", 1.0))
        assertEquals("hours", goalUnitLabel("hours", 2.0))
        assertEquals("", goalUnitLabel(null, 1.0))
        assertEquals("min", goalUnitLabel("min", 1.0), "a unit with no plural s is left alone")
    }

    @Test
    fun aTimeUnitStepsInHalvesAndEverythingElseInWholes() {
        assertEquals(0.5, goalStepSize("hours"))
        assertEquals(0.5, goalStepSize("MIN"))
        assertEquals(1.0, goalStepSize("books"))
        assertEquals(1.0, goalStepSize(null))
    }

    @Test
    fun anHourGoalIsRecognisedByItsUnit() {
        assertTrue(isHourUnit("hours"))
        assertTrue(isHourUnit("HR"))
        assertFalse(isHourUnit("minutes"))
        assertFalse(isHourUnit(null))
    }

    private fun assertTrue(value: Boolean) = kotlin.test.assertTrue(value)
    private fun assertFalse(value: Boolean) = kotlin.test.assertFalse(value)
}
