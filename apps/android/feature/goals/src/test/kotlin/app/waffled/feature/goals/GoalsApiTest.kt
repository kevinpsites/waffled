package app.waffled.feature.goals

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The goals API slice, driven against a real MockWebServer through [ApiTestHarness].
 *
 * Two families of assertion carry the weight:
 *
 *  - **What reaches the wire.** `WaffledJson` sets `explicitNulls = false`, so the
 *    difference between "clear this" and "leave it alone" is invisible unless a test
 *    reads the raw body. Clearing a note must send a null; the Apple Health keys must
 *    not be sent at all (see `GoalDraftTest`).
 *  - **What survives decoding.** Several fields are nullable purely so an older response
 *    still decodes (`isSpotlight`, `participantMode`), and one map deliberately carries
 *    zero-valued keys.
 */
class GoalsApiTest {

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

    // ---- lists -----------------------------------------------------------------

    @Test
    fun `goalLists unwraps the lists envelope`() = runTest {
        harness.enqueueJson(
            """
            {"lists":[
              {"id":"l1","name":"Family","emoji":"👨‍👩‍👧","colorHex":"#EC6049","goalCount":3,
               "members":[{"personId":"p1","name":"Kevin","avatarEmoji":"🧔","colorHex":"#2F7FED"}]},
              {"id":"l2","name":"Kevin","goalCount":0,"members":[]}
            ]}
            """.trimIndent(),
        )

        val lists = api.goalLists()

        assertEquals(2, lists.size)
        assertEquals("Family", lists[0].name)
        assertEquals(3, lists[0].goalCount)
        assertEquals("Kevin", lists[0].members.single().name)
        assertTrue(lists[1].members.isEmpty())
        assertEquals("/api/goal-lists", harness.takeRequest().path)
    }

    @Test
    fun `addGoalList sends an explicit null emoji and omits an empty member list`() = runTest {
        harness.enqueueJson("""{"list":{"id":"l9"}}""")

        val id = api.addGoalList(name = "Mom & Dad", emoji = null, memberIds = emptyList(), isPrivate = true)

        assertEquals("l9", id)
        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/goal-lists", request.path)
        val body = request.body.readUtf8()
        assertContains(body, """"emoji":null""")
        assertContains(body, """"isPrivate":true""")
        assertFalse(body.contains("memberIds"), "an empty member list is omitted, not sent as []")
    }

    @Test
    fun `addGoalList sends the picked members`() = runTest {
        harness.enqueueJson("""{"list":{"id":"l9"}}""")

        api.addGoalList(name = "Parents", emoji = "💑", memberIds = listOf("p1", "p2"), isPrivate = false)

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, """"emoji":"💑"""")
        assertContains(body, """"memberIds":["p1","p2"]""")
    }

    // ---- goals -----------------------------------------------------------------

    @Test
    fun `goalsIn scopes to a list and decodes the tier flags`() = runTest {
        harness.enqueueJson(
            """
            {"goals":[
              {"id":"g1","goalListId":"l1","title":"1,000 Hours Outside","emoji":"🌳",
               "category":"physical","goalType":"total","unit":"hours","trackingMode":"shared_total",
               "participantMode":"split","targetBasis":"family","isFeatured":true,"isSpotlight":true,
               "target":1000,"totalProgress":221.5,"milestoneTotal":3,"milestoneReached":1,
               "streakDays":4,"autoFromCalendar":true,"healthMetric":"steps","createdAt":"2026-01-01T00:00:00Z",
               "participants":[{"personId":"p1","name":"Kevin","progress":120.5,"target":500}]}
            ]}
            """.trimIndent(),
        )

        val goals = api.goalsIn("l1")

        val g = goals.single()
        assertEquals("1,000 Hours Outside", g.title)
        assertTrue(g.spotlight)
        assertFalse(g.countsOnce, "participantMode split must not read as count_once")
        assertEquals(221.5, g.totalProgress)
        assertEquals("steps", g.healthMetric)
        assertEquals(120.5, g.participants.single().progress)
        assertEquals("/api/goals?listId=l1", harness.takeRequest().path)
    }

    @Test
    fun `goalsIn with no list asks for every goal`() = runTest {
        harness.enqueueJson("""{"goals":[]}""")

        assertTrue(api.goalsIn(null).isEmpty())

        assertEquals("/api/goals", harness.takeRequest().path)
    }

