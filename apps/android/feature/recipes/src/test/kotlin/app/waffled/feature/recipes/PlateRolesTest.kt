package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Role grouping, the pantry-off render decision, and the footer stat — the Kotlin port of
 * the `PlateRoleGroupingTests`, `OnHandClaimTests` and `PlateStatsTests` suites in
 * `apps/ios/Tests/MealBuilderTests.swift`.
 */
class PlateRolesTest {

    /** Three scaffold groups in plate order — Main, Sides, Dessert. */
    @Test
    fun scaffoldsThreeRolesInPlateOrder() {
        assertEquals(listOf("main", "side", "dessert"), PlateRoles.ordered.map { it.key })
        assertEquals(listOf("Main", "Sides", "Dessert"), PlateRoles.ordered.map { it.label })
    }

    @Test
    fun groupsDishesByRoleAndSortsByPlateOrder() {
        val dishes = listOf(
            plateDish("d", "Peach Cobbler", role = "dessert", sortOrder = 3),
            plateDish("c", "Coleslaw", role = "side", sortOrder = 2),
            plateDish("a", "BBQ Chicken", role = "main", sortOrder = 0),
            plateDish("b", "Potato Salad", role = "side", sortOrder = 1),
        )
        assertEquals(listOf("a"), PlateRoles.dishes(dishes, PlateRoles.main).map { it.recipeId })
        assertEquals(listOf("b", "c"), PlateRoles.dishes(dishes, PlateRoles.side).map { it.recipeId })
        assertEquals(listOf("d"), PlateRoles.dishes(dishes, PlateRoles.dessert).map { it.recipeId })
    }

    /**
     * `role` is free text, not an enum, so a role the builder doesn't scaffold ('bread')
     * must still land somewhere. Sides is the catch-all — the alternative is a dish that
     * is on the plate but rendered nowhere.
     */
    @Test
    fun anUnknownRoleFallsIntoSides() {
        val dishes = listOf(plateDish("x", "Garlic Bread", role = "bread"))
        assertEquals(listOf("x"), PlateRoles.dishes(dishes, PlateRoles.side).map { it.recipeId })
        assertTrue(PlateRoles.dishes(dishes, PlateRoles.main).isEmpty())
        assertTrue(PlateRoles.dishes(dishes, PlateRoles.dessert).isEmpty())
    }

    /**
     * An empty group still renders — its "＋ Add a main" slot is the ONLY way to add a
     * main, so hiding empty sections (the mobile instinct) removes the affordance.
     */
    @Test
    fun everyRoleGroupIsShownEvenWhenEmpty() {
        val groups = PlateRoles.groups(listOf(plateDish("a", "BBQ Chicken", role = "main")))
        assertEquals(3, groups.size)
        assertEquals(listOf("main", "side", "dessert"), groups.map { it.role.key })
        assertTrue(groups[1].dishes.isEmpty())
        assertEquals("Add a side", groups[1].role.addLabel)
    }

    @Test
    fun labelsAnUnknownRoleAsASide() {
        assertEquals("Main", PlateRoles.label("main"))
        assertEquals("Sides", PlateRoles.label("bread"))
    }

    // ---- the pantry-off render decision ----------------------------------------

    /** Pantry ON, nothing left to buy → the one case that may claim "all on hand". */
    @Test
    fun pantryOnAndNothingToBuyClaimsAllOnHand() {
        assertEquals(OnHandClaim.AllOnHand, OnHandClaim.of(OnHandCount(5, 5), toBuy = 0))
    }

    /**
     * Pantry OFF and nothing to buy → say NOTHING. `onHand == null` means "we can't say",
     * so neither "✓ all on hand" nor a "0 of N" badge is honest here. This is the branch
     * that gets missed.
     */
    @Test
    fun pantryOffAndNothingToBuySaysNothing() {
        assertEquals(OnHandClaim.NothingToSay, OnHandClaim.of(null, toBuy = 0))
    }

    /** "N to buy" is not pantry-derived, so it works either way. */
    @Test
    fun toBuyWorksWithOrWithoutThePantry() {
        assertEquals(OnHandClaim.ToBuy(6), OnHandClaim.of(null, toBuy = 6))
        assertEquals(OnHandClaim.ToBuy(2), OnHandClaim.of(OnHandCount(3, 5), toBuy = 2))
    }

    // ---- footer stats ----------------------------------------------------------

    @Test
    fun formatsHandsOnTime() {
        assertEquals("—", MealBuilderModel.hoursMinutes(null))
        assertEquals("—", MealBuilderModel.hoursMinutes(0))
        assertEquals("45m", MealBuilderModel.hoursMinutes(45))
        assertEquals("1h", MealBuilderModel.hoursMinutes(60))
        assertEquals("1h 15m", MealBuilderModel.hoursMinutes(75))
    }
}
