package app.waffled.feature.goals

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
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
 * The Kotlin port of `apps/ios/Tests/GoalSuggestionIgnoreTests.swift`, plus the wire.
 *
 * Review events → "Ignore events like this…": the words a person can pick come from the
 * server, so the client never re-implements the matcher's stopword filter.
 */
class GoalSuggestionIgnoreTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: GoalsApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = GoalsApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun decode(json: String) = WaffledJson.decodeFromString<GoalsApi.GoalSuggestionItem>(json)

    @Test
    fun decodesTheWordsOfferedForIgnoring() {
        val s = decode(
            """
            {"eventId":"e1","title":"🧊 Thaw for Dinner · Garlic Chicken","startsAt":"2026-09-14T15:00:00Z",
             "allDay":false,"goalId":"g1","goalTitle":"Host 30 families","goalEmoji":"🏡","via":"llm",
             "ignoreWords":["thaw","dinner","garlic","chicken"]}
            """.trimIndent(),
        )
        assertEquals(listOf("thaw", "dinner", "garlic", "chicken"), s.ignoreWords)
    }

    @Test
    fun anOlderServerWithoutIgnoreWordsStillDecodes() {
        val s = decode(
            """
            {"eventId":"e1","title":"Library trip","startsAt":"2026-09-14T15:00:00Z","allDay":false,
             "goalId":"g1","goalTitle":"Reading","goalEmoji":null,"via":"keyword"}
            """.trimIndent(),
        )
        assertTrue(s.ignoreWords.isEmpty())
    }

    @Test
    fun ignoringNeedsAtLeastOneWordPicked() {
        assertFalse(ReviewEventsModel.canIgnore(picked = emptyList()))
        assertTrue(ReviewEventsModel.canIgnore(picked = listOf("thaw")))
    }

    @Test
    fun `the ignored words list decodes for Settings`() = runTest {
        harness.enqueueJson(
            """{"groups":[{"goalId":"g1","goalTitle":"Host 30 families","goalEmoji":null,"words":["thaw","salmon"]}]}""",
        )

        val groups = api.goalSuggestionIgnores()

        assertEquals(listOf("Host 30 families"), groups.map { it.goalTitle })
        assertEquals(listOf("thaw", "salmon"), groups.first().words)
        assertEquals("g1", groups.first().id)
        assertEquals("/api/goal-calendar/ignores", harness.takeRequest().path)
    }

    @Test
    fun `ignoring sends the goal and the picked words`() = runTest {
        harness.enqueueNoContent()

        api.ignoreSuggestionWords(goalId = "g1", words = listOf("thaw", "dinner"))

        val req = harness.takeRequest()
        assertEquals("/api/goal-calendar/suggestions/ignore", req.path)
        assertEquals("POST", req.method)
        val body = req.body.readUtf8()
        assertContains(body, "\"goalId\":\"g1\"")
        assertContains(body, "\"words\":[\"thaw\",\"dinner\"]")
    }

    @Test
    fun `removing an ignored word sends that one word`() = runTest {
        harness.enqueueNoContent()

        api.removeGoalSuggestionIgnore(goalId = "g1", word = "thaw")

        val req = harness.takeRequest()
        assertEquals("/api/goal-calendar/ignores/remove", req.path)
        val body = req.body.readUtf8()
        assertContains(body, "\"goalId\":\"g1\"")
        assertContains(body, "\"word\":\"thaw\"")
    }

    @Test
    fun `ignoring from the review queue reloads it, since other events carrying the word drop out too`() = runTest {
        val routes = PathDispatcher()
            .onNoContent("/api/goal-calendar/suggestions/ignore")
            .on("/api/goal-calendar/suggestions", """{"items":[]}""")
        harness.server.dispatcher = routes
        val m = ReviewEventsModel(api, RefreshBus())
        val s = GoalsApi.GoalSuggestionItem(eventId = "e1", goalId = "g1", ignoreWords = listOf("thaw"))

        m.ignore(s, listOf("thaw"))

        assertTrue(m.current.suggestions.isEmpty())
        assertFalse(m.current.error)
    }

    @Test
    fun `ignoring with nothing picked sends nothing`() = runTest {
        val m = ReviewEventsModel(api, RefreshBus())
        m.ignore(GoalsApi.GoalSuggestionItem(eventId = "e1", goalId = "g1"), emptyList())
        assertEquals(0, harness.server.requestCount)
    }
}
