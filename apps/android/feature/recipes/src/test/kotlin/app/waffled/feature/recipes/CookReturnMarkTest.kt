package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * "Back to where I was" after a timer pulls you across the plate — the Kotlin port of
 * `apps/ios/Tests/CookReturnMarkTests.swift`.
 *
 * A fired timer jumps you to ITS dish and ITS step. That is right — the beeping pan is the
 * live one — but it costs you two things at once: the dish you were reading, and, if the
 * timer belongs to the dish you're already on, your own place in it. Cooking three things
 * at once is exactly when you can least afford to reconstruct that.
 *
 * So a jump records where it took you from, and the screen offers one tap back.
 */
class CookReturnMarkTest {

    private fun dish(id: String, steps: Int) = CookDish(
        id = id,
        title = id.replaceFirstChar { it.uppercase() },
        steps = (1..steps).map { RecipeStepDTO(stepNumber = it, instruction = "step $it") },
    )

    private fun session() = CookSession.of(
        "m1", "BBQ Sunday",
        listOf(dish("chicken", 8), dish("salad", 4), dish("bread", 3)),
    )!!

    @Test
    fun aFreshSessionHasNowhereToGoBackTo() {
        assertNull(session().pendingReturn)
    }

    @Test
    fun aTimerJumpRemembersTheDishAndStepItPulledYouOff() {
        var s = session().withIndex(5) // knee-deep in the chicken
        s = assertNotNull(s.jump("salad", 1)) // the salad's timer goes off

        val back = assertNotNull(s.pendingReturn)
        assertEquals("chicken", back.dishId)
        assertEquals(5, back.step)
        // and the jump did what it was asked
        assertEquals("salad", s.activeDishId)
        assertEquals(1, s.index)
    }

    @Test
    fun goingBackRestoresBothTheDishAndTheStep() {
        var s = session().withIndex(5)
        s = assertNotNull(s.jump("salad", 1))
        s = assertNotNull(s.goBack())
        assertEquals("chicken", s.activeDishId)
        assertEquals(5, s.index)
        // used up — the pill has done its job
        assertNull(s.pendingReturn)
    }

    /** The × on the pill. */
    @Test
    fun dismissingClearsTheMarkWithoutMovingYou() {
        var s = session().withIndex(5)
        s = assertNotNull(s.jump("salad", 1))
        s = s.dismissReturn()
        assertNull(s.pendingReturn)
        assertEquals("salad", s.activeDishId)
        assertEquals(1, s.index)
    }

    /**
     * A jump that moves you nowhere shouldn't offer a way back to where you already are —
     * tapping a timer for the step you're reading is a no-op, not a journey.
     */
    @Test
    fun aJumpThatDoesNotMoveYouRecordsNothing() {
        var s = session().withIndex(3)
        s = assertNotNull(s.jump("chicken", 3))
        assertNull(s.pendingReturn)
    }

    /**
     * A timer on the dish you're ALREADY reading still steals your place — this is the
     * case that has no tab to get back from, so it matters most.
     */
    @Test
    fun aSameDishJumpIsStillWorthAWayBack() {
        var s = session().withIndex(6)
        s = assertNotNull(s.jump("chicken", 1)) // its own step-1 timer fires
        val back = assertNotNull(s.pendingReturn)
        assertEquals("chicken", back.dishId)
        assertEquals(6, back.step)
    }

    /**
     * Walking back by hand should retire the pill — it would otherwise point at the spot
     * you're standing on.
     */
    @Test
    fun theOfferDisappearsOnceYouAreBackUnderYourOwnSteam() {
        var s = session().withIndex(5)
        s = assertNotNull(s.jump("salad", 1))
        assertNotNull(s.pendingReturn)
        s = assertNotNull(s.activate("chicken")) // tapped the tab yourself
        assertNull(s.pendingReturn) // already there; nothing to offer
    }

    /**
     * Two timers in a row: the way back is to where the LAST jump took you from, which is
     * the thing you were most recently reading.
     */
    @Test
    fun aSecondJumpRePointsTheWayBack() {
        var s = session().withIndex(5)
        s = assertNotNull(s.jump("salad", 1))
        s = s.withIndex(2) // read a little of the salad
        s = assertNotNull(s.jump("bread", 0))
        val back = assertNotNull(s.pendingReturn)
        assertEquals("salad", back.dishId)
        assertEquals(2, back.step)
    }

    /** The label names the dish the offer points at. */
    @Test
    fun theOfferNamesTheDishItPointsAt() {
        var s = session().withIndex(5)
        s = assertNotNull(s.jump("salad", 1))
        assertEquals("Chicken", s.pendingReturnTitle)
    }
}
