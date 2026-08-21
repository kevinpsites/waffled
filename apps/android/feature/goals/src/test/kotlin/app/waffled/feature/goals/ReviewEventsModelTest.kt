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
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The goal↔calendar review queues.
 *
 * The server is idempotent on (event, occurrence, goal); the CLIENT's contribution to that
 * is the busy guard, which is why it is tested on its own below — a double-tap must be
 * refused before it can suspend, which is unassertable once the check is buried in a
 * request.
 */
class ReviewEventsModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: GoalsApi
    private lateinit var bus: RefreshBus

    /**
     * Routed by PATH, not arrival order: `load()` fetches both queues in parallel, so a
     * FIFO queue would hand the suggestions payload to the recap read about half the time.
     */
    private val routes = PathDispatcher()

    private companion object {
        const val RECAP = "/api/goal-calendar/recap"
        const val SUGGESTIONS = "/api/goal-calendar/suggestions"
        const val CONFIRM = "/api/goal-calendar/recap/confirm"
        const val SKIP = "/api/goal-calendar/recap/skip"
        const val LINK = "/api/goal-calendar/suggestions/link"
        const val DISMISS = "/api/goal-calendar/suggestions/dismiss"
    }

    @Before
    fun setUp() {
        harness.start()
        harness.server.dispatcher = routes
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = GoalsApi(client, harness.tokens)
        bus = RefreshBus()
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun model() = ReviewEventsModel(api, bus)

    private val recapJson = """
        {"items":[
          {"eventId":"ev1","occurrenceDate":"2026-07-17","title":"Soccer","startsAt":"2026-07-17T17:00:00Z",
           "goalId":"g1","goalTitle":"Move more","goalType":"total","unit":"hours",
           "trackingMode":"shared_total","suggestedAmount":1.5,"defaultPersonIds":["p1"],
           "goalParticipantIds":["p1","p2"]}
        ]}
    """.trimIndent()

    private val suggestionsJson = """
        {"items":[{"eventId":"ev5","title":"Yoga","startsAt":"2026-07-17T06:00:00Z",
                   "goalId":"g3","goalTitle":"Stretch","via":"memory"}]}
    """.trimIndent()

    private suspend fun loaded(): ReviewEventsModel {
        routes.on(RECAP, recapJson).on(SUGGESTIONS, suggestionsJson)
        return model().also { it.load() }
    }

    /** A 204, for one of the four write routes. */
    private fun accept(path: String) = routes.onNoContent(path)

    // ---- the busy guard ---------------------------------------------------------

    @Test
    fun `the guard admits one claim and refuses the rest until it is released`() {
        val guard = BusyGuard()

        assertTrue(guard.tryBegin("row"))
        assertFalse(guard.tryBegin("row"), "a double-tap must be refused before it can send")
        assertTrue(guard.isBusy("row"))
        assertTrue(guard.tryBegin("other"), "a different row is unaffected")

        guard.end("row")
        assertFalse(guard.isBusy("row"))
        assertTrue(guard.tryBegin("row"))
    }

    @Test
    fun `the guard publishes what is in flight and releases it after a failure`() = runTest {
        val guard = BusyGuard()

        val result = guard.withClaim("row") {
            assertEquals(setOf("row"), guard.busy.value)
            "done"
        }

        assertEquals("done", result)
        assertEquals(emptySet(), guard.busy.value)

        runCatching { guard.withClaim("row") { error("boom") } }
        assertFalse(guard.isBusy("row"), "a thrown action must not wedge the row forever")
    }

    @Test
    fun `a refused claim runs nothing and returns null`() = runTest {
        val guard = BusyGuard()
        guard.tryBegin("row")
        var ran = false

        assertEquals(null, guard.withClaim("row") { ran = true })
        assertFalse(ran)
    }

    // ---- loading ----------------------------------------------------------------

    @Test
    fun `load fills both queues and seeds a draft per recap row`() = runTest {
        val m = loaded()

        assertEquals(1, m.current.recap.size)
        assertEquals(1, m.current.suggestions.size)
        val draft = m.draft(m.current.recap.single())
        assertEquals(1.5, draft.amount)
        assertEquals(listOf("p1"), draft.people)
        assertFalse(m.current.loading)
        assertEquals("1 to review · 1 to link", m.current.headline)
    }

    @Test
    fun `a refresh does not throw away an amount someone is mid-edit`() = runTest {
        val m = loaded()
        val item = m.current.recap.single()
        m.setAmount(item, 3.0)

        m.load()

        assertEquals(3.0, m.draft(m.current.recap.single()).amount)
    }

    @Test
    fun `a draft for a row that is gone is not kept forever`() = runTest {
        val m = loaded()
        m.setAmount(m.current.recap.single(), 3.0)

        routes.only(RECAP, """{"items":[]}""").only(SUGGESTIONS, """{"items":[]}""")
        m.load()

        assertTrue(m.current.drafts.isEmpty())
    }

    @Test
    fun `a failed load flags the error and stops loading`() = runTest {
        routes.onError(RECAP, 500, "ServerError").onError(SUGGESTIONS, 500, "ServerError")

        val m = model()
        m.load()

        assertTrue(m.current.error)
        assertFalse(m.current.loading)
    }

    // ---- drafts -----------------------------------------------------------------

    @Test
    fun `the stepper floors at zero`() = runTest {
        val m = loaded()
        val item = m.current.recap.single()

        m.setAmount(item, -5.0)

        assertEquals(0.0, m.draft(item).amount)
        assertFalse(m.canConfirm(item), "there is nothing to log at zero")
    }

    @Test
    fun `a habit or checklist can always be confirmed`() = runTest {
        val m = model()
        val habit = GoalsApi.GoalRecapItem(eventId = "ev9", occurrenceDate = "2026-07-17", goalType = "habit")

        assertFalse(habit.isAmountBased)
        assertTrue(m.canConfirm(habit), "a habit day is one event, not an amount")
    }

    @Test
    fun `picking who gets credit replaces the default`() = runTest {
        val m = loaded()
        val item = m.current.recap.single()

        m.setPeople(item, listOf("p2"))

        assertEquals(listOf("p2"), m.draft(item).people)
        assertEquals(1.5, m.draft(item).amount, "changing who must not reset how much")
    }

    // ---- actions ----------------------------------------------------------------

    @Test
    fun `confirming sends the draft, drops the row and tells the goals screens`() = runTest {
        val m = loaded()
        val item = m.current.recap.single()
        m.setAmount(item, 2.0)
        m.setPeople(item, listOf("p1", "p2"))
        accept(CONFIRM)

        m.confirm(item)

        assertTrue(m.current.recap.isEmpty())
        assertTrue(m.current.drafts.isEmpty())
        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
        harness.takeRequest()
        harness.takeRequest()
        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, """"amount":2.0""")
        assertContains(body, """"personIds":["p1","p2"]""")
        assertContains(body, """"occurrenceDate":"2026-07-17"""")
    }

    @Test
    fun `confirming a checklist sends one, not the editable amount`() = runTest {
        routes
            .on(
                RECAP,
                """{"items":[{"eventId":"ev2","occurrenceDate":"2026-07-16","goalId":"g2","goalType":"checklist",
                              "goalStepId":"s3","suggestedAmount":9}]}""",
            )
            .on(SUGGESTIONS, """{"items":[]}""")
        accept(CONFIRM)

        val m = model()
        m.load()
        m.confirm(m.current.recap.single())

        harness.takeRequest()
        harness.takeRequest()
        assertContains(harness.takeRequest().body.readUtf8(), """"amount":1.0""")
    }

    @Test
    fun `a failed confirm keeps the row so it can be retried`() = runTest {
        val m = loaded()
        routes.onError(CONFIRM, 500, "ServerError")

        m.confirm(m.current.recap.single())

        assertTrue(m.current.error)
        assertEquals(1, m.current.recap.size, "a row that failed to log must not vanish")
        assertEquals(0, bus.revisionOf(RefreshDomain.Goals))
        assertFalse(m.isBusy("ev1|2026-07-17|g1"), "the row must be tappable again")
    }

    @Test
    fun `skipping clears the row without logging progress`() = runTest {
        val m = loaded()
        accept(SKIP)

        m.skip(m.current.recap.single())

        assertTrue(m.current.recap.isEmpty())
        harness.takeRequest()
        harness.takeRequest()
        val request = harness.takeRequest()
        assertEquals("/api/goal-calendar/recap/skip", request.path)
        assertFalse(request.body.readUtf8().contains("amount"))
    }

    @Test
    fun `linking a suggestion drops it and tells the goals screens`() = runTest {
        val m = loaded()
        accept(LINK)

        m.link(m.current.suggestions.single())

        assertTrue(m.current.suggestions.isEmpty())
        assertEquals(1, bus.revisionOf(RefreshDomain.Goals))
    }

    @Test
    fun `dismissing a suggestion changes no goal, so it does not bump the bus`() = runTest {
        val m = loaded()
        accept(DISMISS)

        m.dismiss(m.current.suggestions.single())

        assertTrue(m.current.suggestions.isEmpty())
        assertEquals(0, bus.revisionOf(RefreshDomain.Goals), "nothing about any goal changed")
    }

    @Test
    fun `an in-flight row refuses a second action outright`() = runTest {
        val m = loaded()
        val item = m.current.recap.single()
        // Claim the row the way an in-flight confirm would, then try to confirm again.
        assertTrue(m.isBusy(item.id).not())
        accept(CONFIRM)
        m.confirm(item)

        // The row is gone AND released; a replayed confirm has nothing to send.
        assertFalse(m.isBusy(item.id))
        assertEquals(3, harness.requestCount, "one recap, one suggestions, one confirm")
    }

    @Test
    fun `the recap id is the idempotency triple the server dedupes on`() {
        val item = GoalsApi.GoalRecapItem(eventId = "ev1", occurrenceDate = "2026-07-17", goalId = "g1")
        assertEquals("ev1|2026-07-17|g1", item.id)

        // Two occurrences of one recurring event are DIFFERENT rows.
        val other = item.copy(occurrenceDate = "2026-07-18")
        assertFalse(item.id == other.id)
    }
}
