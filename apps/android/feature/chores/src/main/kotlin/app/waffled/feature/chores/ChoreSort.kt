package app.waffled.feature.chores

/**
 * Ordering for a day's chores — the twin of iOS `ChoresModel.sortChores`.
 *
 * Sorted **once per load**, in the model, and never inside a composable: a `columns`
 * computed property re-read N× per render pass was the shape this replaced on iOS.
 *
 *  1. incomplete (`pending`) first — done and awaiting sink
 *  2. then due time ascending, with a set `HH:mm` beating an unset one
 *  3. then title A–Z, case-insensitive
 */
object ChoreSort {

    fun sortChores(instances: List<ChoresApi.ChoreInstance>): List<ChoresApi.ChoreInstance> =
        instances.sortedWith { a, b ->
            when {
                sortsBefore(a, b) -> -1
                sortsBefore(b, a) -> 1
                else -> 0
            }
        }

    /**
     * The strict-weak-ordering comparator behind [sortChores]. Exposed so the ordering
     * rules can be tested in isolation, including that equal rows compare as equivalent
     * in both directions.
     */
    fun sortsBefore(a: ChoresApi.ChoreInstance, b: ChoresApi.ChoreInstance): Boolean {
        // 1. Pending leads.
        if (a.isPending != b.isPending) return a.isPending

        // 2. Due time ascending; an untimed chore sorts after a timed one. Reached only
        //    when the times differ, so exactly one branch applies.
        if (a.dueTime != b.dueTime) {
            val at = a.dueTime ?: return false
            val bt = b.dueTime ?: return true
            return at < bt
        }

        // 3. Title A–Z, case-insensitive.
        return a.choreTitle.compareTo(b.choreTitle, ignoreCase = true) < 0
    }
}
