package app.waffled.feature.goals

import app.waffled.core.model.Capability
import app.waffled.core.model.GoalCadence
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Goals tab's state machine, driven through the real API slice against MockWebServer.
 *
 * The tier and filter rules are the ones worth pinning: a goal that lands in two tiers, or
 * in none, is a goal the user cannot see.
 */
class GoalsModelTest {

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

    private fun model() = GoalsModel(api, bus)

    private fun goal(
        id: String,
        featured: Boolean = false,
        spotlight: Boolean? = null,
        trackingMode: String = "shared_total",
    ) = GoalsApi.Goal(id = id, isFeatured = featured, isSpotlight = spotlight, trackingMode = trackingMode)

    private fun stateWith(goals: List<GoalsApi.Goal>, members: Int = 3) = GoalsModel.State(
        lists = listOf(
            GoalsApi.GoalList(
                id = "l1",
                name = "Family",
                members = List(members) { GoalsApi.GoalList.Member(personId = "p$it", name = "P$it") },
            ),
        ),
        goals = goals,
        selectedListId = "l1",
    )

    // ---- tiers -----------------------------------------------------------------

    @Test
    fun everyGoalLandsInExactlyOneTier() {
        val goals = listOf(
            goal("hero", featured = true, spotlight = true),
            goal("pin", featured = true),
            goal("plain"),
        )
        val s = stateWith(goals)

        assertEquals("hero", s.spotlight?.id)
        assertEquals(listOf("pin"), s.pinned.map { it.id })
        assertEquals(listOf("plain"), s.more.map { it.id })

        val placed = listOfNotNull(s.spotlight?.id) + s.pinned.map { it.id } + s.more.map { it.id }
        assertEquals(goals.map { it.id }.sorted(), placed.sorted(), "no goal may be lost or shown twice")
    }

    @Test
    fun aSpotlightGoalIsNeverAlsoPinned() {
        // isFeatured is set on the spotlight too; the bands must not double-count it.
        val s = stateWith(listOf(goal("hero", featured = true, spotlight = true)))
        assertTrue(s.pinned.isEmpty())
        assertTrue(s.more.isEmpty())
    }

    @Test
    fun aListWithNoSpotlightJustHasBands() {
        val s = stateWith(listOf(goal("a"), goal("b", featured = true)))
        assertNull(s.spotlight)
        assertEquals(listOf("b"), s.pinned.map { it.id })
    }

    // ---- filter ----------------------------------------------------------------

    @Test
    fun theFilterSplitsSharedFromEach() {
        val goals = listOf(
            goal("shared", trackingMode = "shared_total"),
            goal("each", trackingMode = "each_tracks"),
        )
        val s = stateWith(goals)

        assertEquals(2, s.visibleGoals.size)
        assertEquals(listOf("shared"), s.copy(filter = GoalsModel.Filter.Shared).visibleGoals.map { it.id })
        assertEquals(listOf("each"), s.copy(filter = GoalsModel.Filter.Each).visibleGoals.map { it.id })
    }

    @Test
    fun aPersonalListIgnoresTheFilterEntirely() {
        // A one-person list has nothing to share, so a stale "Shared" pick must not hide
        // every goal they have.
        val s = stateWith(listOf(goal("each", trackingMode = "each_tracks")), members = 1)
            .copy(filter = GoalsModel.Filter.Shared)

        assertTrue(s.isIndividual)
        assertEquals(1, s.visibleGoals.size)
    }

    @Test
    fun theSelectedListFallsBackToTheFirstWhenTheChoiceIsGone() {
        val s = stateWith(listOf()).copy(selectedListId = "deleted")
        assertEquals("l1", s.selectedList?.id)
    }

    // ---- loading ---------------------------------------------------------------

