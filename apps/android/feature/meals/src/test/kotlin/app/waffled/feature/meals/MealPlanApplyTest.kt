package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * What "Plan my week/month & build list" actually sends, as data — the port of
 * `apps/ios/Tests/MealPlanApplyTests.swift`.
 *
 * The week-derivation used to live inline in each sheet's apply, which meant the only
 * tests possible were of [GroceryWeeks.weekStarts] in isolation — nothing asserted that
 * an apply *issues* those rebuilds. A code review found the consequence: reverting either
 * sheet to a single `rebuildGrocery(weekStart = monthStart)` left every test green,
 * restoring the exact bug the change set out to fix.
 *
 * So the decision is a value, and the sheets are dumb executors of it — the same shape
 * [MealPlanSwap.writes] already uses for moves.
 */
class MealPlanApplyTest {

    private fun card(date: String, title: String, recipeId: String? = null) = PlanCardDTO(
        date = date, mealType = "dinner", title = title, recipeId = recipeId,
        emoji = null, minutes = 30, servings = 4, note = null,
    )

    private fun rebuilds(ops: List<MealPlanApply.Op>) =
        ops.filterIsInstance<MealPlanApply.Op.Rebuild>().map { it.weekStart }

    private fun writes(ops: List<MealPlanApply.Op>) =
        ops.filterIsInstance<MealPlanApply.Op.Set>().map { it.date }

    private fun clears(ops: List<MealPlanApply.Op>) =
        ops.filterIsInstance<MealPlanApply.Op.Clear>().map { it.date }

    // ---- month ----------------------------------------------------------------

    /**
     * The original bug, now unrevertable without failing here: a month is 4-6 grocery
     * weeks and a rebuild covers exactly one, so one call leaves the rest never shopped
     * for. Wednesdays across September 2026 — four distinct weeks under either cut.
     */
    @Test
    fun `a month rebuilds every week it touches`() {
        val ops = MealPlanApply.month(
            suggestions = listOf("2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23")
                .map { card(it, "Dish $it") },
            plannedDates = emptySet(), dirty = emptySet(), skipped = emptySet(),
            firstDay = HouseholdWeekStart.Sunday,
        )
        assertEquals(listOf("2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20"), rebuilds(ops))
    }

    /**
     * Ordering is not cosmetic: a rebuild reads the plan back off the server, so one
     * issued before its night is written builds the list from the OLD plan.
     */
    @Test
    fun `every write happens before any rebuild`() {
        val ops = MealPlanApply.month(
            suggestions = listOf("2026-09-02", "2026-09-09").map { card(it, "Dish $it") },
            plannedDates = setOf("2026-09-16"), dirty = emptySet(), skipped = setOf("2026-09-16"),
            firstDay = HouseholdWeekStart.Sunday,
        )
        val firstRebuild = ops.indexOfFirst { it is MealPlanApply.Op.Rebuild }
        val lastMutation = ops.indexOfLast { it !is MealPlanApply.Op.Rebuild }
        assertTrue(firstRebuild >= 0 && lastMutation >= 0)
        assertTrue(lastMutation < firstRebuild)
    }

    /**
     * A night the user skipped that WAS planned has to be cleared — and its week rebuilt,
     * or its shopping stays on the list for a dinner nobody is cooking.
     */
    @Test
    fun `a skipped night is cleared and its week still rebuilt`() {
        val ops = MealPlanApply.month(
            suggestions = listOf(card("2026-09-02", "Kept")),
            plannedDates = setOf("2026-09-16"), dirty = emptySet(), skipped = setOf("2026-09-16"),
            firstDay = HouseholdWeekStart.Sunday,
        )
        assertEquals(listOf("2026-09-16"), clears(ops))
        assertTrue(rebuilds(ops).contains("2026-09-13")) // the cleared night's week
        assertTrue(rebuilds(ops).contains("2026-08-30")) // the written night's week
    }

    /**
     * A night that was already planned and wasn't edited is left alone — rewriting it
     * would be pointless traffic, and its groceries are already on the list.
     */
    @Test
    fun `an untouched existing night is not rewritten`() {
        val ops = MealPlanApply.month(
            suggestions = listOf(card("2026-09-02", "Already there"), card("2026-09-09", "New")),
            plannedDates = setOf("2026-09-02"), dirty = emptySet(), skipped = emptySet(),
            firstDay = HouseholdWeekStart.Sunday,
        )
        assertEquals(listOf("2026-09-09"), writes(ops))
        assertEquals(listOf("2026-09-06"), rebuilds(ops))
    }

