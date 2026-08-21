package app.waffled.feature.lists

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

/** The Today "Lists" card — which list it pins, and what it will and won't claim. */
class TodayListModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: ListsApi

    private class FakePin(private var value: String? = null) : TodayListModel.PinStore {
        override fun pinnedListId(): String? = value
        override fun setPinnedListId(id: String) {
            value = id
        }
    }

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

    private val index = """
        {"lists":[
          {"id":"grocery","name":"Groceries","listType":"grocery","itemCount":12},
          {"id":"l2","name":"Camping gear","emoji":"⛺","listType":"custom","itemCount":3},
          {"id":"l3","name":"Hardware run","emoji":"🔩","listType":"custom","itemCount":2}
        ]}
    """.trimIndent()

    private val items = """
        {"items":[
          {"id":"i1","name":"Tent pegs","quantity":"8","checked":false},
          {"id":"i2","name":"Sunscreen","checked":true}
        ]}
    """.trimIndent()

    /**
     * Grocery has its own Today card; offering it here too would be two cards fighting
     * over one list. Templates aren't lists you shop from.
     */
    @Test
    fun `grocery and templates are not pickable`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)

        val m = TodayListModel(api, FakePin())
        m.load()

        assertEquals(listOf("l2", "l3"), m.pickable.map { it.id })
    }

    @Test
    fun `with no pin it falls back to the first pickable list`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)

        val m = TodayListModel(api, FakePin())
        m.load()

        assertEquals("l2", m.active?.id)
    }

    /** A pinned list that has since been deleted must not leave the card blank and stuck. */
    @Test
    fun `a pin pointing at a deleted list falls back`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)

        val m = TodayListModel(api, FakePin("gone"))
        m.load()

        assertEquals("l2", m.active?.id)
    }

    @Test
    fun `a valid pin wins`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)

        val m = TodayListModel(api, FakePin("l3"))
        m.load()

        assertEquals("l3", m.active?.id)
    }

    @Test
    fun `only unfinished rows are shown`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)

        val m = TodayListModel(api, FakePin())
        m.load()

        assertEquals(listOf("i1"), m.open.map { it.id })
    }

    /**
     * "No lists yet" is a claim about the household. When the fetch simply failed we
     * don't know, and the card must say so instead.
     */
    @Test
    fun `a failed fetch is flagged rather than reported as an empty household`() = runTest {
        harness.enqueueError(500, "ServerError")

        val m = TodayListModel(api, FakePin())
        m.load()

        assertTrue(m.failedState.value)
        assertTrue(m.pickable.isEmpty())
        assertTrue(m.loadedState.value)
    }

    @Test
    fun `a genuinely empty household is not flagged as failed`() = runTest {
        harness.enqueueJson("""{"lists":[]}""")

        val m = TodayListModel(api, FakePin())
        m.load()

        assertFalse(m.failedState.value)
        assertTrue(m.pickable.isEmpty())
        assertNull(m.active)
    }

    /** Ticking a row makes it leave at once — the card only ever shows unfinished items. */
    @Test
    fun `checking a row removes it immediately`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)
        val m = TodayListModel(api, FakePin())
        m.load()

        harness.enqueueJson("", status = 204)
        assertTrue(m.check(m.open.first()))

        assertTrue(m.open.isEmpty())
    }

    @Test
    fun `a failed check puts the row back`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)
        val m = TodayListModel(api, FakePin())
        m.load()

        harness.enqueueError(500, "ServerError")
        assertFalse(m.check(m.open.first()))

        assertEquals(listOf("i1"), m.open.map { it.id })
    }

    @Test
    fun `picking another list persists the choice and reloads its items`() = runTest {
        harness.enqueueJson(index)
        harness.enqueueJson(items)
        val pin = FakePin()
        val m = TodayListModel(api, pin)
        m.load()

        harness.enqueueJson("""{"items":[{"id":"i9","name":"Wood screws","checked":false}]}""")
        m.pick("l3")

        assertEquals("l3", pin.pinnedListId())
        assertEquals("l3", m.active?.id)
        assertEquals(listOf("i9"), m.open.map { it.id })
    }
}
