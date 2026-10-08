package app.waffled.feature.today

import app.waffled.core.network.WaffledJson
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The Today goal picker reads a goal on its TYPE's axis — the subset of iOS
 * `GoalDisplayTests` (f5a841ef) the picker uses. A "5× a week" habit logged once last week
 * and once this week reads "1 of 5", never a lifetime "2 of 5".
 */
class TodayGoalDisplayTest {

    private fun goal(json: String): TodayApi.Goal =
        WaffledJson.decodeFromString(TodayApi.Goal.serializer(), json)

    @Test
    fun aHabitShowsThisPeriodAgainstItsCadence() {
        val g = goal(
            """{"id":"g","title":"Run","goalType":"habit","habitPeriod":"week",
               "habitTargetPerPeriod":5,"periodDone":1,"totalProgress":2,"target":100}""",
        )
        assertEquals(0.2, g.fraction, 1e-9)
        assertEquals("1 of 5 this week", goalDescriptor(g))
    }

    /** An older payload without periodDone must read 0, never the lifetime total. */
    @Test
    fun aHabitWithoutPeriodDoneReadsZero() {
        val g = goal("""{"id":"g","title":"Run","goalType":"habit","habitTargetPerPeriod":5,"totalProgress":7}""")
        assertEquals(0.0, g.fraction)
    }

    @Test
    fun aChecklistShowsStepsDone() {
        val g = goal("""{"id":"g","title":"Move","goalType":"checklist","stepTotal":4,"stepDone":2}""")
        assertEquals(0.5, g.fraction, 1e-9)
        assertEquals("2 of 4 steps", goalDescriptor(g))
        assertEquals(0.0, goal("""{"id":"g","title":"Empty","goalType":"checklist"}""").fraction)
    }

    @Test
    fun aPerPersonTargetGrowsWithTheParticipants() {
        val g = goal(
            """{"id":"g","title":"Books","target":12,"totalProgress":24,"targetBasis":"per_person",
               "participants":[{"personId":"a"},{"personId":"b"},{"personId":"c"},{"personId":"d"}]}""",
        )
        assertEquals(0.5, g.fraction, 1e-9)
    }

    @Test
    fun aTotalGoalIsUnchanged() {
        val g = goal("""{"id":"g","title":"Bike","target":100,"totalProgress":40,"unit":"mi"}""")
        assertEquals(0.4, g.fraction, 1e-9)
        assertEquals("40 of 100 mi", goalDescriptor(g))
    }

    @Test
    fun aGoalBuiltByTheHostCountsItsParticipantsWithoutTheirJson() {
        // The host maps the goals feature's goal into this one for the picker; it has the
        // participants as its own type, so it hands over just the count.
        val g = TodayApi.Goal(
            id = "g",
            title = "Books",
            target = 12.0,
            totalProgress = 24.0,
            targetBasis = "per_person",
            participantCount = 4,
        )
        assertEquals(0.5, g.fraction, 1e-9)
        assertEquals("24 of 48", goalDescriptor(g))
    }
}
