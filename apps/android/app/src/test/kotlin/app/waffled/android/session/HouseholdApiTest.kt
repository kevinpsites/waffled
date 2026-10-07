package app.waffled.android.session

import app.waffled.core.model.Person
import app.waffled.core.model.WaffledModule
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /api/household` is the one REST read the shell owns: who is signed in (with the
 * capabilities the synced `persons` table does NOT carry) and which modules are on — the
 * iOS `SyncManager.loadIdentity()`.
 */
class HouseholdApiTest {

    private val harness = ApiTestHarness()
    private lateinit var api: HouseholdApi

    @Before
    fun setUp() {
        harness.start()
        api = HouseholdApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens)
    }

    @After
    fun tearDown() = harness.stop()

    @Test
    fun decodesPersonCapabilitiesAndModuleFlags() = runTest {
        harness.enqueueJson(
            """
            {"provisioned":true,
             "household":{"id":"h1","name":"Seinfelds","timezone":"America/New_York","weekStart":"monday",
               "settings":{"modules":{"meals":false,"pantry":true},"chores":{"rewards":false}}},
             "person":{"id":"p1","name":"Jerry","memberType":"adult","isAdmin":false,
               "capabilities":["reward.manage"]}}
            """.trimIndent(),
        )

        val id = api.identity()

        assertEquals("/api/household", harness.takeRequest().path)
        assertEquals("p1", id.person?.id)
        assertTrue(id.person!!.can("reward.manage"))
        assertFalse(id.person!!.can("chore.approve"))
        assertTrue(id.modules.loaded)
        assertFalse(id.modules.isOn(WaffledModule.Meals))
        assertTrue(id.modules.isOn(WaffledModule.Pantry))
        // Absent from the flags ⇒ the catalog default.
        assertTrue(id.modules.isOn(WaffledModule.Goals))
        assertFalse(id.rewardsEnabled)
        assertEquals("America/New_York", id.timezone)
        assertEquals("monday", id.weekStart)
    }

    @Test
    fun unprovisionedAccountHasNoPersonAndDefaultModules() = runTest {
        harness.enqueueJson("""{"provisioned":false}""")

        val id = api.identity()

        assertNull(id.person)
        assertTrue(id.rewardsEnabled)
        assertTrue(id.modules.isOn(WaffledModule.Meals))
    }

    @Test
    fun rosterDecodesTheRestPersonShape() = runTest {
        harness.enqueueJson(
            """{"persons":[{"id":"p1","name":"Jerry","colorHex":"#2F7FED","avatarEmoji":"🥣"}]}""",
        )

        val people = api.persons()

        assertEquals("/api/persons", harness.takeRequest().path)
        assertEquals(listOf(Person(id = "p1", name = "Jerry", colorHex = "#2F7FED", avatarEmoji = "🥣")), people)
    }
}
