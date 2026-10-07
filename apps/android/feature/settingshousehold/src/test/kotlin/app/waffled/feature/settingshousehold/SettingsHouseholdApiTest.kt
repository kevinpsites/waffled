package app.waffled.feature.settingshousehold

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Every route the household panels call, against a real MockWebServer. */
class SettingsHouseholdApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: SettingsHouseholdApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = SettingsHouseholdApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun sentBody(): Pair<String, JsonObject> {
        val r = harness.takeRequest()
        val text = r.body.readUtf8()
        return "${r.method} ${r.path}" to WaffledJson.parseToJsonElement(text.ifEmpty { "{}" }).jsonObject
    }

    // ---- AI & Capture ----

    @Test
    fun readsTheCaptureConfig() = runTest {
        harness.enqueueJson(
            """{"provider":"ollama","model":null,"available":{"ollama":true,"anthropic":false},
               "defaultModels":{"ollama":"llama3"}}""",
        )
        val c = api.captureConfig()
        assertEquals("ollama", c.provider)
        assertNull(c.model)
        assertEquals(true, c.available["ollama"])
        assertEquals("GET /api/capture/config", harness.takeRequest().let { "${it.method} ${it.path}" })
    }

    // A null model means "use the provider default" and must reach the server as null.
    @Test
    fun savingTheProviderSendsAnExplicitNullModel() = runTest {
        harness.enqueueJson("""{"provider":"heuristic","model":null}""")
        val r = api.setCaptureConfig("heuristic", null)
        assertEquals("heuristic", r.provider)
        val (line, body) = sentBody()
        assertEquals("PUT /api/capture/config", line)
        assertEquals(JsonNull, body["model"])
        assertEquals(JsonPrimitive("heuristic"), body["provider"])
    }

    @Test
    fun listsAndRemovesIgnoredWords() = runTest {
        harness.enqueueJson(
            """{"groups":[{"goalId":"g1","goalTitle":"Host 30 families","goalEmoji":null,"words":["thaw","salmon"]}]}""",
        )
        val groups = api.goalSuggestionIgnores()
        assertEquals(listOf("Host 30 families"), groups.map { it.goalTitle })
        assertEquals(listOf("thaw", "salmon"), groups.first().words)
        assertEquals("g1", groups.first().id)
        assertEquals("/api/goal-calendar/ignores", harness.takeRequest().path)

        harness.enqueueNoContent()
        api.removeGoalSuggestionIgnore("g1", "thaw")
        val (line, body) = sentBody()
        assertEquals("POST /api/goal-calendar/ignores/remove", line)
        assertEquals(JsonPrimitive("g1"), body["goalId"])
        assertEquals(JsonPrimitive("thaw"), body["word"])
    }

    // ---- Calendars ----

    @Test
    fun calendarStatusUsesTheLegacyGooglePath() = runTest {
        harness.enqueueJson("""{"configured":false,"connected":false,"accounts":[],"calendars":[]}""")
        api.calendarStatus()
        assertEquals("/api/calendar/google/status", harness.takeRequest().path)
    }

    @Test
    fun patchingACalendarCanClearItsPerson() = runTest {
        harness.enqueueNoContent()
        api.updateCalendarLink("c1", buildJsonObject { put("personId", JsonNull) })
        val (line, body) = sentBody()
        assertEquals("PATCH /api/calendar/google/calendars/c1", line)
        assertEquals(JsonNull, body["personId"])
    }

    @Test
    fun disconnectAndFeedRoutes() = runTest {
        harness.enqueueNoContent()
        api.disconnectCalendarAccount("a1")
        assertEquals("DELETE /api/calendar/google/accounts/a1", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueJson("""{"feed":{}}""")
        api.createIcsFeed(url = "https://x/a.ics", name = null, personId = null, visibility = "family")
        val (line, body) = sentBody()
        assertEquals("POST /api/calendar/feeds", line)
        assertEquals(JsonNull, body["name"])
        assertEquals(JsonNull, body["personId"])
        assertEquals(JsonPrimitive("family"), body["visibility"])

        harness.enqueueNoContent()
        api.updateIcsFeed("f1", IcsFeedForm.updateBody("https://x/a.ics", "", null, false))
        val (patchLine, patchBody) = sentBody()
        assertEquals("PATCH /api/calendar/feeds/f1", patchLine)
        assertEquals(JsonNull, patchBody["name"])

        harness.enqueueNoContent()
        api.deleteIcsFeed("f1")
        assertEquals("DELETE /api/calendar/feeds/f1", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueJson("""{"imported":2,"updated":1,"deleted":0,"error":null}""")
        val r = api.syncIcsFeed("f1")
        assertEquals(2, r.imported)
        assertNull(r.error)
        assertEquals("POST /api/calendar/feeds/f1/sync", harness.takeRequest().let { "${it.method} ${it.path}" })
    }

    @Test
    fun syncAndConnect() = runTest {
        harness.enqueueJson("""{"imported":1,"updated":0,"deleted":0,"calendars":[{"summary":"A","error":"bad"}]}""")
        assertEquals(listOf("bad"), api.syncCalendars().errors)
        assertEquals("POST /api/calendar/sync", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueJson("""{"url":"https://accounts.example/consent"}""")
        val url = api.connectCalendarUrl(CalendarProvider.Microsoft, "waffled://calendar-connected")
        assertEquals("https://accounts.example/consent", url)
        val (line, body) = sentBody()
        assertEquals("POST /api/calendar/microsoft/connect", line)
        assertEquals(JsonPrimitive("waffled://calendar-connected"), body["redirectTo"])
    }

    @Test
    fun aRefusedFeedDeleteRelaysTheServer() = runTest {
        harness.enqueueError(403, "Forbidden", "Admins only")
        val e = assertFailsWith<WaffledApiException> { api.deleteIcsFeed("f1") }
        assertEquals(403, e.status)
        assertTrue(e.userMessage.contains("Admins only"))
    }

    // ---- Countdowns ----

    @Test
    fun countdownConfigDefaultsTheHorizon() = runTest {
        harness.enqueueJson("""{"countdowns":[],"sleeps":true}""")
        val c = api.countdownConfig()
        assertTrue(c.sleeps)
        assertEquals(183, c.birthdayHorizonDays)
        assertEquals("GET /api/countdowns", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueNoContent()
        api.setCountdownBirthdayHorizon(92)
        val (line, body) = sentBody()
        assertEquals("PUT /api/countdowns/config", line)
        assertEquals(JsonPrimitive(92), body["birthdayHorizonDays"])
    }

    // ---- Display & Kiosk ----

    @Test
    fun displayConfigRoundTripsWithAnExplicitNullAlbum() = runTest {
        val json = """{"screensaverMinutes":5,"content":"photos","returnToPicker":true,"resetHomeMinutes":0,
            "nightDim":{"enabled":false,"start":"22:00","end":"07:00"},"photoSource":"all",
            "photoAlbum":null,"photoInterval":10,"photoShuffle":false}"""
        harness.enqueueJson(json)
        val cfg = api.displayConfig()
        assertEquals("GET /api/kiosk/display", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueJson(json)
        api.setDisplayConfig(cfg)
        val (line, body) = sentBody()
        assertEquals("PUT /api/kiosk/display", line)
        assertEquals(JsonNull, body["photoAlbum"])
        assertEquals(JsonPrimitive("22:00"), body["nightDim"]!!.jsonObject["start"])
    }

    @Test
    fun kioskDevicesPairingAndRevoke() = runTest {
        harness.enqueueJson("""{"devices":[{"id":"d1","label":"Kitchen","lastSeenAt":null,"createdAt":"c"}]}""")
        assertEquals("Kitchen", api.kioskDevices().single().label)
        harness.takeRequest()

        harness.enqueueJson("""{"code":"ABC123","label":"Kiosk","expiresAt":"e"}""")
        assertEquals("ABC123", api.createPairingCode().code)
        assertEquals("POST /api/kiosk/pairing-code", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueNoContent()
        api.revokeKioskDevice("d1")
        assertEquals("DELETE /api/kiosk/devices/d1", harness.takeRequest().let { "${it.method} ${it.path}" })
    }

    // ---- Meals ----

    @Test
    fun mealCalendarSettingsUnwrapTheEnvelope() = runTest {
        val settings = """{"settings":{"addToCalendar":true,"pushToGoogle":false,"calendarPersonId":null,
            "participantIds":null,"times":{"dinner":"18:00"},"durationMinutes":60,"prepReminder":false,
            "prepReminderTime":"08:00","prepReminderMealTypes":["dinner"]}}"""
        harness.enqueueJson(settings)
        val s = api.mealCalendarSettings()
        assertNull(s.participantIds)
        assertEquals("18:00", s.times["dinner"])
        assertEquals("/api/meals/calendar-settings", harness.takeRequest().path)

        harness.enqueueJson(settings)
        api.setMealCalendarSettings(MealsSettingsLogic.body(s))
        val (line, body) = sentBody()
        assertEquals("PUT /api/meals/calendar-settings", line)
        assertEquals(JsonNull, body["participantIds"])
    }

    @Test
    fun householdMembersDecodeTheCamelCaseShape() = runTest {
        harness.enqueueJson(
            """{"household":{"id":"h","name":"S"},"members":[{"id":"p1","name":"Jerry","memberType":"adult",
               "isAdmin":true,"avatarEmoji":"😀","colorHex":"#123456"}]}""",
        )
        val m = api.householdMembers().single()
        assertEquals("😀", m.avatarEmoji)
        assertEquals("/api/household/settings", harness.takeRequest().path)
    }

    // ---- Pantry ----

    @Test
    fun pantryConfigReadsTheListAndPatchesConfig() = runTest {
        harness.enqueueJson(
            """{"items":[{"id":"i","name":"x"}],"locations":["Fridge"],"showOnToday":false,
               "avoidAllergens":["gluten"],"lowThreshold":2,"locationIcons":{"Fridge":"🧊"},"staleMonths":4}""",
        )
        val c = api.pantryConfig()
        assertEquals(listOf("Fridge"), c.locations)
        assertEquals(4.0, c.staleMonths)
        assertEquals("GET /api/pantry", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueJson("""{"locations":[],"showOnToday":true,"avoidAllergens":[],"lowThreshold":1}""")
        api.setPantryConfig(buildJsonObject { put("showOnToday", true) })
        val (line, body) = sentBody()
        assertEquals("PUT /api/pantry/config", line)
        assertEquals(JsonPrimitive(true), body["showOnToday"])
    }

    // ---- Stored proofs ----

    @Test
    fun storedProofRoutes() = runTest {
        harness.enqueueJson(
            """{"proofs":[{"instanceId":"i1","choreTitle":"Dishes","emoji":null,"personName":"Avery",
               "personAvatar":null,"personColor":null,"proofUrl":"/media/p.jpg","completedAt":"2026-07-25T12:00:00.000Z"}]}""",
        )
        assertEquals("i1", api.storedProofs().single().id)
        assertEquals("/api/chore-proofs", harness.takeRequest().path)

        harness.enqueueNoContent()
        api.deleteProof("i1")
        assertEquals("DELETE /api/chore-proofs/i1", harness.takeRequest().let { "${it.method} ${it.path}" })

        harness.enqueueJson("""{"cleared":3}""")
        assertEquals(3, api.clearProofs())
        assertEquals("DELETE /api/chore-proofs", harness.takeRequest().let { "${it.method} ${it.path}" })
    }
}
