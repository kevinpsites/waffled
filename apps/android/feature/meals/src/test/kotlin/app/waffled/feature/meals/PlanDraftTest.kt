package app.waffled.feature.meals

import app.waffled.core.model.RecipeRef
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * How a draft's answer is merged into the review.
 *
 * This has no iOS test — it was inline in `PlanWeekSheet.draft`. It is also the part
 * most likely to misbehave in the field, because it exists to repair a weak local model:
 * one that echoes a dish already in the avoid list (so a swap would visibly change
 * nothing) or skips a night it was asked for.
 */
class PlanDraftTest {

    private fun card(date: String, title: String, recipeId: String? = null) =
        PlanCardDTO(date = date, mealType = "dinner", title = title, recipeId = recipeId, minutes = 30)

    private val pool = listOf(
        RecipeRef(id = "lib1", title = "Shepherd's Pie"),
        RecipeRef(id = "lib2", title = "Ramen"),
    )

    private fun resolve(
        dates: List<String>,
        drafted: List<PlanCardDTO>,
        prior: List<PlanCardDTO> = emptyList(),
        avoid: List<String> = emptyList(),
        pool: List<RecipeRef> = this.pool,
    ) = PlanDraft.resolve(
        dates = dates, drafted = drafted, prior = prior, avoid = avoid,
        pool = pool, mealType = "dinner", servings = 4,
    )

    /** Titles are matched the way the server's matcher does: letters and digits only. */
    @Test
    fun `titles are normalised before comparison`() {
        assertEquals(PlanDraft.normTitle("Grandma's Soup!"), PlanDraft.normTitle("grandmas soup"))
        assertEquals("tacos", PlanDraft.normTitle("  Tacos  "))
    }

    @Test
    fun `a clean draft is taken as-is, in date order`() {
        val out = resolve(
            dates = listOf("2026-09-03", "2026-09-02"),
            drafted = listOf(card("2026-09-02", "Tacos"), card("2026-09-03", "Curry")),
        )
        assertEquals(listOf("2026-09-02", "2026-09-03"), out.suggestions.map { it.date })
        assertEquals(listOf("Tacos", "Curry"), out.suggestions.map { it.title })
        assertTrue(out.changed)
    }

    /** Nights that weren't re-drafted are kept untouched and stay in the list. */
    @Test
    fun `nights outside the redraft are kept`() {
        val out = resolve(
            dates = listOf("2026-09-03"),
            drafted = listOf(card("2026-09-03", "Curry")),
            prior = listOf(card("2026-09-02", "Tacos"), card("2026-09-03", "Old dish")),
        )
        assertEquals(listOf("Tacos", "Curry"), out.suggestions.map { it.title })
    }

    /**
     * The repair that matters: the model echoed a dish the user already rejected, so a
     * swap would change nothing. The library fills the night instead, and the notice
     * stays off because something really did move.
     */
    @Test
    fun `an echoed avoided dish is replaced from the library`() {
        val out = resolve(
            dates = listOf("2026-09-02"),
            drafted = listOf(card("2026-09-02", "Tacos")),
            prior = listOf(card("2026-09-02", "Tacos")),
            avoid = listOf("Tacos"),
        )
        assertEquals(listOf("Shepherd's Pie"), out.suggestions.map { it.title })
        assertEquals("lib1", out.suggestions.single().recipeId)
        assertEquals("From your library", out.suggestions.single().note)
        assertTrue(out.changed)
    }

    /**
     * A dish already planned on a night we are KEEPING is off-limits too, or two nights
     * end up with the same dinner.
     */
    @Test
    fun `a dish already used on a kept night is replaced`() {
        val out = resolve(
            dates = listOf("2026-09-03"),
            drafted = listOf(card("2026-09-03", "Tacos")),
            prior = listOf(card("2026-09-02", "Tacos"), card("2026-09-03", "Old")),
        )
        assertEquals("Shepherd's Pie", out.suggestions.first { it.date == "2026-09-03" }.title)
    }

    /**
     * Two nights re-drafted at once can't both take the same library fallback — the
     * second has to move on to the next recipe.
     */
    @Test
    fun `the fallback pool is not reused within one draft`() {
        val out = resolve(
            dates = listOf("2026-09-02", "2026-09-03"),
            drafted = listOf(card("2026-09-02", "Tacos"), card("2026-09-03", "Tacos")),
            avoid = listOf("Tacos"),
        )
        assertEquals(listOf("Shepherd's Pie", "Ramen"), out.suggestions.map { it.title })
    }

    /**
     * Nothing fresher exists: keep the model's answer rather than dropping the night.
     * A missing card is worse than a repeated one — the user can still Pick.
     */
    @Test
    fun `an exhausted library keeps the model's answer`() {
        val out = resolve(
            dates = listOf("2026-09-02"),
            drafted = listOf(card("2026-09-02", "Tacos")),
            prior = listOf(card("2026-09-02", "Tacos")),
            avoid = listOf("Tacos"),
            pool = emptyList(),
        )
        assertEquals(listOf("Tacos"), out.suggestions.map { it.title })
        // …and the caller is told nothing moved, so it can point at Pick.
        assertFalse(out.changed)
    }

    /** A night the model skipped entirely is filled from the library. */
    @Test
    fun `a night the model skipped is filled from the library`() {
        val out = resolve(
            dates = listOf("2026-09-02", "2026-09-03"),
            drafted = listOf(card("2026-09-02", "Tacos")),
        )
        assertEquals(listOf("Tacos", "Shepherd's Pie"), out.suggestions.map { it.title })
    }

    /** A night with no answer and no library left simply has no card. */
    @Test
    fun `a night with nothing available is dropped`() {
        val out = resolve(dates = listOf("2026-09-02"), drafted = emptyList(), pool = emptyList())
        assertTrue(out.suggestions.isEmpty())
    }

