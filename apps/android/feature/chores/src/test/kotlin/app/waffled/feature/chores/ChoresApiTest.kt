package app.waffled.feature.chores

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The chores API slice, driven against a real MockWebServer through [ApiTestHarness].
 *
 * Chores are **online-only** — they are not in the PowerSync schema — so this slice is
 * the whole data path for the board, and the request bodies are asserted on the wire.
 */
class ChoresApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: ChoresApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = ChoresApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    // ---- reading the board -------------------------------------------------------

    @Test
    fun `instances unwraps the envelope and carries every display field`() = runTest {
        harness.enqueueJson(
            """
            {"instances":[
              {"id":"i1","choreId":"c1","choreTitle":"Feed the dog","emoji":"🐶",
               "personId":"p1","personName":"Elaine","status":"awaiting","rewardAmount":3,
               "rewardCurrency":"stars","rrule":"FREQ=DAILY","dueOn":"2026-08-20",
               "dueTime":"16:30","requiresApproval":true,"streak":4,
               "requiresPhoto":true,"proofUrl":"/media/ab/cd.jpg","hadProof":true}
            ]}
            """.trimIndent(),
        )

        val instances = api.instances("2026-08-21")

        assertEquals(1, instances.size)
        val i = instances.first()
        assertEquals("i1", i.id)
        assertEquals("c1", i.choreId)
        assertEquals("Feed the dog", i.choreTitle)
        assertEquals("Elaine", i.personName)
        assertEquals("awaiting", i.status)
        assertEquals(3, i.rewardAmount)
        assertEquals("stars", i.rewardCurrency)
        assertEquals("2026-08-20", i.dueOn)
        assertEquals("16:30", i.dueTime)
        assertTrue(i.requiresApproval)
        assertEquals(4, i.streak)
        assertTrue(i.requiresPhoto)
        assertEquals("/media/ab/cd.jpg", i.proofUrl)
        assertTrue(i.hadProof)

        assertEquals("/api/chore-instances/today?date=2026-08-21", harness.takeRequest().path)
    }

    @Test
    fun `an older payload missing the newer fields still decodes`() = runTest {
        // The proof + due-time fields arrived later; a self-hosted server on an older
        // build must not blank the whole board.
        harness.enqueueJson(
            """{"instances":[{"id":"i1","choreId":"c1","choreTitle":"Tidy up","status":"pending"}]}""",
        )

        val i = api.instances("2026-08-21").single()

        assertEquals("Tidy up", i.choreTitle)
        assertEquals(0, i.rewardAmount)
        assertEquals(0, i.streak)
        assertFalse(i.requiresApproval)
        assertFalse(i.requiresPhoto)
        assertFalse(i.hadProof)
        assertNull(i.dueTime)
        assertNull(i.proofUrl)
    }

    @Test
    fun `awaiting pulls the whole approvals queue, not one day`() = runTest {
        harness.enqueueJson(
            """{"instances":[{"id":"i9","choreId":"c9","choreTitle":"Dishes","status":"awaiting"}]}""",
        )

        assertEquals("i9", api.awaiting().single().id)
        assertEquals("/api/chore-instances/awaiting", harness.takeRequest().path)
    }

    @Test
    fun `currencies unwraps the currencies envelope`() = runTest {
        harness.enqueueJson(
            """
            {"currencies":[
              {"key":"stars","label":"Stars","symbol":"⭐","color":"#F3A93B",
               "isDefault":true,"spendable":true,"sortOrder":0}
            ]}
            """.trimIndent(),
        )

        val c = api.currencies().single()
        assertEquals("stars", c.key)
        assertEquals("⭐", c.symbol)
        assertTrue(c.isDefault)
        assertEquals("/api/currencies", harness.takeRequest().path)
    }

    // ---- completing ---------------------------------------------------------------

    @Test
    fun `complete without proof posts an empty body`() = runTest {
        harness.enqueueJson("{}")

        api.complete("i1")

        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/chore-instances/i1/complete", request.path)
        val body = request.body.readUtf8()
        assertFalse(body.contains("storageKey"), body)
    }

    @Test
    fun `complete with proof carries the storage key and content type`() = runTest {
        harness.enqueueJson("{}")

        api.complete("i1", storageKey = "blob-123", contentType = "image/jpeg")

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, "\"storageKey\":\"blob-123\"")
        assertContains(body, "\"contentType\":\"image/jpeg\"")
    }

    @Test
    fun `a photo-required chore completed without proof surfaces the 422`() = runTest {
        harness.enqueueError(422, error = "ProofRequired")

        val failure = assertFailsWith<WaffledApiException> { api.complete("i1") }

        assertEquals(422, failure.status)
    }

    @Test
    fun `uncomplete approve and reject each hit their own verb`() = runTest {
        harness.enqueueJson("{}")
        api.uncomplete("i1")
        assertEquals("/api/chore-instances/i1/uncomplete", harness.takeRequest().path)

        harness.enqueueJson("{}")
        api.approve("i2")
        assertEquals("/api/chore-instances/i2/approve", harness.takeRequest().path)

        harness.enqueueJson("{}")
        api.reject("i3")
        assertEquals("/api/chore-instances/i3/reject", harness.takeRequest().path)
    }

    // ---- claiming + assigning -----------------------------------------------------

    @Test
    fun `claim names the person who did it`() = runTest {
        harness.enqueueJson("{}")

        api.claim("i1", personId = "p2")

        val request = harness.takeRequest()
        assertEquals("/api/chore-instances/i1/claim", request.path)
        assertContains(request.body.readUtf8(), "\"personId\":\"p2\"")
    }

    @Test
    fun `unassigning puts an explicit null on the wire`() = runTest {
        // `WaffledJson` sets `explicitNulls = false`, so a nullable data-class field would
        // be OMITTED — and the server would read "leave the assignee alone" instead of
        // "send this back to up for grabs". The body is built as a JsonObject for exactly
        // this reason.
        harness.enqueueJson("{}")

        api.assign("i1", personId = null)

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, "\"personId\":null")
    }

    @Test
    fun `assigning to a person names them`() = runTest {
        harness.enqueueJson("{}")

        api.assign("i1", personId = "p3")

        assertContains(harness.takeRequest().body.readUtf8(), "\"personId\":\"p3\"")
    }

    // ---- chore definitions --------------------------------------------------------

    @Test
    fun `create posts the definition body verbatim`() = runTest {
        harness.enqueueJson("{}")

        api.createChore(
            buildJsonObject {
                put("title", JsonPrimitive("Feed the dog"))
                put("emoji", JsonNull)
                put("personId", JsonNull)
                put("rewardAmount", JsonPrimitive(2))
                put("rrule", JsonNull)
            },
        )

        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/chores", request.path)
        val body = request.body.readUtf8()
        assertContains(body, "\"title\":\"Feed the dog\"")
        // The nulls must survive: they are how the editor clears an emoji, unassigns a
        // chore, and turns a recurring chore back into a one-off.
        assertContains(body, "\"emoji\":null")
        assertContains(body, "\"personId\":null")
        assertContains(body, "\"rrule\":null")
    }

    @Test
    fun `update patches one chore definition`() = runTest {
        harness.enqueueJson("{}")

        api.updateChore("c1", buildJsonObject { put("title", JsonPrimitive("Walk the dog")) })

        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/chores/c1", request.path)
    }

    @Test
    fun `delete removes a chore definition`() = runTest {
        harness.enqueueJson("", status = 204)

        api.deleteChore("c1")

        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/chores/c1", request.path)
    }

    @Test
    fun `a non-parent editing a chore gets the server's 403 relayed`() = runTest {
        harness.enqueueError(403, error = "Forbidden", message = "Only an admin can do that")

        val failure = assertFailsWith<WaffledApiException> {
            api.createChore(buildJsonObject { put("title", JsonPrimitive("x")) })
        }

        assertEquals(403, failure.status)
        assertEquals("Only an admin can do that", failure.userMessage)
    }

    // ---- stored proofs ------------------------------------------------------------

    @Test
    fun `deleting a stored proof targets the chore-proofs route`() = runTest {
        harness.enqueueJson("", status = 204)

        api.deleteProof("i1")

        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/chore-proofs/i1", request.path)
    }

    // ---- auth --------------------------------------------------------------------

    @Test
    fun `a 401 refreshes once and replays the request`() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"instances":[]}""")

        assertEquals(emptyList(), api.instances("2026-08-21"))

        assertEquals(1, harness.refreshCount.get())
        harness.takeRequest() // the 401'd attempt
        assertEquals(
            "Bearer refreshed-access-token",
            harness.takeRequest().getHeader("Authorization"),
        )
    }

    @Test
    fun `media upload posts base64 inside JSON`() = runTest {
        // The container server buffers request bodies to a string, so the proof photo
        // goes as base64 in JSON rather than multipart — same route Photos uses.
        harness.enqueueJson("""{"key":"blob-1","url":"/media/ab/cd.jpg","contentType":"image/jpeg"}""")

        val uploaded = api.uploadMedia("QUJD", "image/jpeg")

        assertEquals("blob-1", uploaded.key)
        val request = harness.takeRequest()
        assertEquals("/api/media", request.path)
        assertContains(request.body.readUtf8(), "\"data\":\"QUJD\"")
    }
}
