package app.waffled.feature.pantry

/**
 * Rules about pantry section names that both the picker and its test need.
 *
 * The server matches an existing section case-insensitively, so creating "garage shelf"
 * when the household already has "Garage shelf" is a no-op that returns the list
 * unchanged. The item list, though, buckets items by an **exact** string match — so
 * saving the typed casing files the item under a section nothing recognises, and it
 * lands in the "Other" catch-all with nothing to explain why.
 */
object PantrySections {

    /** The default sections offered before a household has configured its own. */
    val DEFAULTS: List<String> = listOf("Freezer", "Fridge", "Pantry")

    /** The bucket for an item whose location isn't a configured section. */
    const val OTHER: String = "Other"

    /**
     * The household's own spelling of [typed], if it has one; otherwise [typed] as given
     * (a genuinely new section, or a server that returned something unexpected).
     */
    fun canonical(typed: String, locations: List<String>): String =
        locations.firstOrNull { it.equals(typed, ignoreCase = true) } ?: typed
}
