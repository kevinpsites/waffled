package app.waffled.feature.meals

import app.waffled.core.model.RecipeRef

/**
 * Merging a draft's answer into the review, and the by-hand edits on top of it.
 *
 * Extracted from the plan sheets so it can be tested: it exists to REPAIR a weak model —
 * one that echoes a dish already in the avoid list (so a swap would visibly change
 * nothing) or skips a night it was asked for — and that repair is invisible in the UI
 * until it fails.
 */
object PlanDraft {

    /** What a merge produced, plus whether anything actually moved. */
    data class Result(
        val suggestions: List<PlanCardDTO>,
        /**
         * True when at least one re-drafted night ended up with a different dish. False
         * means the user tapped Swap and nothing changed, so the sheet should point them
         * at Pick instead of silently doing nothing.
         */
        val changed: Boolean,
    )

    /** Normalise a title for de-duping — mirrors the server's matcher. */
    fun normTitle(s: String): String = s.lowercase().filter { it.isLetterOrDigit() }

    /**
     * The review's new card list after drafting [dates].
     *
     * [prior] is the review as it stands; nights outside [dates] are kept verbatim. A
     * drafted card is taken when its title is fresh — not on a kept night, not in
     * [avoid], not already used earlier in this same merge. Otherwise the night is filled
     * from [pool], the household's own library. When even that is exhausted the model's
     * answer is kept anyway: a repeated dinner is recoverable, a missing card is not.
     */
    fun resolve(
        dates: List<String>,
        drafted: List<PlanCardDTO>,
        prior: List<PlanCardDTO>,
        avoid: List<String>,
        pool: List<RecipeRef>,
        mealType: String,
        servings: Int,
    ): Result {
        if (dates.isEmpty()) return Result(prior, changed = false)

        val redrafting = dates.toSet()
        val kept = prior.filterNot { it.date in redrafting }
        val byDate = drafted.filter { it.date in redrafting }.associateBy { it.date }

        // Off-limits: dishes on nights we're keeping, plus everything avoided.
        val used = HashSet<String>()
        kept.forEach { used.add(normTitle(it.title)) }
        avoid.forEach { used.add(normTitle(it)) }

        val resolved = ArrayList<PlanCardDTO>(dates.size)
        for (date in dates.sorted()) {
            val m = byDate[date]
            val pick = when {
                m != null && normTitle(m.title) !in used -> m
                else -> fallback(date, used, pool, mealType, servings) ?: m
            } ?: continue
            used.add(normTitle(pick.title))
            resolved.add(pick)
        }

        val priorByDate = prior.associateBy { it.date }
        val changed = resolved.any { new ->
            priorByDate[new.date]?.let { normTitle(it.title) != normTitle(new.title) } ?: true
        }
        return Result((kept + resolved).sortedBy { it.date }, changed)
    }

    /** A library recipe whose title isn't already used this draft, as a card. */
    private fun fallback(
        date: String,
        used: Set<String>,
        pool: List<RecipeRef>,
        mealType: String,
        servings: Int,
    ): PlanCardDTO? {
        val r = pool.firstOrNull { normTitle(it.title) !in used } ?: return null
        return PlanCardDTO(
            date = date, mealType = mealType, title = r.title, recipeId = r.id,
            emoji = r.emoji, servings = servings, note = "From your library",
        )
    }

    /**
     * Exchange the meals on two review nights, keeping each card's own date.
     *
     * Returns null for a no-op — the same night twice, a night with no card, or either
     * end locked. A locked night is one the user said not to touch, so it may not be
     * moved FROM or moved ONTO.
     */
    fun swapCards(
        suggestions: List<PlanCardDTO>,
        srcDate: String,
        tgtDate: String,
        locked: Set<String>,
    ): List<PlanCardDTO>? {
        if (srcDate == tgtDate) return null
        if (srcDate in locked || tgtDate in locked) return null
        val a = suggestions.firstOrNull { it.date == srcDate } ?: return null
        val b = suggestions.firstOrNull { it.date == tgtDate } ?: return null
        return suggestions.map { c ->
            when (c.date) {
                // Everything about the MEAL travels; date and mealType belong to the night.
                srcDate -> b.copy(date = a.date, mealType = a.mealType)
                tgtDate -> a.copy(date = b.date, mealType = b.mealType)
                else -> c
            }
        }
    }
}

/**
 * Where a planned meal may be moved to.
 *
 * The planner offers an explicit "Move to…" list rather than a drag. iOS uses a custom
 * non-text UTI so a TextField can't intercept the drop; Compose has no equivalent
 * payload-typing trick and its drag-and-drop modifiers are still experimental, so a drag
 * here would be both fragile and worse to use one-handed. Which slots the list contains
 * is logic, not layout, so it lives here and is tested.
 */
object MoveTargets {

    /** One offered destination. */
    data class Target(
        val date: String,
        val mealType: String,
        /** What is already planned there, if anything — so a swap announces itself. */
        val occupantTitle: String?,
    ) {
        val isSwap: Boolean get() = occupantTitle != null
        val key: String get() = "$date|$mealType"
    }

    /**
     * Every visible slot except the one the meal is already in, in day-then-slot order so
     * the list reads the way the week does.
     */
    fun of(
        entries: List<WeekEntryDTO>,
        days: List<String>,
        slots: List<String>,
        srcDate: String,
        srcSlot: String,
    ): List<Target> {
        val occupied = entries.associateBy { "${it.date}|${it.mealType}" }
        return days.flatMap { date ->
            slots.mapNotNull { slot ->
                if (date == srcDate && slot == srcSlot) {
                    null
                } else {
                    Target(date, slot, occupied["$date|$slot"]?.displayTitle)
                }
            }
        }
    }
}
