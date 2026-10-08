package app.waffled.feature.today

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The Today goal picker's grouping — ported from `TodayGoalPickerSheet.groups`.
 *
 * Goals are bucketed by their list and the buckets ranked: my own personal list first,
 * then shared groups I'm in, then everyone else's, then goals with no list at all.
 * Ties break on the list name, case-insensitively.
 */
class TodayGoalGroupingTest {

    private fun list(id: String, name: String, vararg members: String) = TodayApi.GoalList(
        id = id, name = name,
        members = members.map { TodayApi.GoalListMember(personId = it, name = it) },
    )

    private fun goal(id: String, listId: String?) =
        TodayApi.Goal(id = id, title = id, goalListId = listId)

    private val me = "me"

    @Test
    fun ranksMyListThenSharedThenOthersThenUnlisted() {
        val lists = listOf(
            list("mine", "Kevin", me),
            list("shared", "Household", me, "june"),
            list("theirs", "June", "june"),
        )
        val goals = listOf(
            goal("g-unlisted", null),
            goal("g-theirs", "theirs"),
            goal("g-shared", "shared"),
            goal("g-mine", "mine"),
        )
        val groups = TodayGoalGrouping.group(goals, lists, me)
        assertEquals(listOf("mine", "shared", "theirs", TodayGoalGrouping.NO_LIST), groups.map { it.id })
        assertEquals(
            listOf("My goals", "Household", "June", "Other goals"),
            groups.map { it.title },
        )
        assertEquals(listOf("g-mine"), groups.first().goals.map { it.id })
    }

    /** Same rank → alphabetical by list name, ignoring case. */
    @Test
    fun tiesBreakOnNameCaseInsensitively() {
        val lists = listOf(list("a", "zebra", "x"), list("b", "Apple", "y"))
        val groups = TodayGoalGrouping.group(listOf(goal("g1", "a"), goal("g2", "b")), lists, me)
        assertEquals(listOf("Apple", "zebra"), groups.map { it.title })
    }

    /** A goal whose list wasn't returned (deleted, or not yet loaded) ranks with "other". */
    @Test
    fun anUnknownListRanksLast() {
        val groups = TodayGoalGrouping.group(listOf(goal("g1", "ghost"), goal("g2", "mine")),
            listOf(list("mine", "Kevin", me)), me)
        assertEquals(listOf("mine", "ghost"), groups.map { it.id })
        assertEquals("Goals", groups.last().title)
    }

    /** Signed out / not yet identified: nothing can be "mine", so nothing ranks first. */
    @Test
    fun withNoViewerNothingIsMine() {
        val lists = listOf(list("mine", "Kevin", me), list("shared", "Household", me, "june"))
        val groups = TodayGoalGrouping.group(listOf(goal("g1", "mine"), goal("g2", "shared")), lists, null)
        assertEquals(listOf("Household", "Kevin"), groups.map { it.title })
    }

    @Test
    fun emptyGoalsProduceNoGroups() {
        assertEquals(emptyList(), TodayGoalGrouping.group(emptyList(), emptyList(), me))
    }

    /** A list with only me on it is "my goals" even when it is named something else. */
    @Test
    fun aSoloListIsRenamedMyGoals() {
        val groups = TodayGoalGrouping.group(listOf(goal("g1", "solo")), listOf(list("solo", "Fitness", me)), me)
        assertEquals("My goals", groups.single().title)
    }
}
