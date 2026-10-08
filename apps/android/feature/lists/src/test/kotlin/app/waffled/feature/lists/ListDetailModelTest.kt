package app.waffled.feature.lists

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The list-detail state machine, driven over a real MockWebServer.
 *
 * Everything here is a rule that has a production reason behind it: the optimistic writes
 * that must revert, the silent poll that must not clobber a local edit, the settling row
 * that lingers before dropping into Completed, and the week that only ever comes from the
 * server.
 */
class ListDetailModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: ListsApi
    private val bus = RefreshBus()

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = ListsApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun custom(id: String = "l2") = ListSummary(id, "Camping gear", "⛺", "custom", 3)
    private fun grocery() = ListSummary("grocery", "Groceries", "🛒", "grocery", 12)

    private fun model(list: ListSummary = custom()) = ListDetailModel(list, api, bus)

    private val twoItems = """
        {"items":[
          {"id":"i1","name":"Tent pegs","quantity":"8","quantityInput":"8","checked":false,"section":"Gear"},
          {"id":"i2","name":"Sunscreen","checked":true,"section":"Toiletries"}
        ]}
    """.trimIndent()

    // ---- loading ---------------------------------------------------------------

    @Test
    fun `a custom list loads its items straight from the list route`() = runTest {
        harness.enqueueJson(twoItems)

        val m = model()
        m.load()

        assertEquals(2, m.items.size)
        assertFalse(m.loadingState.value)
        assertFalse(m.errorState.value)
        assertEquals("/api/lists/l2", harness.takeRequest().path)
    }

    /**
     * Grocery rows group by AISLE, but the board sends the aisle in its own field. Rows
     * with no section of their own get it backfilled at load, so the board on screen and
     * the shared text (which reads `section`) can never disagree.
     */
    @Test
    fun `a grocery load backfills section from aisle`() = runTest {
        harness.enqueueJson(
            """{"weekStart":"2026-08-16","meals":[],"items":[
                 {"id":"i1","name":"Eggs","checked":false,"aisle":"Dairy & Chilled"},
                 {"id":"i2","name":"Foil","checked":false,"section":"Other","aisle":"Pantry"}
               ],"staples":[]}""",
        )
        harness.enqueueJson("""{"stores":["Costco"]}""")

        val m = model(grocery())
        m.load()

        assertEquals("Dairy & Chilled", m.items[0].section)
        // A row that already HAS a section keeps it — the backfill never overwrites.
        assertEquals("Other", m.items[1].section)
        assertEquals(listOf("Costco"), m.knownStoresState.value)
        assertEquals("2026-08-16", m.boardState.value.weekStart)
    }

    /** A failed fetch keeps what was on screen — a flaky network must not blank the list. */
    @Test
    fun `a failed reload keeps the items already on screen`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueError(500, "ServerError", "Nope")
        m.load()

        assertEquals(2, m.items.size)
        assertTrue(m.errorState.value)
    }

    /**
     * The cross-device liveness poll composes its answer BEFORE a local edit reaches the
     * server, so applying it would undo what's on screen — a deleted row reappearing, a
     * ticked row going back to unticked. A silent load that raced an edit is dropped.
     */
    @Test
    fun `a silent poll that raced a local edit is discarded`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()
        harness.takeRequest()

        // Hold the poll's response open so the delete genuinely lands *while it is in the
        // air* — the only arrangement in which the guard is doing anything.
        val pollArrived = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        harness.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.method == "DELETE") {
                    MockResponse().setResponseCode(204)
                } else {
                    pollArrived.complete(Unit)
                    runBlocking { release.await() }
                    MockResponse().setResponseCode(200)
                        .setHeader("Content-Type", "application/json")
                        .setBody(twoItems)
                }
        }

        withContext(Dispatchers.Default) {
            val poll = async { m.load(silent = true) }
            pollArrived.await()
            m.remove("i1") // the row goes while the server's answer is still on the wire
            release.complete(Unit)
            poll.await()
        }

        assertEquals(1, m.items.size, "the stale silent answer must not resurrect the row")
    }

    /** The same poll, with nothing racing it, DOES fold in another device's edits. */
    @Test
    fun `an unraced silent poll applies the server's answer`() = runTest {
        harness.enqueueJson("""{"items":[{"id":"i1","name":"Tent pegs","checked":false}]}""")
        val m = model()
        m.load()

        harness.enqueueJson(twoItems)
        m.load(silent = true)

        assertEquals(2, m.items.size)
    }

    /** An explicit reload is never guarded — the user asked for server truth. */
    @Test
    fun `an explicit reload after an edit does apply the server's answer`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueJson("", status = 204)
        m.remove("i1")

        harness.enqueueJson(twoItems)
        m.load()

        assertEquals(2, m.items.size)
    }

    // ---- checking off ----------------------------------------------------------

    /**
     * A checked row lingers in place before dropping into Completed, so ticking something
     * doesn't make it vanish from under your finger.
     */
    @Test
    fun `a checked row settles in place first, then falls into Completed`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueJson("", status = 204)
        m.toggle("i1")

        assertTrue(m.items.first { it.id == "i1" }.checked)
        assertContains(m.settlingState.value, "i1")
        // Still in its own section while it settles…
        assertTrue(m.activeSections.any { g -> g.items.any { it.id == "i1" } })
        assertFalse(m.completed.any { it.id == "i1" })

        m.settle("i1")

        assertFalse(m.activeSections.any { g -> g.items.any { it.id == "i1" } })
        assertTrue(m.completed.any { it.id == "i1" })
    }

    @Test
    fun `a failed toggle puts the tick back`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueError(500, "ServerError")
        m.toggle("i1")

        assertFalse(m.items.first { it.id == "i1" }.checked)
        assertFalse(m.settlingState.value.contains("i1"))
    }

    @Test
    fun `unchecking returns a row to its section immediately`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueJson("", status = 204)
        m.toggle("i2") // i2 arrives checked

        assertFalse(m.items.first { it.id == "i2" }.checked)
        assertTrue(m.activeSections.any { g -> g.items.any { it.id == "i2" } })
    }

    @Test
    fun `every write bumps the Lists refresh domain`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()
        val before = bus.revisionOf(RefreshDomain.Lists)

        harness.enqueueJson("", status = 204)
        m.toggle("i1")

        assertTrue(bus.revisionOf(RefreshDomain.Lists) > before)
    }

    // ---- inline editing --------------------------------------------------------

    /**
     * The row holds "1½ lb" for reading and "1 1/2 lb" for typing. Comparing the typed
     * text against the DISPLAY quantity makes merely focusing a row and tapping away look
     * like an edit — and save. The comparison must use the seed.
     */
    @Test
    fun `submitting the edit seed unchanged writes nothing`() = runTest {
        harness.enqueueJson(
            """{"items":[{"id":"i1","name":"Flour","quantity":"1½ lb","quantityInput":"1 1/2 lb","checked":false}]}""",
        )
        val m = model()
        m.load()
        val seeded = m.items[0].editableQuantity

        val before = harness.requestCount
        m.edit("i1", "Flour", seeded)

        assertEquals(before, harness.requestCount, "a tap-away with nothing changed must not PATCH")
    }

    @Test
    fun `a real inline edit patches and updates both quantity forms`() = runTest {
        harness.enqueueJson(
            """{"items":[{"id":"i1","name":"Flour","quantity":"1½ lb","quantityInput":"1 1/2 lb","checked":false}]}""",
        )
        val m = model()
        m.load()

        harness.enqueueJson("", status = 204)
        m.edit("i1", "Bread flour", "2 lb")

        assertEquals("Bread flour", m.items[0].name)
        assertEquals("2 lb", m.items[0].quantity)
        // The typed text seeds the NEXT edit too, or reopening the row would show the
        // pre-edit quantity until the following load.
        assertEquals("2 lb", m.items[0].editableQuantity)
    }

    @Test
    fun `an emptied name is refused rather than saved`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        val before = harness.requestCount
        m.edit("i1", "   ", "8")

        assertEquals("Tent pegs", m.items[0].name)
        assertEquals(before, harness.requestCount)
    }

    @Test
    fun `a failed inline edit reverts the row`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueError(500, "ServerError")
        m.edit("i1", "Tent stakes", "10")

        assertEquals("Tent pegs", m.items[0].name)
        assertEquals("8", m.items[0].quantity)
    }

    // ---- moving between sections ----------------------------------------------

    @Test
    fun `moving to the same section writes nothing`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        val before = harness.requestCount
        m.moveToSection("i1", "Gear")

        assertEquals(before, harness.requestCount)
    }

    @Test
    fun `moving into the ungrouped run clears the category`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()
        harness.takeRequest()

        harness.enqueueJson("", status = 204)
        m.moveToSection("i1", null)

        assertNull(m.items.first { it.id == "i1" }.section)
        assertContains(harness.takeRequest().body.readUtf8(), """"category":null""")
    }

    @Test
    fun `a failed move puts the row back in its old section`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueError(500, "ServerError")
        m.moveToSection("i1", "Clothes")

        assertEquals("Gear", m.items.first { it.id == "i1" }.section)
    }

    // ---- removal ---------------------------------------------------------------

    @Test
    fun `a failed delete restores the row`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueError(500, "ServerError")
        m.remove("i1")

        assertEquals(2, m.items.size)
    }

    // ---- search + grouping -----------------------------------------------------

    @Test
    fun `search filters on name, section and quantity`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        m.setSearch("gear")
        assertEquals(listOf("i1"), m.activeSections.flatMap { it.items }.map { it.id })

        m.setSearch("8")
        assertEquals(listOf("i1"), m.activeSections.flatMap { it.items }.map { it.id })

        m.setSearch("sunscreen")
        assertTrue(m.activeSections.flatMap { it.items }.isEmpty())
        assertEquals(listOf("i2"), m.completed.map { it.id })

        m.setSearch("   ")
        assertEquals(1, m.activeSections.flatMap { it.items }.size)
    }

    /**
     * Sharing hands over the whole list, not whatever the sharer typed in the search box —
     * and it is precomputed rather than derived per read, because the Share control
     * recomposes on every one of those keystrokes.
     */
    @Test
    fun `share text covers the whole list regardless of the search box`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        m.setSearch("nothing matches this")

        assertEquals("GEAR\n- Tent pegs (8)", m.shareTextState.value)
        assertEquals("## Gear\n- [ ] Tent pegs (8)", m.shareMarkdownState.value)
    }

    @Test
    fun `grocery groups in aisle walking order, custom lists alphabetically`() = runTest {
        harness.enqueueJson(
            """{"weekStart":"2026-08-16","meals":[],"items":[
                 {"id":"i1","name":"Ice","checked":false,"aisle":"Frozen"},
                 {"id":"i2","name":"Kale","checked":false,"aisle":"Produce"}
               ],"staples":[]}""",
        )
        harness.enqueueJson("""{"stores":[]}""")

        val m = model(grocery())
        m.load()

        assertEquals(listOf("Produce", "Frozen"), m.activeSections.map { it.title })
    }

    @Test
    fun `section and store suggestions merge the known values with what the list uses`() = runTest {
        harness.enqueueJson(
            """{"weekStart":"2026-08-16","meals":[],"items":[
                 {"id":"i1","name":"Charcoal","checked":false,"section":"Seasonal","store":"Ace"}
               ],"staples":[]}""",
        )
        harness.enqueueJson("""{"stores":["Costco"]}""")

        val m = model(grocery())
        m.load()

        assertEquals("Produce", m.sectionSuggestions.first())
        assertContains(m.sectionSuggestions, "Seasonal")
        assertEquals(listOf("Costco", "Ace"), m.storeSuggestions)
    }

    // ---- the week switcher -----------------------------------------------------

    /**
     * The step is always taken from the week the SERVER echoed back, never from a week
     * computed here — a device-derived week snaps to the device's first-day-of-week while
     * the server snaps to the household's.
     */
    @Test
    fun `stepping a week asks for the server's week plus seven days`() = runTest {
        harness.enqueueJson("""{"weekStart":"2026-08-16","meals":[],"items":[],"staples":[]}""")
        harness.enqueueJson("""{"stores":[]}""")
        val m = model(grocery())
        m.load()
        harness.takeRequest()
        harness.takeRequest()

        harness.enqueueJson("""{"weekStart":"2026-08-23","meals":[],"items":[],"staples":[]}""")
        harness.enqueueJson("""{"stores":[]}""")
        m.stepWeek(1)

        assertEquals("/api/lists/grocery/board?weekStart=2026-08-23", harness.takeRequest().path)
        assertEquals(1, m.weekOffset)
    }

    /** "This week" goes back to the server's own current week — null, not a computed date. */
    @Test
    fun `resetting to this week sends no weekStart at all`() = runTest {
        harness.enqueueJson("""{"weekStart":"2026-08-16","meals":[],"items":[],"staples":[]}""")
        harness.enqueueJson("""{"stores":[]}""")
        val m = model(grocery())
        m.load()
        harness.takeRequest()
        harness.takeRequest()

        harness.enqueueJson("""{"weekStart":"2026-08-23","meals":[],"items":[],"staples":[]}""")
        harness.enqueueJson("""{"stores":[]}""")
        m.stepWeek(1)
        harness.takeRequest()
        harness.takeRequest()

        harness.enqueueJson("""{"weekStart":"2026-08-16","meals":[],"items":[],"staples":[]}""")
        harness.enqueueJson("""{"stores":[]}""")
        m.thisWeek()

        assertEquals("/api/lists/grocery/board", harness.takeRequest().path)
        assertEquals(0, m.weekOffset)
        assertNull(m.requestedWeekStart)
    }

    /** A board that hasn't loaded has no week to step from, so a tap must be inert. */
    @Test
    fun `stepping before the board loaded makes no request`() = runTest {
        val m = model(grocery())

        m.stepWeek(1)

        assertEquals(0, harness.requestCount)
        assertEquals(0, m.weekOffset)
    }

    // ---- templates -------------------------------------------------------------

    @Test
    fun `converting to a template flips this screen into template mode in place`() = runTest {
        harness.enqueueJson(twoItems)
        val m = model()
        m.load()

        harness.enqueueJson("""{"template":{"id":"l2","name":"Camping gear","listType":"template"}}""")
        harness.enqueueJson("""{"items":[]}""")
        assertTrue(m.convertToTemplate())

        assertTrue(m.isTemplate)
    }

    @Test
    fun `moving a template back to Lists flips it out of template mode`() = runTest {
        val m = model(ListSummary("t1", "Packing", "📑", "template", 4))

        harness.enqueueJson("""{"list":{"id":"t1","name":"Packing","listType":"custom"}}""")
        assertTrue(m.moveToLists())

        assertFalse(m.isTemplate)
    }

    // ---- the grocery panels ----------------------------------------------------

    @Test
    fun `adding a staple reports the aisle it landed in`() = runTest {
        harness.enqueueJson("""{"weekStart":"2026-08-16","meals":[],"items":[],"staples":[{"id":"s1","name":"Butter"}]}""")
        harness.enqueueJson("""{"stores":[]}""")
        val m = model(grocery())
        m.load()

        harness.enqueueJson("""{"item":{"id":"i9","name":"Butter","checked":false}}""")
        harness.enqueueJson(
            """{"weekStart":"2026-08-16","meals":[],"items":[
                 {"id":"i9","name":"Butter","checked":false,"aisle":"Dairy & Chilled"}
               ],"staples":[]}""",
        )
        harness.enqueueJson("""{"stores":[]}""")

        assertEquals("Dairy & Chilled", m.addStaple("Butter"))
    }

    @Test
    fun `a rebuild reuses the returned board rather than refetching`() = runTest {
        harness.enqueueJson("""{"weekStart":"2026-08-16","meals":[],"items":[],"staples":[]}""")
        harness.enqueueJson("""{"stores":[]}""")
        val m = model(grocery())
        m.load()
        val before = harness.requestCount

        harness.enqueueJson(
            """{"board":{"weekStart":"2026-08-16","meals":[],"staples":[],"items":[
                 {"id":"i1","name":"Onions","checked":false,"aisle":"Produce","source":"auto"}
               ]}}""",
        )
        m.rebuild()

        assertEquals(1, m.items.size)
        assertEquals("Produce", m.items[0].section)
        assertEquals(before + 1, harness.requestCount, "the rebuild reply IS the board — no second round-trip")
    }
}
