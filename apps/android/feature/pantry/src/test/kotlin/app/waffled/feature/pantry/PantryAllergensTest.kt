package app.waffled.feature.pantry

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The allergen rules — the Kotlin twin of the iOS `PantryAllergen` helpers.
 *
 * The **union** is the case that matters most in this file. The effective avoid-set is
 * the household's declared avoid-list ∪ every allergen a member has, and getting it
 * wrong is not a cosmetic bug: implementing it as an override (or forgetting the
 * per-person half) means the app silently fails to warn someone about a real allergy.
 */
class PantryAllergensTest {

    // ---- the effective avoid-set: household ∪ per-person -------------------------

    @Test
    fun `household avoid-list alone flags its allergens`() {
        val avoid = PantryAllergen.avoidSet(
            householdAvoid = listOf("gluten"),
            allergenPeople = emptyMap(),
        )
        assertEquals(setOf("gluten"), avoid)
    }

    @Test
    fun `a per-person allergen flags even when the household list is empty`() {
        // The override bug lives here: a household that never filled in an avoid-list
        // still has a kid with a peanut allergy, and that MUST flag.
        val avoid = PantryAllergen.avoidSet(
            householdAvoid = emptyList(),
            allergenPeople = mapOf("peanut" to listOf("Jerry")),
        )
        assertEquals(setOf("peanut"), avoid)
    }

    @Test
    fun `the set is a union, not an override — both halves survive`() {
        val avoid = PantryAllergen.avoidSet(
            householdAvoid = listOf("gluten", "sesame"),
            allergenPeople = mapOf("peanut" to listOf("Jerry"), "milk" to listOf("Elaine")),
        )
        assertEquals(setOf("gluten", "sesame", "peanut", "milk"), avoid)
    }

    @Test
    fun `an allergen in both halves appears once`() {
        val avoid = PantryAllergen.avoidSet(
            householdAvoid = listOf("milk"),
            allergenPeople = mapOf("milk" to listOf("Elaine")),
        )
        assertEquals(setOf("milk"), avoid)
    }

    @Test
    fun `neither half means nothing is flagged`() {
        assertTrue(PantryAllergen.avoidSet(emptyList(), emptyMap()).isEmpty())
    }

    // ---- flagged / affected -------------------------------------------------------

    @Test
    fun `flagged keeps only the allergens the household avoids, in item order`() {
        val flagged = PantryAllergen.flagged(
            allergens = listOf("milk", "soy", "peanut"),
            avoid = setOf("peanut", "milk"),
        )
        assertEquals(listOf("milk", "peanut"), flagged)
    }

    @Test
    fun `affected names each person once and sorts them`() {
        val people = mapOf(
            "milk" to listOf("Elaine", "Jerry"),
            "peanut" to listOf("Jerry"),
        )
        assertEquals(
            listOf("Elaine", "Jerry"),
            PantryAllergen.affected(listOf("milk", "peanut"), people),
        )
    }

    @Test
    fun `affected is empty when nobody is listed for the flagged allergen`() {
        assertTrue(PantryAllergen.affected(listOf("sesame"), mapOf("milk" to listOf("Jerry"))).isEmpty())
    }

    // ---- labels + badges ----------------------------------------------------------

    @Test
    fun `milk is surfaced as Dairy — OFF tags all dairy as milk`() {
        assertEquals("Dairy", PantryAllergen.label("milk"))
        assertEquals("D", PantryAllergen.badge("milk").short)
    }

    @Test
    fun `the nine canonical keys are in the web legend's order`() {
        assertEquals(
            listOf("gluten", "milk", "soy", "egg", "peanut", "tree_nut", "fish", "shellfish", "sesame"),
            PantryAllergen.keys,
        )
    }

    @Test
    fun `an unknown allergen still renders — two-letter badge, humanised label`() {
        assertEquals("MU", PantryAllergen.badge("mustard").short)
        assertEquals("Mustard", PantryAllergen.label("mustard"))
    }

    @Test
    fun `every canonical key has a badge and a label`() {
        for (key in PantryAllergen.keys) {
            assertTrue(PantryAllergen.badges.containsKey(key), "no badge for $key")
            assertTrue(PantryAllergen.labels.containsKey(key), "no label for $key")
        }
    }

    // ---- dietary flags ------------------------------------------------------------

    @Test
    fun `dietary labels match the web DIETARY_LABELS`() {
        assertEquals("Vegan", PantryDietary.label("vegan"))
        assertEquals("Vegetarian", PantryDietary.label("vegetarian"))
        assertEquals("Palm-oil-free", PantryDietary.label("palm_oil_free"))
    }

    @Test
    fun `an unknown dietary key is humanised rather than dropped`() {
        assertEquals("Gluten free", PantryDietary.label("gluten_free"))
    }
}
