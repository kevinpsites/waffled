package app.waffled.feature.lists

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/ListGroupingTests.swift`, suite for suite.
 *
 * "By meal" grouping with unscheduled recipes and Meal Builder plates, the per-item
 * provenance dots, and the section grouping whose "Items" fallback must NOT be a real
 * category.
 */
class MealGroupingUnscheduledTest {

    @Test
    fun `an unscheduled recipe gets its own section`() {
        val items = listOf(
            item("i1", "Tomatoes", listOf("r1")),
            item("i2", "Avocados", listOf("r2")),
            item("i3", "Cookies"),
        )
        val groups = MealGrouping.sections(
            items = items,
            meals = listOf(meal("r1", "Pasta")),
            unscheduled = listOf(offPlan("r2", "Guacamole")),
        )
        assertEquals(3, groups.size)
        assertEquals("r1", groups[0].meal?.recipeId)
        assertEquals(listOf("Tomatoes"), groups[0].items.map { it.name })
        assertEquals("r2", groups[1].unscheduled?.recipeId)
        assertEquals("Guacamole", groups[1].unscheduled?.title)
        assertEquals(listOf("Avocados"), groups[1].items.map { it.name })
        assertNull(groups[2].meal)
        assertNull(groups[2].unscheduled)
        assertEquals(listOf("Cookies"), groups[2].items.map { it.name })
    }

    @Test
    fun `a planned meal claims shared items first`() {
        // An item two recipes need shows once, under the planned meal.
        val groups = MealGrouping.sections(
            items = listOf(item("i1", "Limes", listOf("r1", "r2"))),
            meals = listOf(meal("r1", "Tacos")),
            unscheduled = listOf(offPlan("r2", "Margaritas")),
        )
        assertEquals(1, groups.size)
        assertEquals("r1", groups[0].meal?.recipeId)
    }

    @Test
    fun `no unscheduled recipes behaves as before`() {
        val groups = MealGrouping.sections(
            items = listOf(item("i1", "Tomatoes", listOf("r1")), item("i2", "Cookies")),
            meals = listOf(meal("r1", "Pasta")),
        )
        assertEquals(2, groups.size)
        assertNull(groups[1].meal)
    }

    @Test
    fun `an empty unscheduled group is dropped`() {
        // No active item references the off-plan recipe, so no empty section.
        val groups = MealGrouping.sections(
            items = listOf(item("i1", "Cookies")),
            meals = emptyList(),
            unscheduled = listOf(offPlan("r9", "Ghost Recipe")),
        )
        assertEquals(1, groups.size)
        assertNull(groups[0].meal)
        assertNull(groups[0].unscheduled)
    }
}

class MealGroupingPlateTest {

    @Test
    fun `a plate groups its dishes' items under one heading`() {
        val items = listOf(
            item("i1", "Chicken thighs", listOf("d1")),
            item("i2", "Mayonnaise", listOf("d2")),
            item("i3", "Cookies"),
        )
        val groups = MealGrouping.sections(
            items = items,
            meals = listOf(platedMeal("m1", "BBQ Sunday", listOf("d1", "d2"))),
        )
        assertEquals(2, groups.size)
        assertEquals("m1", groups[0].meal?.mealId)
        // One heading for the whole plate — both dishes' shopping under it.
        assertEquals(listOf("Chicken thighs", "Mayonnaise"), groups[0].items.map { it.name })
        assertNull(groups[1].meal)
    }

    @Test
    fun `an unscheduled plate gets its own section`() {
        val groups = MealGrouping.sections(
            items = listOf(item("i1", "Carnitas", listOf("d9")), item("i2", "Cookies")),
            meals = emptyList(),
            unscheduledMeals = listOf(offPlanMeal("m2", "Taco Tuesday", listOf("d9"))),
        )
        assertEquals(2, groups.size)
        assertEquals("Taco Tuesday", groups[0].unscheduledMeal?.name)
        assertEquals(listOf("Carnitas"), groups[0].items.map { it.name })
    }

    /**
     * Every item a plate wants was already claimed by an earlier meal. Dropping the
     * section makes an added plate look un-added, so it keeps its heading rather than
     * duplicating rows — one item, one checkbox.
     */
    @Test
    fun `a fully overlapped plate keeps its heading`() {
        val groups = MealGrouping.sections(
            items = listOf(item("i1", "Limes", listOf("r1", "d1"))),
            meals = listOf(
                meal("r1", "Tacos"),
                platedMeal("m1", "BBQ Sunday", listOf("d1"), date = "2026-07-14"),
            ),
        )
        assertEquals(2, groups.size)
        assertEquals("r1", groups[0].meal?.recipeId)
        assertEquals(1, groups[0].items.size)
        val plate = groups[1]
        assertEquals("m1", plate.meal?.mealId)
        assertTrue(plate.items.isEmpty()) // its shopping is above, not duplicated here
        assertTrue(plate.isFullyCovered)
    }

    /**
     * A plain recipe section with nothing in it is still dropped — only a plate earns an
     * empty heading, because only a plate can be explicitly "added".
     */
    @Test
    fun `an empty recipe section is still dropped`() {
        val groups = MealGrouping.sections(
            items = listOf(item("i1", "Cookies")),
            meals = listOf(meal("r9", "Ghost")),
        )
        assertEquals(1, groups.size)
        assertNull(groups[0].meal)
    }
}

