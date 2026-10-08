package app.waffled.feature.recipes

/**
 * The copy for the recipe screen's "N of M on hand — need X, Y" line — the Kotlin port of
 * `apps/ios/.../Features/Meals/OnHandBanner.swift`.
 *
 * Pulled out of the view so the rule it encodes is testable, because getting it wrong is
 * quiet: the banner previously counted `ingredients.isStaple`, which never touches the
 * pantry at all. A staple is something a household is assumed to keep around, not
 * something it currently has — so an empty pantry still reported "4 of 9 on hand". The
 * counts come from the server's real pantry matching.
 */
object OnHandBanner {

    data class Copy(
        /**
         * The bold "4 of 9". **null means make no on-hand claim at all** — render nothing,
         * not "0 of 9", which reads as "you have none of these" and is a different (and
         * equally untrue) statement.
         */
        val lead: String?,
        val tail: String,
        val showsAddButton: Boolean,
    )

    /**
     * @param onHand the server's real pantry match; null when the pantry module is off.
     * @param toBuy null only from a server predating these counts — distinct from 0, so
     *   "we weren't told" can't be mistaken for "nothing is needed".
     * @param toBuyNames what will actually land on the list. With the pantry ON this is
     *   the *unmatched* subset, which no client could derive from the ingredients.
     * @param nonStapleNames the old client-side split, used only for the legacy fallback.
     */
    fun copy(
        onHand: OnHandCount?,
        toBuy: Int?,
        toBuyNames: List<String>,
        nonStapleNames: List<String>,
    ): Copy {
        val missing = if (toBuy == null) nonStapleNames else toBuyNames
        val need = if (missing.isEmpty()) {
            ""
        } else {
            val shown = missing.take(3).joinToString(", ")
            val extra = if (missing.size > 3) " +${missing.size - 3} more" else ""
            "need $shown$extra"
        }

        if (onHand == null) {
            // No pantry answer — talk only about the shopping, never about having.
            return Copy(
                lead = null,
                tail = if (missing.isEmpty()) {
                    "Nothing to buy — it’s all pantry staples"
                } else {
                    need.replaceFirstChar { it.uppercase() }
                },
                showsAddButton = missing.isNotEmpty(),
            )
        }
        return Copy(
            lead = "${onHand.have} of ${onHand.total}",
            tail = if (missing.isEmpty()) " on hand — you’ve got everything" else " on hand — $need",
            showsAddButton = missing.isNotEmpty(),
        )
    }
}
