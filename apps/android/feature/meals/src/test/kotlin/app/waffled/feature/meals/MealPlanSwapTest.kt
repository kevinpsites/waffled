package app.waffled.feature.meals

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Optimistic drag/move for the weekly meal planner — the port of
 * `apps/ios/Tests/MealPlanSwapTests.swift`.
 *
 * Moving the meal at (srcDate, srcSlot) onto (dstDate, dstSlot) must return the
 * post-swap entries *immediately* (the view shows them before the server round-trip):
 * the source entry moves to the target slot, whatever occupied the target moves back to
 * the source slot, every other entry is untouched, and a move onto itself or from an
 * empty slot is a no-op the caller can ignore.
 */
private fun entry(
    date: String,
    slot: String,
    title: String,
    recipeId: String? = null,
    cookName: String? = null,
) = WeekEntryDTO(
    id = "id-$date-$slot",
    date = date,
    mealType = slot,
    title = if (recipeId == null) title else null,
    recipeId = recipeId,
    recipe = if (recipeId == null) {
        null
    } else {
        WeekRecipeInfo(
            title = title, emoji = "🍜", category = "dinner",
            prepTimeMinutes = 10, cookTimeMinutes = 25, servings = 4, imageUrl = null,
        )
    },
    cook = cookName?.let { WeekCookDTO(personId = "p-$it", name = it) },
)

/**
 * A slot holding a Meal Builder plate rather than a single recipe — `recipeId` is null
 * and the dishes hang off `meal`.
 */
private fun plateEntry(
    date: String,
    slot: String,
    name: String,
    mealId: String,
    dishes: List<String> = listOf("r1", "r2"),
) = WeekEntryDTO(
    id = "id-$date-$slot",
    date = date,
    mealType = slot,
    title = name,
    recipeId = null,
    mealId = mealId,
    meal = WeekMealSlot(
        id = mealId, name = name, servings = 6,
        recipes = dishes.mapIndexed { i, r ->
            WeekMealDish(
                recipeId = r, title = "Dish $r", emoji = null,
                role = if (i == 0) "main" else "side", sortOrder = i,
            )
        },
    ),
    recipe = null,
    cook = null,
)

private fun List<WeekEntryDTO>.at(date: String, slot: String): WeekEntryDTO? =
    firstOrNull { it.date == date && it.mealType == slot }

/** MealPlanSwap.apply — the optimistic week-planner move. */
class MealPlanSwapApplyTest {

    @Test
    fun `moving onto an empty slot relocates the entry and empties the source`() {
        val week = listOf(
            entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"),
            entry("2026-07-14", "lunch", "Leftovers"),
        )
        val out = MealPlanSwap.apply(week, "2026-07-13", "dinner", "2026-07-15", "dinner")
        assertNotNull(out)
        assertEquals("Tacos", out.at("2026-07-15", "dinner")?.displayTitle)
        assertNull(out.at("2026-07-13", "dinner"))
        // The unrelated lunch is untouched.
        assertEquals("Leftovers", out.at("2026-07-14", "lunch")?.displayTitle)
        assertEquals(2, out.size)
    }

    @Test
    fun `dropping onto an occupied slot swaps the two entries`() {
        val week = listOf(
            entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"),
            entry("2026-07-16", "dinner", "Curry", recipeId = "r2"),
        )
        val out = MealPlanSwap.apply(week, "2026-07-13", "dinner", "2026-07-16", "dinner")
        assertNotNull(out)
        assertEquals("Tacos", out.at("2026-07-16", "dinner")?.displayTitle)
        assertEquals("Curry", out.at("2026-07-13", "dinner")?.displayTitle)
        assertEquals(2, out.size)
    }

    /** A grid can swap across meal types — `mealType` moves with the slot. */
    @Test
    fun `swapping across meal types moves the mealType too`() {
        val week = listOf(
            entry("2026-07-13", "breakfast", "Pancakes", recipeId = "r1"),
            entry("2026-07-13", "dinner", "Curry", recipeId = "r2"),
        )
        val out = MealPlanSwap.apply(week, "2026-07-13", "breakfast", "2026-07-13", "dinner")
        assertNotNull(out)
        val movedDown = out.at("2026-07-13", "dinner")
        val movedUp = out.at("2026-07-13", "breakfast")
        assertEquals("Pancakes", movedDown?.displayTitle)
        assertEquals("dinner", movedDown?.mealType)
        assertEquals("Curry", movedUp?.displayTitle)
        assertEquals("breakfast", movedUp?.mealType)
    }