/**
 * The per-item provenance dots. One dot per *source* — a plate is ONE source however many
 * of its dishes want the item, which is why this can't just dedupe by recipe id.
 */
class MealDotsTest {

    @Test
    fun `a plate gets one dot however many of its dishes want the item`() {
        val colors = MealDots.colors(
            item = item("i1", "Mayonnaise", listOf("d1", "d2")),
            meals = listOf(platedMeal("m1", "BBQ Sunday", listOf("d1", "d2"))),
            unscheduledMeals = emptyList(),
            unscheduled = emptyList(),
        )
        assertEquals(listOf("#2F7FED"), colors)
    }

    @Test
    fun `a recipe planned twice is still one dot`() {
        val colors = MealDots.colors(
            item = item("i1", "Limes", listOf("r1")),
            meals = listOf(meal("r1", "Tacos", "2026-07-13"), meal("r1", "Tacos again", "2026-07-15")),
            unscheduledMeals = emptyList(),
            unscheduled = emptyList(),
        )
        assertEquals(1, colors.size)
    }

    @Test
    fun `a plate and an unrelated recipe are two dots`() {
        val colors = MealDots.colors(
            item = item("i1", "Limes", listOf("d1", "r1")),
            meals = listOf(platedMeal("m1", "BBQ Sunday", listOf("d1")), meal("r1", "Tacos", "2026-07-15")),
            unscheduledMeals = emptyList(),
            unscheduled = emptyList(),
        )
        assertEquals(2, colors.size)
    }

    @Test
    fun `an off-plan plate gets its dot too`() {
        val colors = MealDots.colors(
            item = item("i1", "Carnitas", listOf("d9")),
            meals = emptyList(),
            unscheduledMeals = listOf(offPlanMeal("m2", "Taco Tuesday", listOf("d9"))),
            unscheduled = emptyList(),
        )
        assertEquals(listOf("#8B5CF6"), colors)
    }

    @Test
    fun `an item nobody claims has no dots`() {
        val colors = MealDots.colors(
            item = item("i1", "Cookies"),
            meals = listOf(meal("r1", "Tacos")),
            unscheduledMeals = emptyList(),
            unscheduled = emptyList(),
        )
        assertTrue(colors.isEmpty())
    }
}

/**
 * Section grouping: the "Items" fallback header must NOT be a real category. A move into
 * it writes `sectionValue` (null), not the display "Items" — otherwise the moved item
 * splits off a second "ITEMS" group, the bug the drag-and-drop first shipped.
 */
class ListSectionGroupingTest {

    @Test
    fun `the ungrouped fallback shows an Items header but a null category`() {
        val groups = ListGrouping.sections(
            listOf(
                sectioned("a", "Rain jacket", "Clothes"),
                sectioned("b", "Trash bags", null),
                sectioned("c", "Beach towel", null),
            ),
        )
        val ungrouped = groups.last()
        assertEquals("Items", ungrouped.title) // display header
        assertNull(ungrouped.sectionValue) // real category — the fix
        assertEquals(2, ungrouped.items.size)
    }

    @Test
    fun `a real section keeps its value and does not collide with the ungrouped one`() {
        // A user-named "Items" section AND uncategorised items: distinct groups, distinct ids.
        val groups = ListGrouping.sections(
            listOf(sectioned("a", "Boxed", "Items"), sectioned("b", "Loose", null)),
        )
        assertEquals(groups.size, groups.map { it.id }.toSet().size) // no id collision
        val real = groups.firstOrNull { it.sectionValue == "Items" }
        assertEquals("Items", real?.title)
        val fallback = groups.firstOrNull { it.sectionValue == null }
        assertNotNull(fallback)
        assertEquals("Items", fallback.title)
        assertEquals(ListSectionGroup.UNGROUPED_ID, fallback.id)
    }

    @Test
    fun `everything ungrouped is a single header-less group`() {
        val groups = ListGrouping.sections(
            listOf(sectioned("a", "One", null), sectioned("b", "Two", null)),
        )
        assertEquals(1, groups.size)
        assertNull(groups[0].title)
        assertNull(groups[0].sectionValue)
    }

    @Test
    fun `nothing at all groups to nothing`() {
        assertTrue(ListGrouping.sections(emptyList()).isEmpty())
    }

    /**
     * Preferred sections lead in the given order (grocery aisles in shopping order) and
     * everything else follows alphabetically, case-insensitively — the ordering must not
     * depend on the order the items arrived in.
     */
    @Test
    fun `preferred sections lead and the rest follow alphabetically`() {
        val groups = ListGrouping.sections(
            listOf(
                sectioned("a", "Ice cream", "Frozen"),
                sectioned("b", "Batteries", "hardware"),
                sectioned("c", "Kale", "Produce"),
                sectioned("d", "Sunscreen", "Beach"),
                sectioned("e", "String", null),
            ),
            preferredOrder = listOf("Produce", "Pantry", "Frozen"),
        )
        assertEquals(listOf("Produce", "Frozen", "Beach", "hardware", "Items"), groups.map { it.title })
    }

    /** Item order inside a section is preserved — grouping never reorders a section. */
    @Test
    fun `item order within a section is preserved`() {
        val groups = ListGrouping.sections(
            listOf(
                sectioned("a", "Zucchini", "Produce"),
                sectioned("b", "Apples", "Produce"),
            ),
        )
        assertEquals(listOf("Zucchini", "Apples"), groups[0].items.map { it.name })
    }
}
