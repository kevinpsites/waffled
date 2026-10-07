package app.waffled.feature.bites

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class WaffledBitesApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: WaffledBitesApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = WaffledBitesApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun body(): JsonObject =
        WaffledJson.parseToJsonElement(harness.takeRequest().body.readUtf8()).jsonObject

    @Test
    fun `an unpaired kid decodes as no device`() = runTest {
        harness.enqueueJson("""{"device":null}""")
        assertNull(api.device("p1"))
        assertEquals("/api/persons/p1/waffled-bite", harness.takeRequest().path)
    }

    @Test
    fun `a fresh pairing with empty settings decodes`() = runTest {
        harness.enqueueJson(DEVICE_JSON)
        val d = api.device("p1")!!
        assertEquals("dev-1", d.id)
        assertNull(d.settings.night)
        assertEquals(240, d.runtimeState.quiet.remainingSec)
        assertEquals("sleep", d.runtimeState.wakeLight.state)
        assertEquals(6, d.runtimeState.wakeLight.wakeAtHour)
    }

    @Test
    fun `minting sends the label`() = runTest {
        harness.enqueueJson("""{"code":"ABC123","personId":"p1","expiresAt":"2026-07-23T12:10:00Z"}""")
        assertEquals("ABC123", api.mintPairingCode("p1", "Ava's Waffled-Bite").code)
        val req = harness.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/persons/p1/waffled-bite/pairing-code", req.path)
        assertEquals("""{"label":"Ava's Waffled-Bite"}""", req.body.readUtf8())
    }

    @Test
    fun `countdown controls hit their routes`() = runTest {
        harness.enqueueJson("{}")
        api.countdown("dev-1", WaffledBitesApi.CountdownKind.Quiet, WaffledBitesApi.CountdownAction.Start, durationSec = 900)
        val start = harness.takeRequest()
        assertEquals("/api/waffled-bites/dev-1/quiet/start", start.path)
        assertEquals("""{"durationSec":900}""", start.body.readUtf8())

        harness.enqueueJson("{}")
        api.countdown("dev-1", WaffledBitesApi.CountdownKind.Timer, WaffledBitesApi.CountdownAction.AddTime)
        val add = harness.takeRequest()
        assertEquals("/api/waffled-bites/dev-1/timer/add-time", add.path)
        assertEquals("""{"seconds":300}""", add.body.readUtf8())

        harness.enqueueJson("{}")
        api.countdown("dev-1", WaffledBitesApi.CountdownKind.Timer, WaffledBitesApi.CountdownAction.End)
        val end = harness.takeRequest()
        assertEquals("/api/waffled-bites/dev-1/timer/end", end.path)
        assertEquals("{}", end.body.readUtf8())
    }

    @Test
    fun `unpair deletes the device`() = runTest {
        harness.enqueueNoContent()
        api.unpair("dev-1")
        val req = harness.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/waffled-bites/dev-1", req.path)
    }

    @Test
    fun `settings patch relays the server error`() = runTest {
        harness.enqueueError(403, "Forbidden", "Admins only")
        val e = assertFailsWith<WaffledApiException> { api.updateSettings("dev-1", JsonObject(emptyMap())) }
        assertEquals("Admins only", e.userMessage)
        assertEquals("PATCH", harness.takeRequest().method)
    }

    companion object {
        val DEVICE_JSON = """
            {"device":{"id":"dev-1","label":"Ava's Waffled-Bite","settings":{},
             "runtimeState":{
               "quiet":{"active":true,"running":true,"remainingSec":240,"durationSec":900},
               "timer":{"active":false,"running":false,"remainingSec":0,"durationSec":0},
               "wakeLight":{"state":"sleep","wakeAtHour":6,"wakeAtMinute":45}},
             "lastSeenAt":"2026-07-23T11:58:00Z","createdAt":"2026-07-01T00:00:00Z"}}
        """.trimIndent()
    }
}
