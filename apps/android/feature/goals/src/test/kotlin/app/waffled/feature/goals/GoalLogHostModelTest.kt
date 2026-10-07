package app.waffled.feature.goals

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The self-contained log host Today opens from its hero's Log button (iOS `GoalHeroCard`
 * logs in place rather than opening the goal). It is handed only an id, so it loads the
 * goal's detail itself and hands the sheet the same goal the detail screen would.
 */
class GoalLogHostModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: GoalsApi
    private lateinit var bus: RefreshBus

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = GoalsApi(client, harness.tokens)
        bus = RefreshBus()
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private val detail = """
        {"goal":{"id":"g1","title":"Read","goalType":"habit","unit":"days","habitPeriod":"week",
          "habitTargetPerPeriod":5,"participantMode":"split","trackingMode":"each_tracks",
          "periodDone":2,"loggedTodayBy":["p1"],
          "participants":[{"personId":"p1","name":"Kevin","progress":2},{"personId":"p2","name":"Ana","progress":1}]}}
    """.trimIndent()

    @Test
    fun `loading builds the sheet's goal from the detail`() = runTest {
        harness.server.dispatcher = PathDispatcher()
            .on("/api/goals/g1", detail)
            .on("/api/goals/g1/note-suggestions", """{"suggestions":["Before bed"]}""")
            .on("/api/goals/g1/activity", """{"startDate":"2026-01-01","today":"2026-10-06","days":[]}""")

        val m = GoalLogHostModel(api, "g1", bus)
        m.load(meId = "p1")

        val g = assertNotNull(m.current.goal)
        assertEquals("Read", g.title)
        assertEquals("habit", g.goalType)
        assertEquals("split", g.participantMode)
        assertEquals("each_tracks", g.trackingMode)
        assertEquals(5, g.habitTargetPerPeriod)
        assertEquals(2.0, g.periodDone)
        assertEquals(listOf("p1"), g.loggedTodayBy)
        assertEquals(listOf("p1", "p2"), g.participants.map { it.personId })
        assertEquals(listOf("Before bed"), m.current.noteSuggestions)
        assertEquals(LocalDate.of(2026, 10, 6), m.current.today, "the household's today, not the device's")
        assertFalse(m.current.error)
    }

    @Test
    fun `a failed detail read is an error, not an empty sheet`() = runTest {
        harness.server.dispatcher = PathDispatcher().onError("/api/goals/g1", 500)

        val m = GoalLogHostModel(api, "g1", bus)
        m.load(meId = null)

        assertTrue(m.current.error)
        assertEquals(null, m.current.goal)
    }

    @Test
    fun `saving posts the log and tells the other screens`() = runTest {
        harness.server.dispatcher = PathDispatcher()
            .on("/api/goals/g1", detail)
            .on("/api/goals/g1/note-suggestions", """{"suggestions":[]}""")
            .on("/api/goals/g1/activity", """{"startDate":"2026-01-01","today":"2026-10-06","days":[]}""")
            .onNoContent("/api/goals/g1/log")

        val m = GoalLogHostModel(api, "g1", bus)
        m.load(meId = null)
        val ok = m.save(amount = 1.0, hours = null, minutes = null, personIds = listOf("p1"), note = "", loggedOn = null)

        assertTrue(ok)
        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
        val paths = generateSequence { harness.server.takeRequest(0, java.util.concurrent.TimeUnit.SECONDS) }
            .map { it.path.orEmpty() }.toList()
        assertContains(paths, "/api/goals/g1/log")
    }

    @Test
    fun `a refused save keeps the sheet open and changes nothing`() = runTest {
        harness.server.dispatcher = PathDispatcher()
            .on("/api/goals/g1", detail)
            .on("/api/goals/g1/note-suggestions", """{"suggestions":[]}""")
            .on("/api/goals/g1/activity", """{"startDate":"2026-01-01","today":"2026-10-06","days":[]}""")
            .onError("/api/goals/g1/log", 400, "BadRequest", "amount must be a number")

        val m = GoalLogHostModel(api, "g1", bus)
        m.load(meId = null)
        val ok = m.save(amount = 1.0, hours = null, minutes = null, personIds = emptyList(), note = "", loggedOn = null)

        assertFalse(ok)
        assertTrue(m.current.error)
        assertEquals(0, bus.revisionOf(RefreshDomain.Goals))
    }
}