    /** …unless it was edited, in which case it is written and its week rebuilt. */
    @Test
    fun `an edited existing night is rewritten`() {
        val ops = MealPlanApply.month(
            suggestions = listOf(card("2026-09-02", "Changed my mind")),
            plannedDates = setOf("2026-09-02"), dirty = setOf("2026-09-02"), skipped = emptySet(),
            firstDay = HouseholdWeekStart.Sunday,
        )
        assertEquals(listOf("2026-09-02"), writes(ops))
        assertEquals(listOf("2026-08-30"), rebuilds(ops))
    }

    /**
     * A recipe-backed card sends its id and no title; a free-text card sends the reverse.
     * Sending both is what made a picked recipe land as a plain string.
     */
    @Test
    fun `a recipe card sends its id and a free-text card its title`() {
        val ops = MealPlanApply.month(
            suggestions = listOf(card("2026-09-02", "Tacos", recipeId = "r1"), card("2026-09-03", "Leftovers")),
            plannedDates = emptySet(), dirty = emptySet(), skipped = emptySet(),
            firstDay = HouseholdWeekStart.Sunday,
        )
        assertTrue(
            ops.contains(
                MealPlanApply.Op.Set(date = "2026-09-02", mealType = "dinner", recipeId = "r1", title = null),
            ),
        )
        assertTrue(
            ops.contains(
                MealPlanApply.Op.Set(date = "2026-09-03", mealType = "dinner", recipeId = null, title = "Leftovers"),
            ),
        )
    }

    // ---- week -----------------------------------------------------------------

    /**
     * A week of planning is usually one grocery week — but the planner grid snaps to the
     * DEVICE's first day while the list is keyed by the HOUSEHOLD's, so a Sun-Sat grid
     * can straddle two household weeks. Both get built.
     */
    @Test
    fun `a week that straddles two household weeks builds both`() {
        val ops = MealPlanApply.week(
            suggestions = listOf("2026-09-06", "2026-09-07").map { card(it, "Dish $it") },
            firstDay = HouseholdWeekStart.Monday,
        )
        assertEquals(listOf("2026-08-31", "2026-09-07"), rebuilds(ops))
    }

    @Test
    fun `a week writes every drafted night`() {
        val ops = MealPlanApply.week(
            suggestions = listOf("2026-09-07", "2026-09-08").map { card(it, "Dish $it") },
            firstDay = HouseholdWeekStart.Monday,
        )
        assertEquals(listOf("2026-09-07", "2026-09-08"), writes(ops))
        assertEquals(listOf("2026-09-07"), rebuilds(ops))
    }

    /** Nothing drafted means nothing sent — not a stray rebuild of the current week. */
    @Test
    fun `an empty plan sends nothing`() {
        assertTrue(MealPlanApply.week(emptyList(), HouseholdWeekStart.Sunday).isEmpty())
        assertTrue(
            MealPlanApply.month(
                suggestions = emptyList(), plannedDates = emptySet(), dirty = emptySet(),
                skipped = emptySet(), firstDay = HouseholdWeekStart.Sunday,
            ).isEmpty(),
        )
    }

    /** Unknown preference → cover both cuts, the same rule as [GroceryWeeks]. */
    @Test
    fun `an unknown preference covers both cuts`() {
        val ops = MealPlanApply.week(listOf(card("2026-09-09", "Dish")), firstDay = null)
        assertEquals(listOf("2026-09-06", "2026-09-07"), rebuilds(ops))
    }

    /**
     * A card backed by a Meal Builder plate has to send `mealId`, exactly as a planner
     * move does. Rebuilding it from `recipeId`/`title` alone drops the dishes and leaves
     * the plate's name behind as dead text.
     */
    @Test
    fun `a plate-backed card sends its mealId, not a bare title`() {
        val plate = PlanCardDTO(
            date = "2026-09-02", mealType = "dinner", title = "BBQ Sunday", recipeId = null,
            emoji = null, minutes = null, servings = 6, note = null, mealId = "m1",
        )
        val ops = MealPlanApply.week(listOf(plate), HouseholdWeekStart.Sunday)
        val set = ops.filterIsInstance<MealPlanApply.Op.Set>().firstOrNull()
        assertNotNull(set)
        assertEquals("m1", set.mealId)
        assertEquals(null, set.title)
        assertEquals(null, set.recipeId)
    }
}
