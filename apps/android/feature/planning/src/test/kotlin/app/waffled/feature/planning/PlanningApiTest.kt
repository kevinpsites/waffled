package app.waffled.feature.planning

import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.planning.api.ParkedTagChange
import app.waffled.feature.planning.api.PlanningApi
import app.waffled.feature.planning.api.PlanningConfigPatch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The shell's routes against a real MockWebServer. Three of them read key PRESENCE rather
 * than value, so the bodies on the wire are what is asserted.
 */
class PlanningApiTest {

    private val harness = ApiTestHarness()
    private lateinit var api: PlanningApi

    @Before fun setUp() {
        harness.start()
        api = PlanningApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens)
    }

    @After fun tearDown() = harness.stop()

    private fun sentBody(): JsonObject =
        Json.parseToJsonElement(harness.takeRequest().body.readUtf8()).jsonObject

    private val sessionJson = """{"id":"s1","weekStart":"2026-09-06","status":"active","currentStep":"calendar",
        "driverPersonId":null,"startedAt":"2026-09-06T17:00:00.000Z","completedAt":null}"""

    private val configJson = """{"dayOfWeek":0,"time":"17:00","steps":{},"showOnToday":true}"""

    @Test fun `the view asks for a pinned week in the query`() = runTest {
        harness.enqueueJson(
            """{"config":$configJson,"weekStart":"2026-09-13","defaultWeekStart":"2026-09-06",
               "minWeekStart":"2026-08-30","session":null,"steps":[]}""",
        )
        val view = api.view("2026-09-13")
        assertEquals("2026-09-13", view.weekStart)
        assertEquals("/api/weekly-planning?weekStart=2026-09-13", harness.takeRequest().path)
    }

    @Test fun `the default week sends no query`() = runTest {
        harness.enqueueJson(
            """{"config":$configJson,"weekStart":"2026-09-06","defaultWeekStart":"2026-09-06",
               "minWeekStart":"2026-08-30","session":null,"steps":[]}""",
        )
        api.view(null)
        assertEquals("/api/weekly-planning", harness.takeRequest().path)
    }

    @Test fun `patching only the status sends no currentStep key`() = runTest {
        harness.enqueueJson("""{"session":$sessionJson}""")
        api.patchSession("s1", currentStep = null, status = "active")
        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/weekly-planning/session/s1", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("status"), body.keys)
    }

    @Test fun `deciding a step with no crumb omits data entirely`() = runTest {
        harness.enqueueJson("""{"steps":[]}""")
        api.decideStep("s1", "calendar", "skipped", null)
        val body = sentBody()
        assertEquals(setOf("stepKey", "status"), body.keys)
        assertEquals(JsonPrimitive("skipped"), body["status"])
    }

    @Test fun `deciding a step with a crumb sends it as an object`() = runTest {
        harness.enqueueJson("""{"steps":[]}""")
        api.decideStep("s1", "calendar", "done", buildJsonObject { put("added", 2) })
        assertEquals(buildJsonObject { put("added", 2) }, sentBody()["data"])
    }

    @Test fun `the config put sends only the field that changed`() = runTest {
        harness.enqueueJson("""{"config":$configJson}""")
        api.setConfig(PlanningConfigPatch(steps = mapOf("horizon" to false)))
        val request = harness.takeRequest()
        assertEquals("PUT", request.method)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("steps"), body.keys)
        assertEquals(buildJsonObject { put("horizon", false) }, body["steps"])
    }

    @Test fun `starting the default week sends an empty body`() = runTest {
        harness.enqueueJson("""{"session":$sessionJson}""")
        val session = api.startSession(null)
        assertEquals("s1", session.id)
        assertTrue(sentBody().isEmpty())
    }

    @Test fun `complete has no body and decodes the envelope`() = runTest {
        harness.enqueueJson("""{"session":$sessionJson,"steps":[]}""")
        api.completeSession("s1")
        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/weekly-planning/session/s1/complete", request.path)
    }

    @Test fun `discard is a delete`() = runTest {
        harness.enqueueNoContent()
        api.discardSession("s1")
        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/weekly-planning/session/s1", request.path)
    }

    @Test fun `parking with no tag and no session omits both keys`() = runTest {
        harness.enqueueJson("""{"item":{"id":"p1","note":"fix the gate","stepKey":null,"status":"open","sessionId":null,"createdAt":"x"}}""")
        api.parkNote("fix the gate", null, null)
        assertEquals(setOf("note"), sentBody().keys)
    }

    @Test fun `no tag is an explicit null on the parked-note update`() = runTest {
        harness.enqueueJson("""{"item":{"id":"p1","note":"x","stepKey":null,"status":"open","sessionId":null,"createdAt":"x"}}""")
        api.updateParkedNote("p1", note = null, stepKey = ParkedTagChange.To(null))
        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/weekly-planning/loose-ends/parked/p1", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("stepKey"), body.keys)
        assertEquals(JsonNull, body["stepKey"])
    }

    @Test fun `only the words leaves the tag key off the update`() = runTest {
        harness.enqueueJson("""{"item":{"id":"p1","note":"y","stepKey":"meals","status":"open","sessionId":null,"createdAt":"x"}}""")
        api.updateParkedNote("p1", note = "y", stepKey = ParkedTagChange.Unchanged)
        val body = sentBody()
        assertEquals(setOf("note"), body.keys)
        assertFalse("stepKey" in body)
    }

    @Test fun `resolving a parked note names this session`() = runTest {
        harness.enqueueJson("""{"ok":true,"kind":"parked","id":"p1","action":"done"}""")
        api.resolveLooseEnd("parked", "p1", "done", "s1")
        val body = sentBody()
        assertEquals(JsonPrimitive("s1"), body["sessionId"])
        assertEquals(JsonPrimitive("parked"), body["kind"])
    }
}