    /** Drafting nothing is not an error and changes nothing. */
    @Test
    fun `an empty draft request is inert`() {
        val prior = listOf(card("2026-09-02", "Tacos"))
        val out = resolve(dates = emptyList(), drafted = emptyList(), prior = prior)
        assertEquals(prior, out.suggestions)
        assertFalse(out.changed)
    }

    /** A library-fallback card carries the servings the sheet is planning for. */
    @Test
    fun `a fallback card carries the configured servings`() {
        val out = resolve(dates = listOf("2026-09-02"), drafted = emptyList())
        assertEquals(4, out.suggestions.single().servings)
        assertEquals("dinner", out.suggestions.single().mealType)
    }
}

/** Swapping two review nights by hand. */
class PlanDraftSwapTest {

    private fun card(date: String, title: String, recipeId: String? = null) =
        PlanCardDTO(date = date, mealType = "dinner", title = title, recipeId = recipeId, emoji = "🍜", minutes = 20)

    private val week = listOf(
        card("2026-09-02", "Tacos", recipeId = "r1"),
        card("2026-09-03", "Curry", recipeId = "r2"),
        card("2026-09-04", "Soup"),
    )

    @Test
    fun `swapping exchanges the meals but keeps each card's date`() {
        val out = PlanDraft.swapCards(week, "2026-09-02", "2026-09-04", locked = emptySet())
        assertNotNull(out)
        assertEquals(listOf("2026-09-02", "2026-09-03", "2026-09-04"), out.map { it.date })
        assertEquals("Soup", out.first { it.date == "2026-09-02" }.title)
        assertEquals("Tacos", out.first { it.date == "2026-09-04" }.title)
        // The recipe link travels with the meal, not with the night.
        assertNull(out.first { it.date == "2026-09-02" }.recipeId)
        assertEquals("r1", out.first { it.date == "2026-09-04" }.recipeId)
    }

    /** A plate-backed card keeps its plate when it moves night. */
    @Test
    fun `a plate-backed card carries its mealId across the swap`() {
        val cards = listOf(
            card("2026-09-02", "BBQ Sunday").copy(mealId = "m1", recipeId = null),
            card("2026-09-03", "Curry", recipeId = "r2"),
        )
        val out = PlanDraft.swapCards(cards, "2026-09-02", "2026-09-03", locked = emptySet())
        assertNotNull(out)
        assertEquals("m1", out.first { it.date == "2026-09-03" }.mealId)
        assertNull(out.first { it.date == "2026-09-02" }.mealId)
    }

    /** A locked night is one the user said not to touch — neither end may move. */
    @Test
    fun `a locked night refuses to swap from either end`() {
        assertNull(PlanDraft.swapCards(week, "2026-09-02", "2026-09-03", locked = setOf("2026-09-02")))
        assertNull(PlanDraft.swapCards(week, "2026-09-02", "2026-09-03", locked = setOf("2026-09-03")))
    }

    @Test
    fun `swapping a night with itself or with an absent night is a no-op`() {
        assertNull(PlanDraft.swapCards(week, "2026-09-02", "2026-09-02", locked = emptySet()))
        assertNull(PlanDraft.swapCards(week, "2026-09-02", "2026-09-09", locked = emptySet()))
    }
}

/**
 * Where a planned meal may be moved to.
 *
 * Compose's drag-and-drop modifiers are experimental, and the iOS trick that stops a
 * TextField eating the payload (a custom non-text UTI) has no Android analogue — so the
 * planner offers an explicit "Move to…" list instead. Which slots that list contains is
 * logic, not layout, so it lives here.
 */
class MoveTargetsTest {

    private val days = listOf("2026-07-13", "2026-07-14", "2026-07-15")
    private val slots = listOf("breakfast", "dinner")

    private fun entry(date: String, slot: String, title: String) =
        WeekEntryDTO(id = "$date-$slot", date = date, mealType = slot, title = title)

    private val entries = listOf(
        entry("2026-07-13", "dinner", "Tacos"),
        entry("2026-07-14", "dinner", "Curry"),
    )

    @Test
    fun `every visible slot except the source is offered`() {
        val targets = MoveTargets.of(entries, days, slots, srcDate = "2026-07-13", srcSlot = "dinner")
        assertEquals(days.size * slots.size - 1, targets.size)
        assertFalse(targets.any { it.date == "2026-07-13" && it.mealType == "dinner" })
    }

    /** The list is ordered by day then slot, so it reads like the week does. */
    @Test
    fun `targets read in day then slot order`() {
        val targets = MoveTargets.of(entries, days, slots, srcDate = "2026-07-15", srcSlot = "dinner")
        assertEquals(
            listOf(
                "2026-07-13|breakfast", "2026-07-13|dinner",
                "2026-07-14|breakfast", "2026-07-14|dinner",
                "2026-07-15|breakfast",
            ),
            targets.map { "${it.date}|${it.mealType}" },
        )
    }

    /**
     * An occupied target names its occupant, so the user knows the move is a SWAP before
     * committing to it rather than after.
     */
    @Test
    fun `an occupied target names what it holds`() {
        val targets = MoveTargets.of(entries, days, slots, srcDate = "2026-07-13", srcSlot = "dinner")
        val occupied = targets.first { it.date == "2026-07-14" && it.mealType == "dinner" }
        assertEquals("Curry", occupied.occupantTitle)
        assertTrue(occupied.isSwap)

        val empty = targets.first { it.date == "2026-07-15" && it.mealType == "dinner" }
        assertNull(empty.occupantTitle)
        assertFalse(empty.isSwap)
    }
}
