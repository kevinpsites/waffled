package app.waffled.feature.today

/**
 * Grouping for the Today goal picker — ported from `TodayGoalPickerSheet.groups`.
 *
 * Goals are bucketed by their list, and the buckets ranked so the ones you care about
 * come first: your own personal list, then shared groups you're in, then everyone else's,
 * then goals with no list at all. Ties break on the list name, case-insensitively.
 */
object TodayGoalGrouping {

    /** Bucket key for goals that belong to no list. */
    const val NO_LIST = "__none__"

    data class Group(
        val id: String,
        val title: String,
        val members: List<TodayApi.GoalListMember>,
        val goals: List<TodayApi.Goal>,
    )

    fun group(
        goals: List<TodayApi.Goal>,
        lists: List<TodayApi.GoalList>,
        myPersonId: String?,
    ): List<Group> {
        val byId = lists.associateBy { it.id }

        fun rank(key: String): Int {
            // No list, or a list the server didn't return (deleted, or not yet loaded).
            val list = byId[key]?.takeIf { key != NO_LIST } ?: return 3
            val ids = list.members.map { it.personId }.toSet()
            if (myPersonId != null && ids == setOf(myPersonId)) return 0 // my personal list
            if (myPersonId != null && ids.size > 1 && myPersonId in ids) return 1 // a group I'm in
            return 2 // someone else's / other
        }

        val buckets = goals.groupBy { it.goalListId ?: NO_LIST }

        return buckets.keys
            .sortedWith(
                compareBy({ rank(it) }, { (byId[it]?.name ?: "Other").lowercase() }),
            )
            .map { key ->
                val list = byId[key]
                Group(
                    id = key,
                    title = when {
                        key == NO_LIST -> "Other goals"
                        rank(key) == 0 -> "My goals"
                        else -> list?.name ?: "Goals"
                    },
                    members = list?.members.orEmpty(),
                    goals = buckets[key].orEmpty(),
                )
            }
    }
}
