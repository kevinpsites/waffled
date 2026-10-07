package app.waffled.feature.bites

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The control-panel model, driven against MockWebServer. The load-bearing rule: every
 * settings setter sends the FULL sub-object, because the server only deep-merges into an
 * object that already exists, and a fresh pairing has `settings == {}`.
 */
class WaffledBitesModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var model: WaffledBitesModel

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        model = WaffledBitesModel("p1", WaffledBitesApi(client, harness.tokens))
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private suspend fun loaded() {
        harness.enqueueJson(WaffledBitesApiTest.DEVICE_JSON)
        model.load()
        harness.takeRequest()
    }

    private fun patchBody(): JsonObject {
        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/waffled-bites/dev-1/settings", req.path)
        return WaffledJson.parseToJsonElement(req.body.readUtf8()).jsonObject
    }

    private fun enqueuePatchThenReload() {
        harness.enqueueJson("""{"settings":{}}""")
        harness.enqueueJson(WaffledBitesApiTest.DEVICE_JSON)
    }

    @Test
    fun `load seeds the countdowns from the server`() = runTest {
        loaded()
        val s = model.state.value
        assertFalse(s.loading)
        assertEquals("dev-1", s.device?.id)
        assertEquals(240, s.quietRemaining)
        assertEquals(0, s.timerRemaining)
    }

    @Test
    fun `a failed load keeps the device and says so`() = runTest {
        loaded()
        harness.enqueueError(500, "ServerError", "boom")
        model.load()
        assertEquals("dev-1", model.state.value.device?.id)
        assertEquals("Couldn't load this Waffled-Bite.", model.state.value.errorMessage)
    }

    @Test
    fun `ticking counts down only a running countdown`() = runTest {
        loaded()
        model.tick()
        model.tick()
        assertEquals(238, model.state.value.quietRemaining)
        assertEquals(0, model.state.value.timerRemaining)
    }

    @Test
    fun `nightlight toggle on a fresh device sends the whole night object`() = runTest {
        loaded()
        enqueuePatchThenReload()
        model.setNightOn(true)
        assertEquals("""{"night":{"on":true,"color":"amber","brightness":40}}""", patchBody().toString())
        assertEquals("/api/persons/p1/waffled-bite", harness.takeRequest().path)
    }

    @Test
    fun `sound and display setters send their full objects`() = runTest {
        loaded()
        enqueuePatchThenReload()
        model.setSoundSleepTimer(30)
        assertEquals(
            """{"sound":{"on":false,"sound":"ocean","volume":45,"timerMin":30}}""",
            patchBody().toString(),
        )
        harness.takeRequest()

        enqueuePatchThenReload()
        model.setDisplayNightDim(false)
        assertEquals("""{"display":{"brightness":85,"nightDim":false}}""", patchBody().toString())
    }

    @Test
    fun `alarm patches always carry a volume`() = runTest {
        loaded()
        enqueuePatchThenReload()
        model.setAlarmTone("softHarp")
        assertEquals(
            """{"alarm":{"on":false,"hour":6,"min":45,"tone":"softHarp","volume":80}}""",
            patchBody().toString(),
        )
    }

    @Test
    fun `schedules round-trip the whole array and omit an unset bedtime`() = runTest {
        loaded()
        enqueuePatchThenReload()
        model.setSchedules(
            listOf(
                WaffledBitesApi.Schedule(days = listOf(1, 2), wakeMin = 420, leadMin = 10, bedtimeMin = null),
                WaffledBitesApi.Schedule(days = listOf(0), wakeMin = 480, leadMin = 5, bedtimeMin = 1200),
            ),
        )
        assertEquals(
            """{"schedules":[{"days":[1,2],"wakeMin":420,"leadMin":10},""" +
                """{"days":[0],"wakeMin":480,"leadMin":5,"bedtimeMin":1200}]}""",
            patchBody().toString(),
        )
    }

    @Test
    fun `a rejected patch reports and does not reload`() = runTest {
        loaded()
        harness.enqueueError(500)
        model.setNightOn(true)
        patchBody()
        assertEquals("That didn't stick — try again.", model.state.value.errorMessage)
        assertEquals(2, harness.requestCount)
        assertFalse(model.state.value.busy)
    }

    @Test
    fun `custom quiet time is clamped to three hours`() = runTest {
        loaded()
        harness.enqueueJson("{}")
        harness.enqueueJson(WaffledBitesApiTest.DEVICE_JSON)
        model.startQuiet(minutes = 500)
        val req = harness.takeRequest()
        assertEquals("/api/waffled-bites/dev-1/quiet/start", req.path)
        assertEquals("""{"durationSec":10800}""", req.body.readUtf8())
    }

    @Test
    fun `unpair reports success`() = runTest {
        loaded()
        harness.enqueueNoContent()
        assertTrue(model.unpair())
    }

    @Test
    fun `nothing is sent before a device has loaded`() = runTest {
        model.setNightOn(true)
        assertFalse(model.unpair())
        assertEquals(0, harness.requestCount)
        assertNull(model.state.value.device)
    }

    @Test
    fun `an out-of-order older load does not clobber a newer one`() = runTest {
        val stale = WaffledBitesApiTest.DEVICE_JSON.replace("\"dev-1\"", "\"dev-old\"")
        harness.server.enqueue(
            MockResponse().setHeader("Content-Type", "application/json")
                .setBody(stale).setBodyDelay(400, TimeUnit.MILLISECONDS),
        )
        harness.enqueueJson(WaffledBitesApiTest.DEVICE_JSON)

        val first = async { model.load() }
        yield()
        val deadline = System.currentTimeMillis() + 5_000
        while (harness.requestCount < 1 && System.currentTimeMillis() < deadline) Thread.sleep(5)
        val second = async { model.load() }
        second.await()
        first.await()

        assertEquals("dev-1", model.state.value.device?.id)
    }
}
