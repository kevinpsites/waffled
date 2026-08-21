package app.waffled.feature.lists

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The Lists index state machine. */
class ListsIndexModelTest {

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

    private fun model() = ListsIndexModel(api, bus)

    private val index = """
        {"lists":[
          {"id":"grocery","name":"Groceries","emoji":"🛒","listType":"grocery","itemCount":12},
          {"id":"l2","name":"Camping gear","emoji":"⛺","listType":"custom","itemCount":7}
        ]}
    """.trimIndent()

    @Test
    fun `load fetches the rail and the templates`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson("""{"templates":[{"id":"t1","name":"Packing","listType":"template","itemCount":4}]}""")

        val m = model()
        m.load()

        assertEquals(listOf("grocery", "l2"), m.lists.map { it.id })
        assertEquals(listOf("t1"), m.templates.map { it.id })
        assertFalse(m.loadingState.value)
        assertFalse(m.errorState.value)
    }

    /**
     * Templates are a secondary group. An older server that has no templates route must
     * not take the whole index down with it.
     */
    @Test
    fun `a failed templates fetch still leaves the rail loaded`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueError(404, "NotFound")

        val m = model()
        m.load()

        assertEquals(2, m.lists.size)
        assertTrue(m.templates.isEmpty())
        assertFalse(m.errorState.value)
    }

    @Test
    fun `a failed index fetch is an error, not an empty household`() = runTest {
        harness.enqueueError(500, "ServerError")
        harness.enqueueError(500, "ServerError")

        val m = model()
        m.load()

        assertTrue(m.errorState.value)
        assertTrue(m.lists.isEmpty())
    }

    /**
     * The row may have been created even if decoding the reply hiccuped, so the index
     * reloads either way — otherwise the new list wouldn't show without a manual refresh.
     */
    @Test
    fun `create reloads the index even when the create reply fails`() = runTest {
        harness.enqueueError(500, "ServerError")
        harness.enqueueJson(index)
        harness.enqueueJson("""{"templates":[]}""")

        val m = model()
        val created = m.create("Beach trip", "🏖️")

        assertNull(created)
        assertEquals(2, m.lists.size)
    }

    @Test
    fun `create returns the new list so the caller can open it`() = runTest {
        harness.enqueueJson("""{"list":{"id":"l9","name":"Beach trip","emoji":"🏖️","listType":"custom"}}""")
        harness.enqueueJson(index)
        harness.enqueueJson("""{"templates":[]}""")

        val m = model()
        val created = m.create("Beach trip", "🏖️")

        assertEquals("l9", created?.id)
        assertTrue(bus.revisionOf(RefreshDomain.Lists) > 0)
    }

    @Test
    fun `an empty name is not a list`() = runTest {
        val m = model()

        assertNull(m.create("   ", "🏖️"))
        assertEquals(0, harness.requestCount)
    }

    @Test
    fun `delete is optimistic and restores the row when the write fails`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson("""{"templates":[]}""")
        val m = model()
        m.load()

        harness.enqueueError(500, "ServerError")
        m.delete(m.lists.first { it.id == "l2" })

        assertEquals(2, m.lists.size)
        assertTrue(m.errorState.value)
    }

    @Test
    fun `a successful delete leaves the row gone`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson("""{"templates":[]}""")
        val m = model()
        m.load()

        harness.enqueueJson("", status = 204)
        m.delete(m.lists.first { it.id == "l2" })

        assertEquals(listOf("grocery"), m.lists.map { it.id })
    }

    @Test
    fun `applying a template returns the fresh list and reloads the rail`() = runTest {
        harness.enqueueJson("""{"list":{"id":"l9","name":"Beach trip","listType":"custom"}}""")
        harness.enqueueJson(index)
        harness.enqueueJson("""{"templates":[]}""")

        val m = model()
        val created = m.applyTemplate(ListSummary("t1", "Packing", "📑", "template", 4), "Beach trip")

        assertEquals("l9", created?.id)
        assertEquals(2, m.lists.size)
    }

    @Test
    fun `deleting a template is optimistic and restores on failure`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson("""{"templates":[{"id":"t1","name":"Packing","listType":"template"}]}""")
        val m = model()
        m.load()

        harness.enqueueError(500, "ServerError")
        m.deleteTemplate(m.templates.first())

        assertEquals(1, m.templates.size)
    }
}
