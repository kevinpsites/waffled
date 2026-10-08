package app.waffled.feature.rhythms

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Translated from the decode suites of `RhythmsTests.swift`, plus the wire shape of every route. */
class RhythmsApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: RhythmsApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = RhythmsApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun decodeRhythm(json: String): RhythmsApi.Rhythm =
        WaffledJson.decodeFromString(RhythmsApi.Rhythm.serializer(), json)

    // ---- booking windows ----

    @Test
    fun `a row with a window reports where bookings stop counting`() {
        val r = decodeRhythm(
            """
            {"id":"a","title":"Date night","emoji":null,"notes":null,"personId":null,
             "satisfiedBy":"scheduling","every":"1 mon","startsOn":"2026-09-01",
             "autoSchedule":false,"rrule":null,"bookWithin":"7 days","leadTime":"7 days",
             "lastCompletedAt":null,"nextDueAt":null,"isActive":true,
             "currentPeriodStart":"2026-09-01","currentPeriodEnd":"2026-10-01",
             "currentWindowEnd":"2026-09-08","satisfied":false,"hasSeries":false,
             "bookedAt":null,"bookedAllDay":null}
            """.trimIndent(),
        )
        assertEquals("7 days", r.bookWithin)
        assertEquals("2026-09-08", r.windowEnd)
        assertEquals("2026-10-01", r.currentPeriodEnd)
    }

    @Test
    fun `a row from a server that has never heard of windows still decodes`() {
        val r = decodeRhythm(
            """
            {"id":"a","title":"Temple visit","emoji":null,"notes":null,"personId":null,
             "satisfiedBy":"scheduling","every":"3 mons","startsOn":"2026-07-01",
             "autoSchedule":false,"rrule":null,"leadTime":"14 days",
             "lastCompletedAt":null,"nextDueAt":null,"isActive":true,
             "currentPeriodStart":"2026-07-01","currentPeriodEnd":"2026-10-01",
             "satisfied":false,"hasSeries":false,"bookedAt":null,"bookedAllDay":null}
            """.trimIndent(),
        )
        assertNull(r.bookWithin)
        assertEquals("2026-10-01", r.windowEnd)
    }

    // ---- forward compatibility ----

    @Test
    fun `an unknown satisfiedBy does not throw away the rest of the register`() = runTest {
        harness.enqueueJson(
            """
            {"rhythms":[
              {"id":"a","title":"Air filter","emoji":null,"notes":null,"personId":null,
               "satisfiedBy":"completion","every":"3 mons","startsOn":null,"autoSchedule":false,
               "rrule":null,"leadTime":"14 days","lastCompletedAt":null,"nextDueAt":null,"isActive":true},
              {"id":"b","title":"Something new","emoji":null,"notes":null,"personId":null,
               "satisfiedBy":"measurement","every":"1 week","startsOn":null,"autoSchedule":false,
               "rrule":null,"leadTime":"3 days","lastCompletedAt":null,"nextDueAt":null,"isActive":true}
            ]}
            """.trimIndent(),
        )
        val list = api.rhythms()
        assertEquals("/api/rhythms", harness.takeRequest().path)
        assertEquals(2, list.size)
        assertEquals(RhythmShape.Completion, list[0].shape)
        assertEquals(RhythmShape.Unknown, list[1].shape)
    }

    @Test
    fun `an unknown attention kind does not empty the Today card`() = runTest {
        harness.enqueueJson(
            """
            {"items":[
              {"kind":"due","rhythm":{"id":"a","title":"Air filter","emoji":null,"notes":null,
                "personId":null,"satisfiedBy":"completion","every":"3 mons","startsOn":null,
                "autoSchedule":false,"rrule":null,"leadTime":"14 days","lastCompletedAt":null,
                "nextDueAt":"2026-09-01T00:00:00.000Z","isActive":true},
               "dueAt":"2026-09-01T00:00:00.000Z","overdue":false},
              {"kind":"nudged","rhythm":{"id":"b","title":"Future thing","emoji":null,"notes":null,
                "personId":null,"satisfiedBy":"scheduling","every":"1 week","startsOn":"2026-01-01",
                "autoSchedule":false,"rrule":null,"leadTime":"3 days","lastCompletedAt":null,
                "nextDueAt":null,"isActive":true}}
            ]}
            """.trimIndent(),
        )
        val items = api.attention("2026-08-18", "2026-08-18")
        assertEquals("/api/rhythms/attention?from=2026-08-18&to=2026-08-18", harness.takeRequest().path)
        assertEquals(2, items.size)
        assertEquals(AttentionKind.Due, items[0].kind)
        assertEquals(AttentionKind.Unknown, items[1].kind)
    }

    @Test
    fun `an attention payload decodes both kinds off the one route`() = runTest {
        harness.enqueueJson(
            """
            { "items": [
              { "kind": "due",
                "rhythm": { "id": "r1", "title": "Air filter", "emoji": null, "notes": null,
                            "personId": null, "satisfiedBy": "completion", "every": "3 mons",
                            "startsOn": null, "autoSchedule": false, "rrule": null,
                            "leadTime": "14 days", "lastCompletedAt": null,
                            "nextDueAt": "2026-08-20T09:00:00.000Z", "isActive": true },
                "dueAt": "2026-08-20T09:00:00.000Z", "overdue": false },
              { "kind": "unscheduled",
                "rhythm": { "id": "r2", "title": "Temple visit", "emoji": "🛕", "notes": "Bring flowers",
                            "personId": "p1", "satisfiedBy": "scheduling", "every": "3 mons",
                            "startsOn": "2026-01-01", "autoSchedule": false, "rrule": null,
                            "leadTime": "14 days", "lastCompletedAt": null, "nextDueAt": null,
                            "isActive": true },
                "periodStart": "2026-07-01", "periodEnd": "2026-10-01" }
            ] }
            """.trimIndent(),
        )
        val items = api.attention("2026-08-18", "2026-08-18")
        assertEquals(AttentionKind.Due, items[0].kind)
        assertEquals(false, items[0].overdue)
        assertEquals(AttentionKind.Unscheduled, items[1].kind)
        assertEquals("2026-10-01", items[1].periodEnd)
        assertEquals("2026-10-01", items[1].bookableUntil)
        assertEquals("🛕", items[1].rhythm.emoji)
    }

    @Test
    fun `the list route's per-period extras decode, and a single-row read without them still does`() = runTest {
        harness.enqueueJson(
            """
            { "rhythms": [
              { "id": "r2", "title": "Temple visit", "emoji": null, "notes": null, "personId": null,
                "satisfiedBy": "scheduling", "every": "3 mons", "startsOn": "2026-01-01",
                "autoSchedule": false, "rrule": null, "leadTime": "14 days",
                "lastCompletedAt": null, "nextDueAt": null, "isActive": true,
                "currentPeriodStart": "2026-07-01", "currentPeriodEnd": "2026-10-01", "satisfied": true }
            ] }
            """.trimIndent(),
        )
        val list = api.rhythms()
        assertEquals("2026-10-01", list[0].currentPeriodEnd)
        assertEquals(true, list[0].satisfied)

        harness.enqueueJson(
            """
            { "rhythm": { "id": "r1", "title": "Air filter", "emoji": null, "notes": null,
                          "personId": null, "satisfiedBy": "completion", "every": "3 mons",
                          "startsOn": null, "autoSchedule": false, "rrule": null,
                          "leadTime": "14 days", "lastCompletedAt": null, "nextDueAt": null,
                          "isActive": true } }
            """.trimIndent(),
            status = 201,
        )
        val created = api.create(buildJsonObject { put("title", "Air filter") })
        assertNull(created.satisfied)
    }

    @Test
    fun `a completion history decodes, average and all`() = runTest {
        harness.enqueueJson(
            """
            {"completions":[
               {"id":"c2","personId":null,"completedAt":"2026-05-16T09:00:00.000Z","notes":"3-pack"},
               {"id":"c1","personId":null,"completedAt":"2026-01-20T09:00:00.000Z","notes":null}],
             "total":2,"averageIntervalDays":116.5}
            """.trimIndent(),
        )
        val h = api.completions("r1", limit = 5)
        assertEquals("/api/rhythms/r1/completions?limit=5", harness.takeRequest().path)
        assertEquals(2, h.total)
        assertEquals(2, h.completions.size)
        assertEquals(116.5, h.averageIntervalDays)
        assertEquals("3-pack", h.completions[0].notes)
    }

    @Test
    fun `a history with one completion reports no average rather than inventing one`() = runTest {
        harness.enqueueJson(
            """
            {"completions":[{"id":"c1","personId":null,"completedAt":"2026-05-16T09:00:00.000Z","notes":null}],
             "total":1,"averageIntervalDays":null}
            """.trimIndent(),
        )
        val h = api.completions("r1")
        assertEquals("/api/rhythms/r1/completions", harness.takeRequest().path)
        assertEquals(1, h.total)
        assertNull(h.averageIntervalDays)
    }

    // ---- writes, asserted on the wire ----

    private val single = """
        { "rhythm": { "id": "r1", "title": "Air filter", "satisfiedBy": "completion",
          "every": "3 mons", "autoSchedule": false, "leadTime": "14 days", "isActive": true } }
    """.trimIndent()

    @Test
    fun `completing now sends an empty body, backdating sends the instant`() = runTest {
        harness.enqueueJson(single)
        api.complete("r1", completedAt = null)
        val now = harness.takeRequest()
        assertEquals("POST", now.method)
        assertEquals("/api/rhythms/r1/complete", now.path)
        assertEquals("{}", now.body.readUtf8())

        harness.enqueueJson(single)
        api.complete("r1", completedAt = "2026-08-14T12:00:00Z")
        val back = WaffledJson.parseToJsonElement(harness.takeRequest().body.readUtf8()).jsonObject
        assertEquals(JsonPrimitive("2026-08-14T12:00:00Z"), back["completedAt"])
    }

    @Test
    fun `booking posts the instant, the all-day flag and the period it is meant to fill`() = runTest {
        harness.enqueueJson("""{"event":{"id":"e1","title":"Temple visit"}}""", status = 201)
        val id = api.schedule("r2", startsAt = "2026-08-20T18:00:00Z", allDay = false, periodStart = "2026-07-01")
        assertEquals("e1", id)
        val req = harness.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/rhythms/r2/schedule", req.path)
        val body = WaffledJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(JsonPrimitive("2026-08-20T18:00:00Z"), body["startsAt"])
        assertEquals(JsonPrimitive(false), body["allDay"])
        assertEquals(JsonPrimitive("2026-07-01"), body["periodStart"])
    }

    @Test
    fun `skipping posts the period start`() = runTest {
        harness.enqueueJson("""{"ok":true}""")
        api.skip("r2", "2026-07-01")
        val req = harness.takeRequest()
        assertEquals("/api/rhythms/r2/skip", req.path)
        val body = WaffledJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(JsonPrimitive("2026-07-01"), body["periodStart"])
    }

    @Test
    fun `a PATCH that clears the booking window puts an explicit null on the wire`() = runTest {
        harness.enqueueJson(single)
        api.update("r1", buildJsonObject { put("title", "Date night"); put("bookWithin", JsonNull) })
        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/rhythms/r1", req.path)
        assertTrue(req.body.readUtf8().contains("\"bookWithin\":null"))
    }

    @Test
    fun `deleting answers 204`() = runTest {
        harness.enqueueNoContent()
        api.delete("r1")
        val req = harness.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/rhythms/r1", req.path)
        assertFalse(harness.requestCount > 1)
    }
}
