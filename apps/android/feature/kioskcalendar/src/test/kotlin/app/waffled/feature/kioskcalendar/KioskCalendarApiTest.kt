package app.waffled.feature.kioskcalendar

import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class KioskCalendarApiTest {
    private val harness = ApiTestHarness()
    private lateinit var api: KioskCalendarApi

    @Before
    fun setUp() {
        harness.start()
        api = KioskCalendarApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens)
    }

    @After
    fun tearDown() = harness.stop()

    @Test
    fun readsTheWeeksHeadsUpForTheGivenRange() = runTest {
        harness.enqueueJson("""{"headline":"Busy Thursday","body":"Three things after school."}""")

        val headsUp = api.headsUp(from = "2026-10-04", to = "2026-10-10")

        assertEquals(KioskCalendarApi.HeadsUp("Busy Thursday", "Three things after school."), headsUp)
        val req = harness.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/calendar/heads-up?from=2026-10-04&to=2026-10-10", req.path)
    }

    @Test
    fun aFailureIsNullSoTheCardKeepsThinking() = runTest {
        harness.enqueueError(500, "ServerError", "boom")
        assertNull(api.headsUp(from = "2026-10-04", to = "2026-10-10"))
    }
}