    @Test
    fun `a list id with a space is url-encoded rather than breaking the request line`() = runTest {
        harness.enqueueJson("""{"goals":[]}""")

        api.goalsIn("list one")

        assertEquals("/api/goals?listId=list%20one", harness.takeRequest().path)
    }

    @Test
    fun `an older goal payload without the tier flags still decodes`() = runTest {
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"Old","goalType":"count"}]}""")

        val g = api.goalsIn(null).single()

        assertNull(g.isSpotlight)
        assertFalse(g.spotlight)
        assertNull(g.participantMode)
        assertTrue(g.countsOnce, "a missing participantMode defaults to count_once")
        assertTrue(g.participants.isEmpty())
    }

    @Test
    fun `goalDetail unwraps the goal envelope with its ladder and log`() = runTest {
        harness.enqueueJson(
            """
            {"goal":{"id":"g1","title":"Read 20 books","goalType":"count","unit":"books",
              "target":20,"trackingMode":"each_tracks","createdAt":"2026-01-01T00:00:00Z",
              "thisWeek":2,"hasRewards":true,"healthDailyTarget":2000,
              "milestones":[{"id":"m1","threshold":10,"emoji":"🌱","label":"10","rewardText":"","reached":true}],
              "steps":[{"id":"s1","label":"Pick a book","done":false}],
              "recent":[{"id":"e1","amount":1,"loggedAt":"2026-07-17T12:00:00Z","dateKey":"2026-07-17",
                         "note":"Dune","participants":[{"personId":"p1","name":"Kevin"}]}]}}
            """.trimIndent(),
        )

        val d = api.goalDetail("g1")

        assertEquals("Read 20 books", d.title)
        assertTrue(d.hasRewards)
        assertEquals(2000.0, d.healthDailyTarget)
        assertTrue(d.milestones.single().reached)
        assertEquals("Pick a book", d.steps.single().label)
        assertEquals("2026-07-17", d.recent.single().dateKey)
        assertEquals("Kevin", d.recent.single().participants.single().name)
        assertEquals("/api/goals/g1", harness.takeRequest().path)
    }

    @Test
    fun `goalActivity keeps a zero-valued member key`() = runTest {
        harness.enqueueJson(
            """
            {"startDate":"2026-01-01","endDate":null,"today":"2026-07-17",
             "days":[{"dateKey":"2026-07-17","total":1,"perMember":{"p1":1,"p2":0}}]}
            """.trimIndent(),
        )

        val a = api.goalActivity("g1")

        assertNull(a.endDate)
        assertEquals("2026-07-17", a.today)
        val day = a.days.single()
        assertEquals(2, day.perMember.size)
        assertEquals(0.0, day.perMember["p2"], "an attendee present but not credited must survive")
        assertEquals(listOf(DayEntry("2026-07-17", 1.0, mapOf("p1" to 1.0, "p2" to 0.0))), a.entries())
        assertEquals("/api/goals/g1/activity", harness.takeRequest().path)
    }

    @Test
    fun `noteSuggestions scopes to a person when one is given`() = runTest {
        harness.enqueueJson("""{"suggestions":["Creek hike","Park"]}""")

        assertEquals(listOf("Creek hike", "Park"), api.noteSuggestions("g1", "p 1"))

        assertEquals("/api/goals/g1/note-suggestions?personId=p%201", harness.takeRequest().path)
    }

    @Test
    fun `noteSuggestions drops a blank person scope`() = runTest {
        harness.enqueueJson("""{"suggestions":[]}""")

        api.noteSuggestions("g1", "  ")

        assertEquals("/api/goals/g1/note-suggestions", harness.takeRequest().path)
    }

    // ---- logging ---------------------------------------------------------------

    @Test
    fun `logProgress sends an amount and omits everything blank`() = runTest {
        harness.enqueueNoContent()

        api.logProgress(goalId = "g1", amount = 2.5, personIds = emptyList(), note = "  ", loggedOn = "")

        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/goals/g1/log", request.path)
        val body = request.body.readUtf8()
        assertContains(body, """"amount":2.5""")
        assertFalse(body.contains("personIds"))
        assertFalse(body.contains("note"))
        assertFalse(body.contains("loggedOn"))
        assertFalse(body.contains("hours"))
    }

    @Test
    fun `a time goal sends hours and minutes INSTEAD of an amount`() = runTest {
        // The server 400s if both arrive, so this really is exclusive — and it is what
        // stops "10 min" becoming 0.1666… on the client.
        harness.enqueueNoContent()

        api.logProgress(goalId = "g1", amount = 1.1666, hours = 1, minutes = 10)

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, """"hours":1""")
        assertContains(body, """"minutes":10""")
        assertFalse(body.contains("amount"), "amount and hours+minutes are mutually exclusive")
    }

    @Test
    fun `a partial duration still sends both halves`() = runTest {
        harness.enqueueNoContent()

        api.logProgress(goalId = "g1", amount = 0.0, minutes = 45)

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, """"hours":0""")
        assertContains(body, """"minutes":45""")
    }

    @Test
    fun `logProgress carries who was credited, a note and a backdate`() = runTest {
        harness.enqueueNoContent()

        api.logProgress(
            goalId = "g1",
            amount = 3.0,
            personIds = listOf("p1", "p2"),
            note = " Creek hike ",
            loggedOn = "2026-07-16",
        )

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, """"personIds":["p1","p2"]""")
        assertContains(body, """"note":"Creek hike"""")
        assertContains(body, """"loggedOn":"2026-07-16"""")
    }

    @Test
    fun `tickStep patches the step`() = runTest {
        harness.enqueueNoContent()

        api.tickStep("g1", "s1", done = true)

        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/goals/g1/steps/s1", request.path)
        assertContains(request.body.readUtf8(), """"done":true""")
    }

    @Test
    fun `editLog omits what was not edited`() = runTest {
        harness.enqueueNoContent()

        api.editLog(goalId = "g1", logId = "e1", amount = 4.0)

        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/goals/g1/logs/e1", request.path)
        val body = request.body.readUtf8()
        assertContains(body, """"amount":4.0""")
        assertFalse(body.contains("personIds"), "an untouched field must be left alone")
        assertFalse(body.contains("note"))
    }

    @Test
    fun `editLog CLEARS an emptied note with an explicit null`() = runTest {
        // explicitNulls = false means a naive nullable field would vanish from the body
        // and the old note would survive — the button would look broken.
        harness.enqueueNoContent()

        api.editLog(goalId = "g1", logId = "e1", note = "")

        assertContains(harness.takeRequest().body.readUtf8(), """"note":null""")
    }

    @Test
    fun `editLog re-plans who took part, including down to nobody`() = runTest {
        harness.enqueueNoContent()

        api.editLog(goalId = "g1", logId = "e1", personIds = emptyList())

        assertContains(harness.takeRequest().body.readUtf8(), """"personIds":[]""")
    }

    @Test
    fun `deleteLog and deleteGoal answer 204s`() = runTest {
        harness.enqueueNoContent()
        harness.enqueueNoContent()

        api.deleteLog("g1", "e1")
        api.deleteGoal("g1")

        val first = harness.takeRequest()
        assertEquals("DELETE", first.method)
        assertEquals("/api/goals/g1/logs/e1", first.path)
        assertEquals("/api/goals/g1", harness.takeRequest().path)
    }

    // ---- the goal <-> calendar bridge ------------------------------------------

    @Test
    fun `recap items carry the idempotency triple`() = runTest {
        harness.enqueueJson(
            """
            {"items":[
              {"eventId":"ev1","occurrenceDate":"2026-07-17","title":"Soccer","startsAt":"2026-07-17T17:00:00Z",
               "allDay":false,"goalId":"g1","goalTitle":"Move more","goalType":"total","unit":"hours",
               "trackingMode":"shared_total","suggestedAmount":1.5,"defaultPersonIds":["p1"],
               "goalParticipantIds":["p1","p2"]},
              {"eventId":"ev2","occurrenceDate":"2026-07-16","title":"Steps","startsAt":"2026-07-16T09:00:00Z",
               "allDay":true,"goalId":"g2","goalTitle":"Ladder","goalType":"checklist",
               "goalStepId":"s3","stepLabel":"Pick a book"}
            ]}
            """.trimIndent(),
        )

        val items = api.recap()

        assertEquals("ev1|2026-07-17|g1", items[0].id)
        assertTrue(items[0].isAmountBased)
        assertEquals(1.5, items[0].suggestedAmount)
        assertEquals(listOf("p1", "p2"), items[0].goalParticipantIds)
        assertFalse(items[1].isAmountBased, "a checklist confirm ticks a step, it has no amount")
        assertEquals("Pick a book", items[1].stepLabel)
        assertEquals("/api/goal-calendar/recap", harness.takeRequest().path)
    }

    @Test
    fun `confirmRecap names the event, the occurrence and the amount`() = runTest {
        harness.enqueueNoContent()

        api.confirmRecap("ev1", "2026-07-17", amount = 1.5, personIds = listOf("p1"), note = "Soccer")

        val request = harness.takeRequest()
        assertEquals("/api/goal-calendar/recap/confirm", request.path)
        val body = request.body.readUtf8()
        assertContains(body, """"eventId":"ev1"""")
        assertContains(body, """"occurrenceDate":"2026-07-17"""")
        assertContains(body, """"amount":1.5""")
        assertContains(body, """"personIds":["p1"]""")
        assertContains(body, """"note":"Soccer"""")
    }

    @Test
    fun `skipRecap clears an occurrence without logging progress`() = runTest {
        harness.enqueueNoContent()

        api.skipRecap("ev1", "2026-07-17")

        val request = harness.takeRequest()
        assertEquals("/api/goal-calendar/recap/skip", request.path)
        val body = request.body.readUtf8()
        assertContains(body, """"eventId":"ev1"""")
        assertContains(body, """"occurrenceDate":"2026-07-17"""")
        assertFalse(body.contains("amount"))
    }

    @Test
    fun `suggestions link and dismiss hit their own routes`() = runTest {
        harness.enqueueJson(
            """{"items":[{"eventId":"ev5","title":"Yoga","startsAt":"2026-07-17T06:00:00Z",
                         "goalId":"g3","goalTitle":"Stretch","via":"memory"}]}""",
        )
        harness.enqueueNoContent()
        harness.enqueueNoContent()

        val s = api.suggestions().single()
        api.linkSuggestion(s.eventId, s.goalId)
        api.dismissSuggestion(s.eventId)

        assertEquals("ev5", s.id)
        assertEquals("memory", s.via)
        assertEquals("/api/goal-calendar/suggestions", harness.takeRequest().path)
        val link = harness.takeRequest()
        assertEquals("/api/goal-calendar/suggestions/link", link.path)
        assertContains(link.body.readUtf8(), """"goalId":"g3"""")
        assertEquals("/api/goal-calendar/suggestions/dismiss", harness.takeRequest().path)
    }

    @Test
    fun `suggestOne returns null when the matcher has nothing`() = runTest {
        harness.enqueueJson("""{"suggestion":null}""")

        assertNull(api.suggestOne("Dentist"))

        val request = harness.takeRequest()
        assertEquals("/api/goal-calendar/suggest-one", request.path)
        assertFalse(request.body.readUtf8().contains("participantIds"))
    }

    @Test
    fun `suggestOne surfaces the auto-link confidence`() = runTest {
        harness.enqueueJson("""{"suggestion":{"goalId":"g1","goalTitle":"Move more","via":"memory","auto":true}}""")

        val s = api.suggestOne("Soccer", listOf("p1"))

        assertNotNull(s)
        assertEquals(true, s.auto)
        assertContains(harness.takeRequest().body.readUtf8(), """"participantIds":["p1"]""")
    }

    // ---- transport -------------------------------------------------------------

    @Test
    fun `a 401 refreshes once and replays the request`() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"goals":[{"id":"g1","title":"After refresh"}]}""")

        assertEquals("After refresh", api.goalsIn(null).single().title)

        assertEquals(1, harness.refreshCount.get())
        harness.takeRequest()
        assertEquals("Bearer refreshed-access-token", harness.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `a server error relays the server's own message`() = runTest {
        harness.enqueueError(403, "Forbidden", "You can't edit household goals.")

        val failure = assertFailsWith<WaffledApiException> { api.deleteGoal("g1") }

        assertEquals(403, failure.status)
        assertEquals("You can't edit household goals.", failure.userMessage)
    }
}