    @Test
    fun `loadLists picks the first list and loads its goals`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"Family","goalCount":1,"members":[]}]}""")
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Outside"}]}""")

        val m = model()
        m.loadLists()

        assertEquals("l1", m.current.selectedListId)
        assertEquals(listOf("g1"), m.current.goals.map { it.id })
        assertFalse(m.current.loading)
        assertFalse(m.current.error)
        harness.takeRequest()
        assertEquals("/api/goals?listId=l1", harness.takeRequest().path)
    }

    @Test
    fun `a previously selected list survives a reload`() = runTest {
        harness.enqueueJson(
            """{"lists":[{"id":"l1","name":"Family","members":[]},{"id":"l2","name":"Kevin","members":[]}]}""",
        )
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueJson(
            """{"lists":[{"id":"l1","name":"Family","members":[]},{"id":"l2","name":"Kevin","members":[]}]}""",
        )
        harness.enqueueJson("""{"goals":[]}""")

        val m = model()
        m.loadLists()
        m.select("l2")
        m.loadLists()

        assertEquals("l2", m.current.selectedListId)
    }

    @Test
    fun `a deleted list drops back to the first`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"Family","members":[]},{"id":"l2","name":"Kevin","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"Family","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")

        val m = model()
        m.loadLists()
        m.select("l2")
        m.loadLists()

        assertEquals("l1", m.current.selectedListId)
    }

    @Test
    fun `switching lists resets a stale filter`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]},{"id":"l2","name":"B","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueJson("""{"goals":[]}""")

        val m = model()
        m.loadLists()
        m.setFilter(GoalsModel.Filter.Each)
        m.select("l2")

        assertEquals(GoalsModel.Filter.All, m.current.filter)
    }

    @Test
    fun `selecting the list already shown does not re-fetch`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")

        val m = model()
        m.loadLists()
        m.select("l1")

        assertEquals(2, harness.requestCount)
    }

    @Test
    fun `a failed goals fetch keeps the goals already on screen`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Outside"}]}""")
        harness.enqueueError(500, "ServerError")

        val m = model()
        m.loadLists()
        m.loadGoals()

        assertTrue(m.current.error)
        assertEquals(listOf("g1"), m.current.goals.map { it.id }, "a card must never blank on a flaky network")
    }

    @Test
    fun `a failed lists fetch stops loading rather than hanging`() = runTest {
        harness.enqueueError(500, "ServerError")

        val m = model()
        m.loadLists()

        assertTrue(m.current.error)
        assertFalse(m.current.loading, "a failed load must never sit on the spinner forever")
    }

    // ---- writes ----------------------------------------------------------------

    @Test
    fun `togglePin flips isFeatured, reloads and tells the other screens`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Outside","isFeatured":false}]}""")
        harness.enqueueNoContent()
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Outside","isFeatured":true}]}""")

        val m = model()
        m.loadLists()
        m.togglePin(m.current.goals.single())

        assertTrue(m.current.goals.single().isFeatured)
        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
        harness.takeRequest()
        harness.takeRequest()
        val patch = harness.takeRequest()
        assertEquals("PATCH", patch.method)
        assertContains(patch.body.readUtf8(), """"isFeatured":true""")
    }

    @Test
    fun `a failed write flags the error and does NOT bump the bus`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Outside"}]}""")
        harness.enqueueError(403, "Forbidden", "Nope")

        val m = model()
        m.loadLists()
        m.togglePin(m.current.goals.single())

        assertTrue(m.current.error)
        assertEquals(0, bus.revisionOf(RefreshDomain.Goals), "nothing changed, so nothing should re-fetch")
    }

    @Test
    fun `create reselects the new goal's list so it is actually visible`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueNoContent()
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]},{"id":"l2","name":"B","members":[]}]}""")
        harness.enqueueJson("""{"goals":[{"id":"g9","title":"New"}]}""")

        val m = model()
        m.loadLists()
        val ok = m.create(buildJsonObject { put("title", "New") }, listId = "l2")

        assertTrue(ok)
        assertEquals("l2", m.current.selectedListId)
        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
    }

    @Test
    fun `a failed create reports failure without moving the selection`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueError(400, "BadRequest", "Title required")

        val m = model()
        m.loadLists()

        assertFalse(m.create(buildJsonObject { put("title", "") }, listId = "l2"))
        assertEquals("l1", m.current.selectedListId)
    }

    // ---- staleness -------------------------------------------------------------

    @Test
    fun `a write from somewhere else marks the list stale`() = runTest {
        // The goal DETAIL screen owns a separate model, so logging progress or deleting a
        // goal there never touches this list. Without this, popping back showed stale
        // numbers — or a goal that no longer exists.
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")

        val m = model()
        m.loadLists()
        assertFalse(m.isStale())

        bus.bump(RefreshDomain.Goals)

        assertTrue(m.isStale())
    }

    @Test
    fun `this model's own write does not mark it stale`() = runTest {
        // It bumps the bus AND reloads, so a second fetch would be pure waste.
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Outside"}]}""")
        harness.enqueueNoContent()
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Outside","isFeatured":true}]}""")

        val m = model()
        m.loadLists()
        m.togglePin(m.current.goals.single())

        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
        assertFalse(m.isStale())
    }

    @Test
    fun `absorbing a change clears the staleness even when the re-fetch fails`() = runTest {
        // Re-firing on every recomposition would hammer an already-flaky server.
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"A","members":[]}]}""")
        harness.enqueueJson("""{"goals":[]}""")
        harness.enqueueError(500, "ServerError")

        val m = model()
        m.loadLists()
        bus.bump(RefreshDomain.Goals)
        m.loadGoals()

        assertTrue(m.current.error)
        assertFalse(m.isStale())
    }

    @Test
    fun `a model with no bus is never stale`() = runTest {
        harness.enqueueJson("""{"lists":[]}""")

        val m = GoalsModel(api, refreshBus = null)
        m.loadLists()

        assertFalse(m.isStale())
    }

    // ---- the detail model ------------------------------------------------------

    @Test
    fun `the detail load derives the series once and keeps the raw stats`() = runTest {
        // Routed by PATH: the detail, lists and activity reads fan out in parallel, so
        // arrival order is genuinely non-deterministic.
        harness.server.dispatcher = PathDispatcher()
            .on(
                "/api/goals/g1",
                """
                {"goal":{"id":"g1","title":"Outside","goalType":"total","unit":"hours","target":1000,
                  "createdAt":"2026-01-01T00:00:00Z","thisWeek":3,
                  "participants":[{"personId":"p1","name":"Kevin","colorHex":"#2F7FED","progress":8}]}}
                """.trimIndent(),
            )
            .on("/api/goal-lists", """{"lists":[{"id":"l1","name":"Family","members":[]}]}""")
            .on(
                "/api/goals/g1/activity",
                """
                {"startDate":"2026-01-01","endDate":null,"today":"2026-07-17",
                 "days":[{"dateKey":"2026-07-16","total":5,"perMember":{"p1":5}},
                         {"dateKey":"2026-07-17","total":3,"perMember":{"p1":3}}]}
                """.trimIndent(),
            )

        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)
        m.load()

        val s = m.current.series
        assertEquals(1000, s.target)
        assertEquals(GoalCadence.Total, s.cadence)
        assertEquals("hours", s.unit)
        assertEquals(mapOf("p1" to "#2F7FED"), s.personColors)
        assertEquals(LocalDate.of(2026, 1, 1), s.rangeStart)
        assertEquals(LocalDate.of(2026, 7, 17), s.rangeEnd)
        assertEquals(LocalDate.of(2026, 7, 17), s.today, "the household's today rides the seam")
        assertEquals(8.0, s.total, 0.0001)
        assertNull(s.byDay[LocalDate.of(2026, 7, 15)], "the absence rule survives the round trip")

        assertEquals(2, m.current.stats?.currentStreak)
        assertFalse(m.current.loading)
    }

    @Test
    fun `a failed lists read keeps the detail and its this-week total`() = runTest {
        // The lists only feed the editor's group picker. Dropping the detail with them left
        // the hero reading THIS WEEK 0 off the lightweight goal it was opened from.
        harness.server.dispatcher = PathDispatcher()
            .on("/api/goals/g1", """{"goal":{"id":"g1","title":"Outside","unit":"hours","thisWeek":4}}""")
            .onError("/api/goal-lists", 500, "ServerError")
            .on("/api/goals/g1/activity", """{"startDate":"2026-01-01","today":"2026-10-07","days":[]}""")

        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)
        m.load()

        assertEquals(4.0, m.current.detail?.thisWeek)
        assertFalse(m.current.error)
        assertTrue(m.current.lists.isEmpty())
    }

    @Test
    fun `the detail decodes the server's nulls for its numbers`() = runTest {
        harness.server.dispatcher = PathDispatcher()
            .on(
                "/api/goals/g1",
                """
                {"goal":{"id":"g1","title":"Outside","goalType":"habit","unit":null,"target":null,
                  "habitPeriod":"week","habitTargetPerPeriod":null,"streakDays":2,"thisWeek":2,
                  "periodDone":2,"stepTotal":null,"stepDone":null,"loggedTodayBy":null,
                  "healthDailyTarget":null,"weekPlans":[],"deadline":null,"category":null,
                  "participants":[{"personId":"p1","name":"Kevin","colorHex":null,"target":null,"progress":null}],
                  "milestones":[],"steps":[],
                  "recent":[{"id":"b1","amount":1,"loggedAt":"2026-10-06T19:00:00.000Z","dateKey":"2026-10-06",
                             "note":null,"editable":true,"participants":[{"personId":"p1","name":"Kevin","avatarEmoji":null,"colorHex":null}]}]}}
                """.trimIndent(),
            )
            .on("/api/goal-lists", """{"lists":[]}""")
            .on("/api/goals/g1/activity", """{"startDate":"2026-01-01","today":"2026-10-07","days":[]}""")

        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)
        m.load()

        assertEquals(2.0, m.current.detail?.thisWeek)
        assertFalse(m.current.error)
    }

    @Test
    fun `a failed activity read still shows the goal`() = runTest {
        // The ring, the ladder and the log are all worth showing; only the chart is lost.
        harness.server.dispatcher = PathDispatcher()
            .on("/api/goals/g1", """{"goal":{"id":"g1","title":"Outside","unit":"hours","target":100}}""")
            .on("/api/goal-lists", """{"lists":[]}""")
            .onError("/api/goals/g1/activity", 500, "ServerError")

        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)
        m.load()

        assertNotNull(m.current.detail)
        assertFalse(m.current.error)
        assertTrue(m.current.series.points.isEmpty())
        assertEquals("hours", m.current.series.unit)
        assertNull(m.current.stats)
    }

    @Test
    fun `the detail falls back to the goal it was handed before the read lands`() = runTest {
        val lightweight = GoalsApi.Goal(id = "g1", unit = "books", target = 20.0, totalProgress = 4.0)
        val m = GoalDetailModel(api, lightweight, bus)

        assertEquals("books", m.unit)
        assertEquals(20.0, m.target)
        assertEquals(4.0, m.progress)
    }

    @Test
    fun `deleting a goal tells the other screens and reports that the caller may pop`() = runTest {
        harness.enqueueNoContent()

        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)

        assertTrue(m.delete())
        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
    }

    @Test
    fun `a failed delete keeps the screen open`() = runTest {
        harness.enqueueError(403, "Forbidden", "Nope")

        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)

        assertFalse(m.delete())
        assertTrue(m.current.error)
    }

    @Test
    fun `a refused entry edit hands back the server's reason and keeps the screen error-free`() = runTest {
        harness.server.dispatcher = PathDispatcher().onError(
            "/api/goals/g1/logs/l1", 400, "BadRequest",
            "this entry is managed by its source",
        )
        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)

        val refusal = m.editEntry("l1", amount = 5.0, personIds = null, note = "x", loggedOn = "2026-08-31")

        assertNotNull(refusal)
        assertContains(refusal, "managed by its source")
        assertFalse(m.current.error, "the sheet shows the reason; the screen banner stays quiet")
        assertEquals(0, bus.revisionOf(RefreshDomain.Goals))
    }

    @Test
    fun `a saved entry edit returns no refusal and tells the other screens`() = runTest {
        harness.server.dispatcher = PathDispatcher()
            .onNoContent("/api/goals/g1/logs/l1")
            .on("/api/goals/g1", """{"goal":{"id":"g1","title":"Outside"}}""")
            .on("/api/goal-lists", """{"lists":[]}""")
            .on("/api/goals/g1/activity", """{"startDate":"2026-01-01","today":"2026-07-17","days":[]}""")
        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)

        assertNull(m.editEntry("l1", amount = null, personIds = null, note = "x", loggedOn = "2026-08-31"))
        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
    }

    @Test
    fun `a refused entry delete hands back the server's reason`() = runTest {
        harness.server.dispatcher = PathDispatcher().onError(
            "/api/goals/g1/logs/l1", 400, "BadRequest", "this entry is managed by its source",
        )
        val m = GoalDetailModel(api, GoalsApi.Goal(id = "g1"), bus)

        assertContains(m.deleteEntry("l1").orEmpty(), "managed by its source")
    }

    // ---- the capability gate ---------------------------------------------------

    @Test
    fun `goal manage gates editing but never logging`() {
        val kid = Person(id = "p1", name = "Kid")
        val granted = Person(id = "p2", name = "Teen", capabilities = listOf(Capability.GOAL_MANAGE))
        val admin = Person(id = "p3", name = "Parent", isAdmin = true)

        assertFalse(GoalsAccess.canManage(kid))
        assertTrue(GoalsAccess.canManage(granted))
        assertTrue(GoalsAccess.canManage(admin), "isAdmin implies every capability")
        assertFalse(GoalsAccess.canManage(null))

        // A goal exists to be logged against — that is never gated.
        assertTrue(GoalsAccess.canLog(kid))
        assertTrue(GoalsAccess.canLog(null))
    }

    @Test
    fun `an unrelated capability does not unlock goals`() {
        val chores = Person(id = "p1", name = "Teen", capabilities = listOf(Capability.CHORE_MANAGE))
        assertFalse(GoalsAccess.canManage(chores))
    }
}
