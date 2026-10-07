package app.waffled.android.today

import app.waffled.feature.goals.GoalsApi
import kotlin.test.Test
import kotlin.test.assertEquals

/** Today's picker draws `TodayApi` shapes; the host maps the goals feature's own types in. */
class TodayGoalPickerMappingTest {

    @Test
    fun goalCarriesItsDisplayFieldsAndParticipantCount() {
        val g = GoalsApi.Goal(
            id = "g1",
            goalListId = "l1",
            title = "Read",
            emoji = "📚",
            category = "learning",
            goalType = "habit",
            unit = "books",
            habitPeriod = "week",
            habitTargetPerPeriod = 3,
            targetBasis = "per_person",
            isFeatured = true,
            isSpotlight = true,
            target = 20.0,
            totalProgress = 4.0,
            streakDays = 2,
            periodDone = 1.0,
            participants = listOf(GoalsApi.Participant("a"), GoalsApi.Participant("b")),
        )
        val t = TodayGoalPick.toToday(g)
        assertEquals("g1", t.id)
        assertEquals("l1", t.goalListId)
        assertEquals("Read", t.title)
        assertEquals("📚", t.emoji)
        assertEquals("habit", t.goalType)
        assertEquals(3, t.habitTargetPerPeriod)
        assertEquals(true, t.isFeatured)
        assertEquals(true, t.isSpotlight)
        assertEquals(20.0, t.target)
        assertEquals(4.0, t.totalProgress)
        assertEquals(1.0, t.periodDone)
        assertEquals("per_person", t.targetBasis)
        assertEquals(2, t.participantCount)
    }

    @Test
    fun listKeepsItsMembers() {
        val l = GoalsApi.GoalList(
            id = "l1",
            name = "Family",
            emoji = "🏡",
            goalCount = 3,
            members = listOf(GoalsApi.GoalList.Member("p1", "Jerry", "😀", "#fff")),
        )
        val t = TodayGoalPick.toToday(l)
        assertEquals("l1", t.id)
        assertEquals("Family", t.name)
        assertEquals(3, t.goalCount)
        assertEquals("p1", t.members.single().personId)
        assertEquals("Jerry", t.members.single().name)
    }
}
