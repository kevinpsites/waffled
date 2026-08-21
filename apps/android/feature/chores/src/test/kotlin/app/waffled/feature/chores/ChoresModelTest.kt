package app.waffled.feature.chores

import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The board's state machine, driven against a real MockWebServer.
 *
 * The model's methods are plain `suspend` functions (not `viewModelScope.launch` calls)
 * precisely so the whole thing is drivable from a JVM test with no main-dispatcher rule
 * — the same shape as `PhotosModel`.
 */
class ChoresModelTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var bus: RefreshBus

    private val zone: ZoneId = ZoneId.of("America/New_York")
    private val today = LocalDate.of(2026, 8, 21)

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        bus = RefreshBus()
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun model(date: String = "2026-08-21") = ChoresModel(
        api = ChoresApi(client, harness.tokens),
        baseUrl = harness.baseUrl(),
        initialDate = date,
        zone = zone,
        locale = Locale.US,
        refreshBus = bus,
        clock = { today },
    )

    private fun instanceJson(
        id: String,
        title: String = "Chore $id",
        status: String = "pending",
        personId: String? = null,
        dueTime: String? = null,
        dueOn: String? = null,
        requiresApproval: Boolean = false,
        requiresPhoto: Boolean = false,
        proofUrl: String? = null,
    ): String = buildString {
        append("""{"id":"$id","choreId":"c-$id","choreTitle":"$title","status":"$status"""")
        append(""","requiresApproval":$requiresApproval,"requiresPhoto":$requiresPhoto""")
        if (personId != null) append(""","personId":"$personId"""")
        if (dueTime != null) append(""","dueTime":"$dueTime"""")
        if (dueOn != null) append(""","dueOn":"$dueOn"""")
        if (proofUrl != null) append(""","proofUrl":"$proofUrl","hadProof":true""")
        append("}")
    }

    private fun enqueueDay(vararg instances: String) {
        harness.enqueueJson("""{"instances":[${instances.joinToString(",")}]}""")
    }

    // ---- loading -----------------------------------------------------------------

    @Test
    fun `load sorts the day and precomputes every row label`() = runTest {
        enqueueDay(
            instanceJson("a", title = "Evening", dueTime = "18:00"),
            instanceJson("b", title = "Morning", dueTime = "07:30", dueOn = "2026-08-19"),
            instanceJson("c", title = "Yesterday's done", status = "done"),
        )
        val model = model()

        model.load()

        val rows = model.rows
        assertEquals(listOf("Morning", "Evening", "Yesterday's done"), rows.map { it.title })
        // Labels are computed ONCE here, not per recomposition — the documented iOS
        // performance trap.
        assertEquals("since Wed", rows.first().overdueLabel)
        assertNotNull(rows.first().dueTimeLabel)
        assertNull(rows[1].overdueLabel)
    }

    @Test
    fun `load resolves a proof photo to an absolute url keyed on the storage path`() = runTest {
        enqueueDay(instanceJson("a", status = "awaiting", proofUrl = "/media/ab/cd.jpg?sig=expiring"))
        val model = model()

        model.load()

        val row = model.rows.single()
        assertEquals("${harness.baseUrl()}/media/ab/cd.jpg?sig=expiring", row.proofImageUrl)
        // Cache on the storage PATH, never the signed URL — a signed URL is an expiry
        // mechanism, not an identity, and keying on it means the cache never hits.
        assertEquals("/media/ab/cd.jpg", row.proofCacheKey)
    }

    @Test
    fun `a failed load keeps the rows we already had and flags the error`() = runTest {
        enqueueDay(instanceJson("a", title = "Feed the dog"))
        val model = model()
        model.load()

        harness.enqueueError(500, "ServerError")
        model.load()

        assertEquals(listOf("Feed the dog"), model.rows.map { it.title })
        assertTrue(model.error)
        assertTrue(model.loaded)
    }

    @Test
    fun `stepping a day refetches for the new date`() = runTest {
        enqueueDay()
        val model = model()
        model.load()
        harness.takeRequest()

        enqueueDay()
        model.shift(1)

        assertEquals("2026-08-22", model.date.value)
        assertEquals("/api/chore-instances/today?date=2026-08-22", harness.takeRequest().path)
    }

    @Test
    fun `jump to today returns to the device's day`() = runTest {
        enqueueDay()
        val model = model(date = "2026-08-25")

        enqueueDay()
        model.goToday()

        assertEquals("2026-08-21", model.date.value)
    }

    // ---- columns -----------------------------------------------------------------

    @Test
    fun `columns lead with up for grabs then the household in order`() = runTest {
        enqueueDay(
            instanceJson("a", personId = "p2"),
            instanceJson("b"),
            instanceJson("c", personId = "p1"),
        )
        val model = model()
        model.load()

        val columns = ChoreColumns.build(
            model.rows,
            listOf(person("p1", "Elaine"), person("p2", "Kramer")),
        )

        assertEquals(listOf("Up for grabs", "Elaine", "Kramer"), columns.map { it.name })
        assertTrue(columns.first().isGrabs)
        assertEquals(listOf("b"), columns[0].items.map { it.id })
        assertEquals(listOf("c"), columns[1].items.map { it.id })
    }

    @Test
    fun `up for grabs leads even when it is empty`() = runTest {
        // It always needs a home, so anyone-can-claim chores have somewhere to be added.
        enqueueDay(instanceJson("a", personId = "p1"))
        val model = model()
        model.load()

        val columns = ChoreColumns.build(model.rows, listOf(person("p1", "Elaine")))

        assertTrue(columns.first().isGrabs)
        assertTrue(columns.first().items.isEmpty())
    }

    @Test
    fun `a chore assigned to someone outside the member list still gets a column`() = runTest {
        enqueueDay(instanceJson("a", personId = "ghost"))
        val model = model()
        model.load()

        val columns = ChoreColumns.build(model.rows, emptyList())

        assertEquals(2, columns.size)
        assertEquals("ghost", columns[1].id)
    }

    @Test
    fun `a column counts how many of its chores are done`() = runTest {
        enqueueDay(
            instanceJson("a", personId = "p1", status = "done"),
            instanceJson("b", personId = "p1"),
        )
        val model = model()
        model.load()

        val column = ChoreColumns.build(model.rows, listOf(person("p1", "Elaine")))[1]

        assertEquals(1, column.done)
        assertEquals(2, column.items.size)
    }

    // ---- writes ------------------------------------------------------------------

    @Test
    fun `ticking an approval-required chore shows awaiting immediately`() = runTest {
        enqueueDay(instanceJson("a", requiresApproval = true))
        val model = model()
        model.load()

        harness.enqueueJson("{}")                                          // complete
        enqueueDay(instanceJson("a", status = "awaiting", requiresApproval = true)) // reload
        model.toggle(model.rows.single())

        assertEquals("awaiting", model.rows.single().status)
    }

    @Test
    fun `a failed tick puts the row back the way it was`() = runTest {
        enqueueDay(instanceJson("a"))
        val model = model()
        model.load()

        harness.enqueueError(500, "ServerError")
        model.toggle(model.rows.single())

        assertEquals("pending", model.rows.single().status)
    }

    @Test
    fun `every write tells the rest of the app chores changed`() = runTest {
        // Chores are not synced, so nothing else would ever hear about the change.
        enqueueDay(instanceJson("a"))
        val model = model()
        model.load()
        val before = bus.revisionOf(RefreshDomain.Chores)

        harness.enqueueJson("{}")
        enqueueDay(instanceJson("a", status = "done"))
        model.toggle(model.rows.single())

        assertTrue(bus.revisionOf(RefreshDomain.Chores) > before)
    }

    @Test
    fun `assigning a chore to the person who already has it is a no-op`() = runTest {
        enqueueDay(instanceJson("a", personId = "p1"))
        val model = model()
        model.load()
        val requestsBefore = harness.requestCount

        model.assign("a", personId = "p1")

        assertEquals(requestsBefore, harness.requestCount)
    }

    @Test
    fun `unassigning a chore that is already up for grabs is a no-op`() = runTest {
        enqueueDay(instanceJson("a"))
        val model = model()
        model.load()
        val requestsBefore = harness.requestCount

        model.unassign("a")

        assertEquals(requestsBefore, harness.requestCount)
    }

    @Test
    fun `claiming an up-for-grabs chore claims then completes it`() = runTest {
        enqueueDay(instanceJson("a"))
        val model = model()
        model.load()
        harness.takeRequest()

        harness.enqueueJson("{}") // claim
        harness.enqueueJson("{}") // complete
        enqueueDay(instanceJson("a", status = "done", personId = "p1"))
        model.claimComplete("a", personId = "p1")

        assertEquals("/api/chore-instances/a/claim", harness.takeRequest().path)
        assertEquals("/api/chore-instances/a/complete", harness.takeRequest().path)
    }

    // ---- photo proof --------------------------------------------------------------

    @Test
    fun `finishing with a photo uploads it then completes with the storage key`() = runTest {
        enqueueDay(instanceJson("a", requiresPhoto = true))
        val model = model()
        model.load()
        harness.takeRequest()

        harness.enqueueJson("""{"key":"blob-1","url":"/media/x.jpg","contentType":"image/jpeg"}""")
        harness.enqueueJson("{}")
        enqueueDay(instanceJson("a", status = "done", requiresPhoto = true))
        model.completeWithProof("a", base64 = "QUJD", contentType = "image/jpeg")

        assertEquals("/api/media", harness.takeRequest().path)
        val complete = harness.takeRequest()
        assertEquals("/api/chore-instances/a/complete", complete.path)
        assertTrue(complete.body.readUtf8().contains("blob-1"))
        assertNull(model.proofError.value)
    }

    @Test
    fun `an up-for-grabs photo chore claims the person before completing`() = runTest {
        enqueueDay(instanceJson("a", requiresPhoto = true))
        val model = model()
        model.load()
        harness.takeRequest()

        harness.enqueueJson("""{"key":"blob-1","url":"/media/x.jpg","contentType":"image/jpeg"}""")
        harness.enqueueJson("{}") // claim
        harness.enqueueJson("{}") // complete
        enqueueDay(instanceJson("a", status = "done", personId = "p1", requiresPhoto = true))
        model.completeWithProof("a", base64 = "QUJD", contentType = "image/jpeg", claimFor = "p1")

        assertEquals("/api/media", harness.takeRequest().path)
        assertEquals("/api/chore-instances/a/claim", harness.takeRequest().path)
        assertEquals("/api/chore-instances/a/complete", harness.takeRequest().path)
    }

    @Test
    fun `the 422 proof guard reads as a plain sentence, not an error code`() = runTest {
        enqueueDay(instanceJson("a", requiresPhoto = true))
        val model = model()
        model.load()

        harness.enqueueJson("""{"key":"blob-1","url":"/media/x.jpg","contentType":"image/jpeg"}""")
        harness.enqueueError(422, "ProofRequired")
        model.completeWithProof("a", base64 = "QUJD", contentType = "image/jpeg")

        assertEquals("A photo is required to finish this chore.", model.proofError.value)
    }

    @Test
    fun `a failed upload relays what the server said`() = runTest {
        enqueueDay(instanceJson("a", requiresPhoto = true))
        val model = model()
        model.load()

        harness.enqueueError(413, "PayloadTooLarge", "That photo is too big.")
        model.completeWithProof("a", base64 = "QUJD", contentType = "image/jpeg")

        assertEquals("That photo is too big.", model.proofError.value)
    }

    // ---- the editor ----------------------------------------------------------------

    @Test
    fun `saving a chore returns null on success and reloads the day`() = runTest {
        enqueueDay()
        val model = model()
        model.load()
        harness.takeRequest()

        harness.enqueueJson("{}")
        enqueueDay(instanceJson("new", title = "Feed the dog"))
        val error = model.save(choreId = null, body = ChoreDraft(title = "Feed the dog").toBody(currencyCount = 1))

        assertNull(error)
        assertEquals("/api/chores", harness.takeRequest().path)
        assertEquals(listOf("Feed the dog"), model.rows.map { it.title })
    }

    @Test
    fun `a non-parent saving a chore is told to switch, not shown a status code`() = runTest {
        enqueueDay()
        val model = model()
        model.load()

        harness.enqueueError(403, "Forbidden", "Admin only")
        val error = model.save(choreId = null, body = ChoreDraft(title = "Feed the dog").toBody(currencyCount = 1))

        assertEquals(
            "Only a parent can add or edit chores. Switch to a parent to make changes.",
            error,
        )
    }

    @Test
    fun `approving drops the row from the queue and refreshes the board`() = runTest {
        enqueueDay(instanceJson("a", status = "awaiting"))
        val model = model()
        model.load()
        harness.enqueueJson("""{"instances":[${instanceJson("a", status = "awaiting")}]}""")
        model.loadAwaiting()
        assertEquals(1, model.awaiting.value.size)

        harness.enqueueJson("{}")                                  // approve
        enqueueDay(instanceJson("a", status = "done"))             // board reload
        harness.enqueueJson("""{"instances":[]}""")                // awaiting reload
        model.approve("a")

        assertTrue(model.awaiting.value.isEmpty())
        assertEquals("done", model.rows.single().status)
    }

    @Test
    fun `a failed approval puts the row back in the queue`() {
        // The optimistic drop must not outlive a failed decision: a parent seeing the
        // item vanish from "Needs your OK" would believe they had approved it.
        runTest {
            enqueueDay()
            val model = model()
            harness.enqueueJson("""{"instances":[${instanceJson("a", status = "awaiting")}]}""")
            model.loadAwaiting()

            harness.enqueueError(500, "ServerError")                                        // approve
            harness.enqueueJson("""{"instances":[${instanceJson("a", status = "awaiting")}]}""") // queue reload
            model.approve("a")

            assertEquals(listOf("a"), model.awaiting.value.map { it.id })
        }
    }

    private fun person(id: String, name: String) = Person(id = id, name = name)
}
