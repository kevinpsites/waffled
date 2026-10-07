package app.waffled.feature.familynight

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FamilyNightApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: FamilyNightApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = FamilyNightApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    @Test
    fun `the card read decodes parts, members and what each part is`() = runTest {
        harness.enqueueJson(
            """
            {"config":{"parts":[{"id":"treat","label":"Treat","emoji":"🍦","rotates":true}],
                       "dayOfWeek":5,"time":"19:00","rotationOrder":null,"eventId":null},
             "members":[{"id":"p1","name":"Avery","color":"#2F7FED","emoji":"🦊"}],
             "next":{"date":"2026-07-31","occurrenceId":null,"theme":"Pizza","notes":null,"status":"planned",
                     "assignments":[{"partId":"treat","label":"Treat","emoji":"🍦","detail":"the good ice cream",
                                     "personId":"p1","personName":"Avery","suggested":true}]}}
            """.trimIndent(),
        )
        val v = api.view()
        assertEquals("/api/family-night", harness.takeRequest().path)
        assertNull(v.config.eventId)
        assertEquals("Pizza", v.next.theme)
        val a = v.next.assignments.single()
        assertEquals("the good ice cream", a.detail)
        assertTrue(a.suggested)
        assertEquals("🦊", v.members.single().emoji)
    }

    @Test
    fun `config writes are PUT and unwrap the confirmed config`() = runTest {
        harness.enqueueJson("""{"config":{"parts":[],"dayOfWeek":3,"time":"18:30"}}""")
        val c = api.setConfig(FamilyNightBodies.schedule(day = 3, time = "18:30"))
        assertEquals(3, c.dayOfWeek)
        val req = harness.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/family-night/config", req.path)
        assertEquals("""{"dayOfWeek":3,"time":"18:30"}""", req.body.readUtf8())
    }

    @Test
    fun `schedule and unschedule hit the standing-series route`() = runTest {
        harness.enqueueJson("""{"eventId":"ev-9"}""")
        assertEquals("ev-9", api.schedule())
        val post = harness.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("/api/family-night/schedule", post.path)

        harness.enqueueNoContent()
        api.unschedule()
        val del = harness.takeRequest()
        assertEquals("DELETE", del.method)
        assertEquals("/api/family-night/schedule", del.path)
    }

    @Test
    fun `occurrence writes post the body as given`() = runTest {
        harness.enqueueJson("""{"id":"occ-1"}""")
        assertEquals("occ-1", api.saveOccurrence(FamilyNightBodies.pin("2026-07-31", "treat", null)))
        val req = harness.takeRequest()
        assertEquals("/api/family-night/occurrence", req.path)
        assertEquals(
            """{"date":"2026-07-31","assignments":[{"partId":"treat","personId":null}]}""",
            req.body.readUtf8(),
        )
    }

    // ---- body presence rules: the server reads whether a KEY was sent ----

    @Test
    fun `a pin always carries personId, null meaning nobody yet`() {
        val a = FamilyNightBodies.pin("2026-07-31", "treat", null)["assignments"]!!.jsonArray[0].jsonObject
        assertEquals(JsonNull, a["personId"])
        val b = FamilyNightBodies.pin("2026-07-31", "treat", "p1")["assignments"]!!.jsonArray[0].jsonObject
        assertEquals(JsonPrimitive("p1"), b["personId"])
    }

    @Test
    fun `a detail write carries no personId key`() {
        val body = FamilyNightBodies.setDetail("2026-07-31", "treat", "the good ice cream")
        val a = body["assignments"]!!.jsonArray[0].jsonObject
        assertEquals(setOf("partId", "detail"), a.keys)
        assertEquals(JsonPrimitive(""), FamilyNightBodies.setDetail("d", "p", "")["assignments"]!!.jsonArray[0].jsonObject["detail"])
    }

    @Test
    fun `theme, status and link bodies`() {
        assertEquals("""{"date":"d","theme":""}""", FamilyNightBodies.setTheme("d", "").toString())
        assertEquals("""{"date":"d","status":"skipped"}""", FamilyNightBodies.setStatus("d", "skipped").toString())
        assertEquals("""{"date":"d","eventId":null}""", FamilyNightBodies.linkEvent("d", null).toString())
        assertEquals("""{"date":"d","eventId":"e1"}""", FamilyNightBodies.linkEvent("d", "e1").toString())
    }

    @Test
    fun `add to calendar sends what the sheet confirmed in one call`() {
        val body = FamilyNightBodies.addEvent("2026-07-31", "🏡 Pizza", "18:30", 90)
        assertEquals(
            """{"date":"2026-07-31","createEvent":true,"event":{"title":"🏡 Pizza","time":"18:30","durationMin":90}}""",
            body.toString(),
        )
    }

    @Test
    fun `the event sheet opens on the theme and caps the title`() {
        assertEquals("🏡 Family Night", FamilyNightBodies.defaultEventTitle(null))
        assertEquals("🏡 Family Night", FamilyNightBodies.defaultEventTitle("   "))
        assertEquals("🏡 Pizza", FamilyNightBodies.defaultEventTitle(" Pizza "))
        assertEquals(200, FamilyNightBodies.limitEventTitle("x".repeat(250)).length)
    }

    // ---- formatting ----

    @Test
    fun `date and weekday labels`() {
        assertEquals("Mon, Jun 8", FamilyNightFormat.dateLabel("2026-06-08"))
        assertEquals("garbage", FamilyNightFormat.dateLabel("garbage"))
        assertEquals("Sunday", FamilyNightFormat.weekday(0))
        assertEquals("Saturday", FamilyNightFormat.weekday(-1))
        assertEquals("Monday", FamilyNightFormat.weekday(8))
    }

    @Test
    fun `time labels read as clock times`() {
        val prior = Locale.getDefault()
        Locale.setDefault(Locale.US)
        try {
            assertEquals("7:00 PM", FamilyNightFormat.timeLabel("19:00"))
            assertEquals("12:30 AM", FamilyNightFormat.timeLabel("00:30"))
            assertEquals("soon", FamilyNightFormat.timeLabel("soon"))
        } finally {
            Locale.setDefault(prior)
        }
    }

    @Test
    fun `hh-mm round-trips through minutes`() {
        assertEquals(19 * 60 + 5, FamilyNightFormat.minutes("19:05"))
        assertEquals(19 * 60, FamilyNightFormat.minutes("nope"))
        assertEquals("07:05", FamilyNightFormat.hhmm(7 * 60 + 5))
        assertFalse(FamilyNightFormat.hhmm(0).isEmpty())
    }

    @Test
    fun `decoding tolerates a server that omits detail`() {
        val a = WaffledJson.decodeFromString(
            FamilyNightApi.Assignment.serializer(),
            """{"partId":"x","label":"X","emoji":"⭐","personId":null,"personName":null,"suggested":true}""",
        )
        assertNull(a.detail)
    }
}
