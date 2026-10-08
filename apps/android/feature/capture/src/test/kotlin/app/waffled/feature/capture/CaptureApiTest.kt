package app.waffled.feature.capture

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The capture slice, against MockWebServer. The assertions that matter are on the
 * request BODY: the routes distinguish a missing key from an explicit null, and
 * `WaffledJson` drops nulls unless the body says otherwise.
 */
class CaptureApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: CaptureApi

    @Before fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = CaptureApi(client, harness.tokens)
    }

    @After fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun lastJson(): Pair<String, JsonObject> {
        val r = harness.takeRequest()
        return "${r.method} ${r.path}" to WaffledJson.parseToJsonElement(r.body.readUtf8()).jsonObject
    }

    // ---- parse / warm --------------------------------------------------------------

    @Test fun `parse posts the text and decodes the intent`() = runTest {
        harness.enqueueJson("""{"intent":{"kind":"grocery","name":"Milk"},"via":"anthropic","fallback":false}""")
        val r = api.parse("milk")
        assertEquals(CaptureIntent.Grocery("Milk", null), r.intent)
        assertEquals("anthropic", r.via)
        assertFalse(r.fallback)
        val (line, body) = lastJson()
        assertEquals("POST /api/capture", line)
        assertEquals(JsonPrimitive("milk"), body["text"])
    }

    @Test fun `parse fallback carries no intent`() = runTest {
        harness.enqueueJson("""{"intent":null,"via":"heuristic","fallback":true,"error":"timeout"}""")
        val r = api.parse("milk")
        assertNull(r.intent)
        assertTrue(r.fallback)
    }

    @Test fun `warm never throws`() = runTest {
        harness.enqueueError(500)
        api.warm()
        assertEquals("/api/capture/warm", harness.takeRequest().path)
    }

    // ---- Tier 2 --------------------------------------------------------------------

    @Test fun `resolve sends verb, explicit null targetKind, target description and args`() = runTest {
        harness.enqueueJson(
            """{"candidates":[{"id":"c1","title":"Reading","subtitle":"Kevin","confidence":0.9,"meta":{"occ":"x"}}]}""",
        )
        val r = api.resolve("log", null, "reading", mapOf("minutes" to JsonPrimitive(20.0)))
        assertEquals(listOf("c1"), r.candidates.map { it.id })
        assertEquals(JsonPrimitive("x"), r.candidates[0].meta?.get("occ"))
        assertFalse(r.unsupported)
        val (line, body) = lastJson()
        assertEquals("POST /api/capture/resolve", line)
        assertEquals(JsonNull, body["targetKind"])
        assertEquals(JsonPrimitive("reading"), body["target"]!!.jsonObject["description"])
        assertEquals(JsonPrimitive(20.0), body["args"]!!.jsonObject["minutes"])
    }

    @Test fun `resolve surfaces unsupported and disabledReason`() = runTest {
        harness.enqueueJson("""{"candidates":[],"unsupported":true,"disabledReason":"Quick-add can't delete goals."}""")
        val r = api.resolve("delete", "goal", "reading", emptyMap())
        assertTrue(r.unsupported)
        assertEquals("Quick-add can't delete goals.", r.disabledReason)
    }

    @Test fun `commit passes meta back unchanged and returns the server message`() = runTest {
        harness.enqueueJson("""{"ok":true,"message":"Logged 20 min on Reading"}""")
        val msg = api.commitMutate("log", "goal", "id-1", mapOf("minutes" to JsonPrimitive(20.0)), mapOf("occ" to JsonPrimitive("x")))
        assertEquals("Logged 20 min on Reading", msg)
        val (_, body) = lastJson()
        assertEquals(JsonPrimitive("id-1"), body["targetId"])
        assertEquals(JsonPrimitive("x"), body["meta"]!!.jsonObject["occ"])
    }

    @Test fun `commit relays the friendly server message on failure`() = runTest {
        harness.enqueueError(400, "Unsupported", "Quick-add can't do that yet.")
        val e = assertFailsWith<WaffledApiException> { api.commitMutate("delete", "goal", "id-1", emptyMap(), null) }
        assertEquals("Quick-add can't do that yet.", e.userMessage)
    }

    // ---- creates -------------------------------------------------------------------

    @Test fun `lists drops templates`() = runTest {
        harness.enqueueJson(
            """{"lists":[{"id":"g","name":"Groceries","listType":"grocery"},{"id":"t","name":"Packing","listType":"template"},{"id":"c","name":"Camping","emoji":"⛺","listType":"custom"}]}""",
        )
        assertEquals(listOf("g", "c"), api.lists().map { it.id })
    }

    @Test fun `chore create sends an explicit null assignee`() = runTest {
        harness.enqueueJson("""{"chore":{"id":"x"}}""")
        api.createChore("Trash", null, 5, "stars", "FREQ=WEEKLY;BYDAY=TU")
        val (line, body) = lastJson()
        assertEquals("POST /api/chores", line)
        assertEquals(JsonNull, body["personId"])
        assertEquals(JsonPrimitive(5), body["rewardAmount"])
        assertEquals(JsonPrimitive("stars"), body["rewardCurrency"])
        assertEquals(JsonPrimitive("FREQ=WEEKLY;BYDAY=TU"), body["rrule"])
    }

    @Test fun `goal create sends a count target as a whole number and omits empties`() = runTest {
        harness.enqueueJson("""{"goal":{"id":"x"}}""")
        api.createGoal("Read", "count", "shared_total", 20.0, "books", null, listOf("p1"))
        val (line, body) = lastJson()
        assertEquals("POST /api/goals", line)
        assertEquals("20", body["targetValue"].toString())
        assertFalse(body.containsKey("deadline"))
        assertEquals("[\"p1\"]", body["participantIds"].toString())
    }

    @Test fun `goal create with no participants lets the route scope it to the caller`() = runTest {
        harness.enqueueJson("""{"goal":{"id":"x"}}""")
        api.createGoal("Run", "total", "shared_total", 10.5, "miles", "2026-09-30", emptyList())
        val (_, body) = lastJson()
        assertEquals("10.5", body["targetValue"].toString())
        assertFalse(body.containsKey("participantIds"))
    }

    @Test fun `pantry create keeps only a non-negative lowAt`() = runTest {
        harness.enqueueJson("""{"item":{"id":"x"}}""")
        api.createPantryItem("Beans", "2", "cans", "Pantry", null, -1.0)
        val (line, body) = lastJson()
        assertEquals("POST /api/pantry", line)
        assertFalse(body.containsKey("lowAt"))
        assertFalse(body.containsKey("expiresOn"))
        assertEquals(JsonPrimitive("cans"), body["unit"])
    }

    @Test fun `reward create omits requiresApproval to inherit the household default`() = runTest {
        harness.enqueueJson("""{"reward":{"id":"x"}}""")
        api.createReward("Ice cream", null, 50, null)
        val (line, body) = lastJson()
        assertEquals("POST /api/rewards", line)
        assertFalse(body.containsKey("requiresApproval"))
        assertEquals(JsonPrimitive(50), body["cost"])
    }

    @Test fun `person create always sends isAdmin`() = runTest {
        harness.enqueueJson("""{"person":{"id":"x"}}""")
        api.createPerson("Max", "kid", null, null, false)
        val (line, body) = lastJson()
        assertEquals("POST /api/persons", line)
        assertEquals(JsonPrimitive(false), body["isAdmin"])
        assertFalse(body.containsKey("avatarEmoji"))
    }

    @Test fun `event create names the owner first and carries the rule`() = runTest {
        harness.enqueueJson("""{"event":{"id":"e1"}}""")
        api.createEvent("Soccer", "2026-06-16T22:00:00Z", "2026-06-16T23:00:00Z", false, listOf("p1"), "America/Denver", "FREQ=WEEKLY;BYDAY=TU", null)
        val (line, body) = lastJson()
        assertEquals("POST /api/events", line)
        assertEquals(JsonPrimitive("p1"), body["personId"])
        assertEquals("[\"p1\"]", body["participantIds"].toString())
        assertEquals(JsonPrimitive("FREQ=WEEKLY;BYDAY=TU"), body["rrule"])
        assertFalse(body.containsKey("recurrenceEndAt"))
    }

    @Test fun `grocery, list item, meal and countdown hit their routes`() = runTest {
        repeat(4) { harness.enqueueJson("""{"item":{"id":"x"},"id":"x"}""") }
        api.addGroceryItem("Milk (2)")
        assertEquals("POST /api/lists/grocery/items", lastJson().first)
        api.addListItem("l1", "Tent", null)
        val (itemLine, itemBody) = lastJson()
        assertEquals("POST /api/lists/l1/items", itemLine)
        assertFalse(itemBody.containsKey("quantity"))
        api.planMeal("2026-06-12", "dinner", null, "Tacos")
        val (mealLine, mealBody) = lastJson()
        assertEquals("POST /api/meals/plan", mealLine)
        assertFalse(mealBody.containsKey("recipeId"))
        api.createCountdown("Disney", "2026-06-23", null)
        assertEquals("POST /api/countdowns", lastJson().first)
    }

    @Test fun `create list sends an explicit null emoji`() = runTest {
        harness.enqueueJson("""{"list":{"id":"n","name":"Camping","listType":"custom"}}""")
        val l = api.createList("Camping")
        assertEquals("n", l.id)
        assertEquals(JsonNull, lastJson().second["emoji"])
    }
}
