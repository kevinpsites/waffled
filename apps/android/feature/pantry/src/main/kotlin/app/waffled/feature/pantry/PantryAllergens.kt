package app.waffled.feature.pantry

import androidx.compose.ui.graphics.Color

/**
 * The allergen rules — the Kotlin twin of iOS `PantryAllergens.swift` and the web
 * `kiosk/components/Allergens.tsx`.
 *
 * `milk` is Open Food Facts' tag for all dairy; it is surfaced as "Dairy" (badge D).
 */
object PantryAllergen {

    /**
     * A single allergen's identity badge.
     *
     * ⚠️ These are **literal colours on purpose** and must not be "fixed" into `WF.*`
     * tokens. This is one of the two documented exceptions in `core/design/Theme.kt`: an
     * identity palette that has to stay mutually distinguishable in both light and dark.
     * Nine allergens sitting side by side are told apart by hue, and theme-adaptive
     * tokens would collapse them into each other. The web, iOS and Android all draw the
     * same nine hues; changing one here silently desyncs three platforms.
     *
     * Everything *around* the badge is still tokenised — the avoided-item ring is
     * `WF.colors.danger`, the legend text is `WF.colors.ink2`.
     */
    data class Badge(val short: String, val bg: Color, val fg: Color)

    private fun hex(value: Long) = Color(0xFF000000L or value)

    // The nine identity hues. Mirrors iOS PantryAllergen.badges 1:1.
    val badges: Map<String, Badge> = mapOf(
        "gluten" to Badge("G", hex(0xE08A3C), Color.White),
        "milk" to Badge("D", hex(0x4F8FD6), Color.White),
        "soy" to Badge("S", hex(0x3FA45B), Color.White),
        "egg" to Badge("E", hex(0xF0CF52), hex(0x5A4A00)),
        "peanut" to Badge("P", hex(0xA9743B), Color.White),
        "tree_nut" to Badge("N", hex(0xC98A3A), Color.White),
        "fish" to Badge("F", hex(0x3FB0A6), Color.White),
        "shellfish" to Badge("C", hex(0xD96E92), Color.White),
        "sesame" to Badge("Se", hex(0xCBB079), hex(0x4A3B1A)),
    )

    val labels: Map<String, String> = mapOf(
        "gluten" to "Gluten",
        "milk" to "Dairy",
        "soy" to "Soy",
        "egg" to "Egg",
        "peanut" to "Peanut",
        "tree_nut" to "Tree nut",
        "fish" to "Fish",
        "shellfish" to "Shellfish",
        "sesame" to "Sesame",
    )

    /** Canonical order — matches the web legend. */
    val keys: List<String> = listOf(
        "gluten", "milk", "soy", "egg", "peanut", "tree_nut", "fish", "shellfish", "sesame",
    )

    fun label(key: String): String = labels[key] ?: humanise(key)

    /** An unknown tag still renders: a two-letter badge in neutral grey. */
    fun badge(key: String): Badge =
        badges[key] ?: Badge(key.take(2).uppercase(), hex(0x8A8A8A), Color.White)

    /**
     * The household's **effective** avoid-set: the declared avoid-list ∪ every allergen a
     * member actually has.
     *
     * It is a UNION, never an override. A household that never filled in an avoid-list
     * still has a kid with a peanut allergy, and a household that declared "no gluten"
     * still needs the per-person entries. Dropping either half means failing to warn
     * someone about a real allergy — which is why this has its own function with its own
     * tests rather than being spelled out at each call site.
     */
    fun avoidSet(
        householdAvoid: List<String>,
        allergenPeople: Map<String, List<String>>,
    ): Set<String> = householdAvoid.toSet() + allergenPeople.keys

    /** Which of [allergens] the household flags, keeping the item's own ordering. */
    fun flagged(allergens: List<String>, avoid: Set<String>): List<String> =
        allergens.filter { it in avoid }

    /** Who those allergens affect, by name, each listed once, sorted. */
    fun affected(allergens: List<String>, people: Map<String, List<String>>): List<String> =
        allergens.flatMap { people[it].orEmpty() }.distinct().sorted()

    internal fun humanise(key: String): String =
        key.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

/**
 * Dietary flags read out of the Open Food Facts ingredients analysis.
 *
 * Read-only — they arrive on the product snapshot and are never edited here. Mirrors the
 * web `DIETARY_LABELS`.
 */
object PantryDietary {

    val labels: Map<String, String> = mapOf(
        "vegan" to "Vegan",
        "vegetarian" to "Vegetarian",
        "palm_oil_free" to "Palm-oil-free",
    )

    /** Canonical order — matches the web. */
    val keys: List<String> = listOf("vegan", "vegetarian", "palm_oil_free")

    fun label(key: String): String = labels[key] ?: PantryAllergen.humanise(key)
}
