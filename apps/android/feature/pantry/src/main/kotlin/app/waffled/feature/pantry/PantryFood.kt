package app.waffled.feature.pantry

/**
 * A rough name → emoji map, the fallback whenever an item has no product photo.
 *
 * Mirrors the web `foodEmoji`, and covers the NON-food a pantry holds too (personal
 * care, cleaning, paper goods, pet food) so a scanned bar of soap without a photo
 * doesn't fall back to a food can. Anything unrecognised is a box.
 *
 * ⚠️ The rule list is **order-dependent** and two of the orderings are bug fixes:
 * paper goods come before bread (so "kitchen roll" isn't caught by "roll"), and bare
 * "ham" is deliberately absent (as a substring it false-matches "shampoo" and "graham" —
 * the web has that bug, we don't; bacon/pork/sausage still cover cured pork).
 * `PantryFoodTest` locks both.
 */
object PantryFood {

    private val rules: List<Pair<List<String>, String>> = listOf(
        listOf("pork", "bacon", "sausage") to "🥓",
        listOf("chicken", "turkey", "poultry") to "🍗",
        listOf("beef", "steak", "burger") to "🥩",
        listOf("salmon", "fish", "tuna", "cod", "shrimp") to "🐟",
        listOf("broccoli", "lettuce", "spinach", "kale", "greens", "veg") to "🥦",
        listOf("tomato") to "🍅",
        listOf("carrot") to "🥕",
        listOf("pepper") to "🫑",
        listOf("apple") to "🍎",
        listOf("banana") to "🍌",
        listOf("berry", "berries") to "🫐",
        listOf("milk") to "🥛",
        listOf("yogurt", "yoghurt") to "🥛",
        listOf("cheese") to "🧀",
        listOf("butter") to "🧈",
        listOf("egg") to "🥚",
        // Paper goods BEFORE bread, so "kitchen roll" isn't caught by "roll" → 🍞.
        listOf("toilet", "tissue", "paper towel", "kitchen roll", "napkin") to "🧻",
        listOf("bread", "bun", "roll") to "🍞",
        listOf("rice") to "🍚",
        listOf("pasta", "noodle", "spaghetti") to "🍝",
        listOf("pie", "pizza") to "🥧",
        listOf("ice cream", "frozen") to "🍨",
        listOf("juice", "soda", "drink") to "🧃",
        listOf("water") to "💧",
        listOf("cereal") to "🥣",
        listOf("soup", "broth", "stock") to "🍲",
        // Non-food: personal care, cleaning, pet.
        listOf(
            "laundry", "detergent", "fabric soften", "dish soap", "dishwash",
            "cleaner", "bleach", "surface spray",
        ) to "🧼",
        listOf(
            "shampoo", "conditioner", "lotion", "moisturi", "body wash",
            "sunscreen", "hand soap",
        ) to "🧴",
        listOf("toothpaste", "toothbrush", "floss") to "🪥",
        listOf("deodorant", "razor", "shav") to "🪒",
        listOf("diaper", "wipe") to "🧷",
        listOf("trash bag", "garbage bag") to "🗑️",
        listOf("battery", "batteries") to "🔋",
        listOf("dog", "cat", "pet food", "kibble") to "🐾",
        listOf("foil", "wrap", "ziploc", "sandwich bag", "storage bag") to "📦",
    )

    const val FALLBACK: String = "📦"

    fun emoji(name: String): String {
        val n = name.lowercase()
        for ((needles, glyph) in rules) {
            if (needles.any { n.contains(it) }) return glyph
        }
        return FALLBACK
    }
}
