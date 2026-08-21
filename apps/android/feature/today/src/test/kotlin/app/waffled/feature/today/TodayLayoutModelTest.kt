package app.waffled.feature.today

import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The layout model: the fallback wiring, and what a failed fetch must NOT do. */
class TodayLayoutModelTest {

    private val harness = ApiTestHarness()
    private lateinit var model: TodayLayoutModel

    @BeforeTest
    fun setUp() {
        harness.start()
        model = TodayLayoutModel(
            TodayApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens),
        )
    }

    @AfterTest
    fun tearDown() = harness.stop()

    @Test
    fun aColdStartRendersTheBuiltInDefault() {
        val state = model.state.value
        assertEquals(TodayCards.defaultOrder, state.order)
        assertFalse(state.loaded)
    }

    /** A server whose card set predates countdowns/pantry/familyNight still surfaces them. */
    @Test
    fun loadAppliesTheMissingCardFallbacks() = runTest {
        harness.enqueueJson(
            """{"resolved":{"order":["agenda","tonight","grocery"],"hidden":[]},
                "source":"family","cards":["agenda","tonight","grocery"],"canEditFamily":true}""",
        )
        model.load()
        val state = model.state.value
        assertEquals(
            listOf("agenda", "countdowns", "tonight", "grocery", "pantry", "familyNight"),
            state.order,
        )
        assertTrue(state.loaded)
        assertTrue(state.canEditFamily)
        assertEquals("family", state.source)
    }

    @Test
    fun hiddenCardsSurviveTheRoundTrip() = runTest {
        harness.enqueueJson(
            """{"resolved":{"order":["agenda","goals"],"hidden":["goals","countdowns","pantry","familyNight"]},
                "source":"user","cards":[],"canEditFamily":false}""",
        )
        model.load()
        assertEquals(setOf("goals", "countdowns", "pantry", "familyNight"), model.state.value.hidden)
        // Nothing re-inserted: the user hid all three fallback cards deliberately.
        assertEquals(listOf("agenda", "goals"), model.state.value.order)
    }

    /** A flaky network must never rearrange someone's home screen. */
    @Test
    fun aFailedLoadKeepsThePreviousLayout() = runTest {
        harness.enqueueJson(
            """{"resolved":{"order":["chores","agenda"],"hidden":["countdowns","pantry","familyNight"]},
                "source":"user","cards":[],"canEditFamily":true}""",
        )
        model.load()
        val good = model.state.value

        harness.enqueueError(500, "ServerError", "boom")
        model.load()
        assertEquals(good, model.state.value)
    }

    /** Saving writes the mobile tier and re-reads what the server resolved. */
    @Test
    fun savingReloadsTheResolvedLayout() = runTest {
        harness.enqueueJson("""{"ok":true}""")
        harness.enqueueJson(
            """{"resolved":{"order":["chores","agenda"],"hidden":["countdowns","pantry","familyNight"]},
                "source":"user","cards":[],"canEditFamily":false}""",
        )
        assertTrue(model.save("user", listOf("chores", "agenda"), setOf("tonight")))

        val save = harness.takeRequest()
        assertEquals("PUT", save.method)
        assertEquals("/api/today-layout/mobile", save.path)
        assertEquals("/api/today-layout/mobile", harness.takeRequest().path)
        assertEquals(listOf("chores", "agenda"), model.state.value.order)
    }

    @Test
    fun resettingDeletesTheTierThenReloads() = runTest {
        harness.enqueueJson("", status = 204)
        harness.enqueueJson(
            """{"resolved":{"order":["agenda"],"hidden":["countdowns","pantry","familyNight"]},
                "source":"default","cards":[],"canEditFamily":true}""",
        )
        assertTrue(model.reset("family"))
        assertEquals("/api/today-layout/mobile?scope=family", harness.takeRequest().path)
        assertEquals("default", model.state.value.source)
    }
}