    @Test
    fun `a move onto the slot it came from is a no-op`() {
        val week = listOf(entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"))
        assertNull(MealPlanSwap.apply(week, "2026-07-13", "dinner", "2026-07-13", "dinner"))
    }

    @Test
    fun `moving from an empty slot is a no-op`() {
        val week = listOf(entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"))
        assertNull(MealPlanSwap.apply(week, "2026-07-14", "dinner", "2026-07-15", "dinner"))
    }

    @Test
    fun `the moved copy keeps its recipe, free-text title and cook`() {
        val week = listOf(
            entry("2026-07-13", "dinner", "Tacos", recipeId = "r1", cookName = "Jerry"),
            entry("2026-07-14", "dinner", "Grandma's soup"),
        )
        val out = MealPlanSwap.apply(week, "2026-07-13", "dinner", "2026-07-14", "dinner")
        assertNotNull(out)
        val moved = out.at("2026-07-14", "dinner")
        assertEquals("r1", moved?.recipeId)
        assertEquals("🍜", moved?.recipe?.emoji)
        assertEquals("Jerry", moved?.cook?.name)
        // The free-text meal that swapped back keeps its title (no recipe).
        val back = out.at("2026-07-13", "dinner")
        assertNull(back?.recipeId)
        assertEquals("Grandma's soup", back?.title)
    }
}

/**
 * A minimal server: slot → planned entry. Applying an Op mirrors what
 * `planMeal`/`clearMeal` do to the real rows.
 */
private class FakeMealServer(entries: List<WeekEntryDTO>) {
    private val slots = entries.associateBy { "${it.date}|${it.mealType}" }.toMutableMap()

    fun apply(op: MealPlanSwap.Op) {
        val key = "${op.date}|${op.mealType}"
        if (op.entry == null) slots.remove(key) else slots[key] = op.entry
    }

    fun meal(date: String, slot: String): WeekEntryDTO? = slots["$date|$slot"]

    /** Every distinct meal currently planned anywhere, by display title. */
    val titles: Set<String> get() = slots.values.map { it.displayTitle }.toSet()
}

/** MealPlanSwap.writes — the loss-safe server write order. */
class MealPlanSwapWritesTest {

    @Test
    fun `the dragged meal lands in the target slot first and the source is rewritten second`() {
        val week = listOf(
            entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"),
            entry("2026-07-16", "dinner", "Curry", recipeId = "r2"),
        )
        val plan = MealPlanSwap.writes(week, "2026-07-13", "dinner", "2026-07-16", "dinner")
        assertNotNull(plan)
        assertEquals(2, plan.ordered.size)
        // Write 0: upsert the dragged meal into the target — its own row untouched.
        assertEquals("2026-07-16", plan.ordered[0].date)
        assertEquals("dinner", plan.ordered[0].mealType)
        assertEquals("Tacos", plan.ordered[0].entry?.displayTitle)
        // Write 1: only now rewrite the source slot with the displaced meal.
        assertEquals("2026-07-13", plan.ordered[1].date)
        assertEquals("dinner", plan.ordered[1].mealType)
        assertEquals("Curry", plan.ordered[1].entry?.displayTitle)
    }

    @Test
    fun `a failure between the writes never loses a meal from the server`() {
        val week = listOf(
            entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"),
            entry("2026-07-16", "dinner", "Curry", recipeId = "r2"),
        )
        val plan = MealPlanSwap.writes(week, "2026-07-13", "dinner", "2026-07-16", "dinner")
        assertNotNull(plan)
        val server = FakeMealServer(week)
        server.apply(plan.ordered[0]) // write 1 lands…
        // …and the connection drops before write 2. The dragged meal must still exist
        // (worst case duplicated) — the old order left it in zero slots.
        assertTrue(server.titles.contains("Tacos"))
        assertEquals("Tacos", server.meal("2026-07-13", "dinner")?.displayTitle)
        // The compensating write restores the target slot, returning the server to its
        // exact pre-drag state.
        server.apply(plan.compensation)
        assertEquals("Tacos", server.meal("2026-07-13", "dinner")?.displayTitle)
        assertEquals("Curry", server.meal("2026-07-16", "dinner")?.displayTitle)
    }

    @Test
    fun `a failure on a move-to-empty degrades to a recoverable duplicate`() {
        val week = listOf(entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"))
        val plan = MealPlanSwap.writes(week, "2026-07-13", "dinner", "2026-07-15", "dinner")
        assertNotNull(plan)
        val server = FakeMealServer(week)
        server.apply(plan.ordered[0])
        // Write 2 fails: the meal is planned twice — recoverable — never zero times.
        assertEquals("Tacos", server.meal("2026-07-13", "dinner")?.displayTitle)
        assertEquals("Tacos", server.meal("2026-07-15", "dinner")?.displayTitle)
        // Compensation clears the duplicate (the target was empty pre-drag).
        server.apply(plan.compensation)
        assertNull(server.meal("2026-07-15", "dinner"))
        assertEquals("Tacos", server.meal("2026-07-13", "dinner")?.displayTitle)
    }

    @Test
    fun `no-op moves produce no write plan`() {
        val week = listOf(entry("2026-07-13", "dinner", "Tacos", recipeId = "r1"))
        assertNull(MealPlanSwap.writes(week, "2026-07-13", "dinner", "2026-07-13", "dinner"))
        assertNull(MealPlanSwap.writes(week, "2026-07-14", "dinner", "2026-07-15", "dinner"))
    }
}

/** MealPlanSwap.Gate — one in-flight discipline for every reload path. */
class MealPlanSwapGateTest {

    @Test
    fun `reloads run immediately when nothing is in flight`() {
        val g = MealPlanSwap.Gate()
        assertTrue(g.shouldReloadNow())
    }

    @Test
    fun `every reload trigger is deferred while a swap is in flight, then replayed once`() {
        val g = MealPlanSwap.Gate()
        g.begin()
        // A revision bump, week paging, pull-to-refresh — all deferred mid-flight.
        assertFalse(g.shouldReloadNow())
        assertFalse(g.shouldReloadNow())
        assertFalse(g.shouldReloadNow())
        // The settle replays exactly one reload, after reconcile/rollback finished.
        assertTrue(g.finish())
        assertTrue(g.shouldReloadNow())
    }

    @Test
    fun `a lone failed swap may roll its snapshot back itself`() {
        val g = MealPlanSwap.Gate()
        g.begin()
        assertTrue(g.mayApplyResult)
        assertFalse(g.finish()) // nothing deferred → nothing to replay
    }

    @Test
    fun `overlapping swaps never write entries themselves`() {
        val g = MealPlanSwap.Gate()
        g.begin() // swap A
        g.begin() // swap B overlaps
        // A finishes first: another optimistic swap is still displayed — writing A's
        // reconcile/rollback would clobber it.
        assertFalse(g.mayApplyResult)
        g.requestSettleReload()
        assertFalse(g.finish()) // B still in flight → no replay yet
        // B is sole now, but a reload is queued behind it — server truth wins.
        assertFalse(g.mayApplyResult)
        assertTrue(g.finish()) // last swap out replays exactly one reload
    }

    @Test
    fun `a deferred reload poisons self-apply even for a sole swap`() {
        val g = MealPlanSwap.Gate()
        g.begin()
        g.shouldReloadNow() // e.g. our own first write bumped the meals revision
        assertFalse(g.mayApplyResult) // half-committed state exists → fetch truth
        assertTrue(g.finish())
    }
}

/**
 * Moving a Meal Builder plate around the week. A plate-backed slot has NO `recipeId` —
 * the dishes hang off `meal` — so anything that rebuilds an entry while carrying only
 * `recipeId` quietly turns a four-dish plate into a bare title. That is a data loss the
 * user cannot undo from the planner, and it looks like the plate was "emptied" rather
 * than mis-moved.
 */
class MealPlanSwapPlateTest {

    @Test
    fun `a moved plate keeps its dishes`() {
        val week = listOf(plateEntry("2026-07-13", "dinner", "BBQ Sunday", "m1"))
        val out = MealPlanSwap.apply(week, "2026-07-13", "dinner", "2026-07-15", "dinner")
        assertNotNull(out)
        val moved = out.at("2026-07-15", "dinner")
        assertNotNull(moved)
        assertEquals("m1", moved.mealId)
        assertTrue(moved.isMealBacked)
        assertEquals(2, moved.dishCount)
        assertEquals("BBQ Sunday", moved.displayTitle)
        // …and the night it left is genuinely empty, not holding a husk.
        assertNull(out.at("2026-07-13", "dinner"))
    }

    @Test
    fun `swapping a plate with a recipe carries both links the right way`() {
        val week = listOf(
            plateEntry("2026-07-13", "dinner", "BBQ Sunday", "m1"),
            entry("2026-07-14", "dinner", "Tacos", recipeId = "r9"),
        )
        val out = MealPlanSwap.apply(week, "2026-07-13", "dinner", "2026-07-14", "dinner")
        assertNotNull(out)
        val plate = out.at("2026-07-14", "dinner")
        assertNotNull(plate)
        assertEquals("m1", plate.mealId)
        assertNull(plate.recipeId)
        assertEquals(2, plate.dishCount)

        val recipe = out.at("2026-07-13", "dinner")
        assertNotNull(recipe)
        assertEquals("r9", recipe.recipeId)
        // The displaced recipe must not inherit the plate it swapped with.
        assertNull(recipe.mealId)
        assertFalse(recipe.isMealBacked)
    }

    @Test
    fun `the write for a moved plate carries the plate, not a bare title`() {
        val week = listOf(plateEntry("2026-07-13", "dinner", "BBQ Sunday", "m1"))
        val w = MealPlanSwap.writes(week, "2026-07-13", "dinner", "2026-07-15", "dinner")
        assertNotNull(w)
        // ordered[0] upserts the dragged meal into the target slot — that write is what
        // reaches `POST /api/meals/plan`, so the plate id has to survive this far.
        val target = w.ordered.first().entry
        assertNotNull(target)
        assertEquals("m1", target.mealId)
        assertEquals(2, target.dishCount)
    }
}
