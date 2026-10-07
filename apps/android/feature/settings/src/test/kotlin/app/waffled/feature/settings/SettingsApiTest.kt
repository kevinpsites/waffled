package app.waffled.feature.settings

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The settings API slice against a real MockWebServer. Request paths, methods and bodies
 * mirror `apps/ios/.../Sync/WaffledAPI.swift`; the explicit-null assertions guard the
 * `explicitNulls = false` trap.
 */
class SettingsApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: SettingsApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = SettingsApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    private fun body(): JsonObject = Json.parseToJsonElement(harness.takeRequest().body.readUtf8()).jsonObject

    @Test
    fun `household overview reads person, memberships, invites and settings in one call`() = runTest {
        harness.enqueueJson(
            """
            {"household":{"id":"h1","name":"Seinfelds","settings":{
                "modules":{"pantry":true},"chores":{"rewards":false},
                "display":{"eventStyle":"tinted","familyColorHex":"#112233"}}},
             "person":{"id":"p1","memberType":"adult","isAdmin":true,"capabilities":[]},
             "memberships":[{"householdId":"h1","householdName":"Seinfelds","personId":"p1","isAdmin":true,"memberType":"adult"}],
             "pendingInvites":[{"id":"i1","householdName":"Costanzas","memberType":"teen","isAdmin":false}]}
            """.trimIndent(),
        )
        val o = api.household()
        assertEquals("/api/household", harness.takeRequest().path)
        assertEquals("h1", o.household?.id)
        assertEquals("p1", o.person?.id)
        assertTrue(o.person?.isAdmin == true)
        assertEquals("Seinfelds", o.memberships.single().householdName)
        assertEquals("Costanzas", o.pendingInvites.single().householdName)
        val m = o.modules()
        assertEquals(mapOf("pantry" to true), m.modules)
        assertFalse(m.rewards)
        assertEquals("tinted", m.eventStyle)
        assertEquals("#112233", m.familyColorHex)
    }

    @Test
    fun `an account-less household body decodes with empty lists and rewards on`() = runTest {
        harness.enqueueJson("""{"household":{"id":"h1","name":"H"}}""")
        val o = api.household()
        assertTrue(o.memberships.isEmpty())
        assertTrue(o.pendingInvites.isEmpty())
        assertNull(o.person)
        assertTrue(o.modules().rewards)
        assertTrue(o.modules().modules.isEmpty())
    }

    @Test
    fun `household settings decodes members with defaults`() = runTest {
        harness.enqueueJson(
            """
            {"household":{"id":"h1","name":"H","timezone":"UTC","weekStart":"monday","location":null},
             "members":[{"id":"p1","name":"Ana","memberType":"adult","isAdmin":true,"isOwner":true,
                         "hasLogin":true,"hasPassword":true,"hasPin":false,"showOnKiosk":true,"loginEmail":"a@b.co"},
                        {"id":"p2","name":"Bo","memberType":"kid"}]}
            """.trimIndent(),
        )
        val s = api.householdSettings()
        assertEquals("/api/household/settings", harness.takeRequest().path)
        assertEquals("monday", s.household.weekStart)
        assertTrue(s.members[0].isOwner)
        assertFalse(s.members[1].hasLogin)
        assertTrue(s.members[1].showOnKiosk)
    }

    @Test
    fun `switch household posts the id and returns the new pair`() = runTest {
        harness.enqueueJson("""{"accessToken":"a2","refreshToken":"r2","expiresIn":900,"householdId":"h2"}""")
        val r = api.switchHousehold("h2")
        val req = harness.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/auth/switch", req.path)
        assertEquals("h2", Json.parseToJsonElement(req.body.readUtf8()).jsonObject["householdId"]?.jsonPrimitive?.content)
        assertEquals("a2", r.accessToken)
    }

    @Test
    fun `switch to a household you left surfaces the 403 status`() = runTest {
        harness.enqueueError(403, "Forbidden")
        val e = assertFailsWith<WaffledApiException> { api.switchHousehold("h2") }
        assertEquals(403, e.status)
    }

    @Test
    fun `accept invite posts an empty object`() = runTest {
        harness.enqueueJson("{}")
        api.acceptInvite("i1")
        val req = harness.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/auth/invites/i1/accept", req.path)
        assertEquals("{}", req.body.readUtf8())
    }

    @Test
    fun `own profile color is a PUT to the account profile`() = runTest {
        harness.enqueueJson("{}")
        api.updateOwnColor("#2F7FED")
        val req = harness.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/account/profile", req.path)
        assertEquals("#2F7FED", Json.parseToJsonElement(req.body.readUtf8()).jsonObject["colorHex"]?.jsonPrimitive?.content)
    }

    @Test
    fun `set modules patches the flag map and returns the merged one`() = runTest {
        harness.enqueueJson("""{"modules":{"pantry":true,"goals":false}}""")
        val merged = api.setModules(mapOf("pantry" to true))
        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/household/modules", req.path)
        assertEquals("true", Json.parseToJsonElement(req.body.readUtf8()).jsonObject["pantry"]?.jsonPrimitive?.content)
        assertEquals(mapOf("pantry" to true, "goals" to false), merged)
    }

    @Test
    fun `rewards sub-toggle goes through chores settings`() = runTest {
        harness.enqueueJson("""{"rewards":false}""")
        assertFalse(api.setChoresRewards(false))
        val req = harness.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/chores/settings", req.path)
    }

    @Test
    fun `household display only sends the fields given`() = runTest {
        harness.enqueueNoContent()
        api.setHouseholdDisplay(familyColorHex = "#F97316")
        val sent = body()
        assertEquals(setOf("familyColorHex"), sent.keys)
    }

    @Test
    fun `update household patches one field`() = runTest {
        harness.enqueueNoContent()
        api.updateHousehold("weekStart", "monday")
        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/household", req.path)
        assertEquals("monday", Json.parseToJsonElement(req.body.readUtf8()).jsonObject["weekStart"]?.jsonPrimitive?.content)
    }

    @Test
    fun `person save sends an explicit null to clear the emoji`() = runTest {
        harness.enqueueNoContent()
        val draft = SettingsApi.PersonDraft(
            name = "Bo", memberType = "kid", colorHex = "#2F7FED",
            isAdmin = false, showOnKiosk = true, avatarEmoji = null, birthday = null,
        )
        api.savePerson(id = "p2", draft = draft)
        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/persons/p2", req.path)
        val sent = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(JsonNull, sent["avatarEmoji"])
        assertFalse("birthday" in sent)
    }

    @Test
    fun `new person is a POST with the birthday when set`() = runTest {
        harness.enqueueNoContent()
        api.savePerson(
            id = null,
            draft = SettingsApi.PersonDraft("Bo", "kid", "#2F7FED", false, true, "🐻", "2015-03-09"),
        )
        val req = harness.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/persons", req.path)
        assertEquals("2015-03-09", Json.parseToJsonElement(req.body.readUtf8()).jsonObject["birthday"]?.jsonPrimitive?.content)
    }

    @Test
    fun `login without a password invites SSO-only`() = runTest {
        harness.enqueueNoContent()
        api.setPersonLogin("p2", "bo@home.org", password = "")
        val req = harness.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/persons/p2/login", req.path)
        val sent = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(setOf("email"), sent.keys)
    }

    @Test
    fun `pin set and clear hit the pin route`() = runTest {
        harness.enqueueNoContent()
        harness.enqueueNoContent()
        api.setPersonPin("p2", "1234")
        api.clearPersonPin("p2")
        val set = harness.takeRequest()
        assertEquals("PUT", set.method)
        assertEquals("/api/persons/p2/pin", set.path)
        val clear = harness.takeRequest()
        assertEquals("DELETE", clear.method)
        assertEquals("/api/persons/p2/pin", clear.path)
    }

    @Test
    fun `permissions matrix round-trips the nested map`() = runTest {
        harness.enqueueJson(
            """{"permissions":{"teen":{"chore.manage":true}},"capabilities":["chore.manage"],"roles":["teen"]}""",
        )
        harness.enqueueJson("""{"permissions":{"teen":{"chore.manage":false}}}""")
        assertEquals(mapOf("teen" to mapOf("chore.manage" to true)), api.permissionsMatrix())
        val saved = api.setPermissionsMatrix(mapOf("teen" to mapOf("chore.manage" to false)))
        harness.takeRequest()
        val put = harness.takeRequest()
        assertEquals("PUT", put.method)
        val sent = Json.parseToJsonElement(put.body.readUtf8()).jsonObject
        assertEquals(
            "false",
            sent["permissions"]!!.jsonObject["teen"]!!.jsonObject["chore.manage"]!!.jsonPrimitive.content,
        )
        assertEquals(false, saved["teen"]?.get("chore.manage"))
    }

    @Test
    fun `currency save sends an explicit null symbol when blank`() = runTest {
        harness.enqueueNoContent()
        api.saveCurrency(
            key = "stars",
            draft = SettingsApi.CurrencyDraft(label = "Stars", symbol = "", color = "#E0A500", isDefault = true, spendable = true),
        )
        val req = harness.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/currencies/stars", req.path)
        assertEquals(JsonNull, Json.parseToJsonElement(req.body.readUtf8()).jsonObject["symbol"])
    }

    @Test
    fun `currencies and conversions unwrap their envelopes`() = runTest {
        harness.enqueueJson("""{"currencies":[{"key":"stars","label":"Stars","symbol":"⭐","isDefault":true,"spendable":true,"sortOrder":0}]}""")
        harness.enqueueJson(
            """{"conversions":[{"id":"c1","fromCurrency":"stars","toCurrency":"sticks","fromAmount":10,"toAmount":1,
               "from":{"key":"stars","symbol":"⭐","label":"Stars"},"to":{"key":"sticks"}}]}""",
        )
        assertEquals("⭐", api.currencies().single().symbol)
        val c = api.conversions().single()
        assertEquals(10, c.fromAmount)
        assertNull(c.to.symbol)
    }

    @Test
    fun `create conversion posts amounts of at least one`() = runTest {
        harness.enqueueNoContent()
        api.createConversion("stars", "sticks", fromAmount = 0, toAmount = 1)
        val sent = body()
        assertEquals("1", sent["fromAmount"]?.jsonPrimitive?.content)
        assertEquals("sticks", sent["toCurrency"]?.jsonPrimitive?.content)
    }

    @Test
    fun `reward approval and proof retention read and write`() = runTest {
        harness.enqueueJson("""{"requireApproval":false}""")
        harness.enqueueJson("{}")
        harness.enqueueJson("""{"proofTtlDays":7,"rewards":true}""")
        harness.enqueueJson("""{"proofTtlDays":30}""")
        assertFalse(api.rewardApprovalRequired())
        api.setRewardApproval(true)
        assertEquals(7, api.proofTtlDays())
        assertEquals(30, api.setProofTtlDays(30))
        assertEquals("/api/rewards/settings", harness.takeRequest().path)
        assertEquals("PUT", harness.takeRequest().method)
        assertEquals("/api/chores/settings", harness.takeRequest().path)
        val put = harness.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("30", Json.parseToJsonElement(put.body.readUtf8()).jsonObject["proofTtlDays"]?.jsonPrimitive?.content)
    }

    @Test
    fun `stored proofs list, delete one, clear all`() = runTest {
        harness.enqueueJson("""{"proofs":[{"instanceId":"i1","choreTitle":"Dishes"}]}""")
        harness.enqueueNoContent()
        harness.enqueueJson("""{"cleared":4}""")
        assertEquals("i1", api.storedProofs().single().instanceId)
        api.deleteProof("i1")
        assertEquals(4, api.clearProofs())
        assertEquals("/api/chore-proofs", harness.takeRequest().path)
        val del = harness.takeRequest()
        assertEquals("DELETE", del.method)
        assertEquals("/api/chore-proofs/i1", del.path)
        val clear = harness.takeRequest()
        assertEquals("DELETE", clear.method)
        assertEquals("/api/chore-proofs", clear.path)
    }

    @Test
    fun `updates decodes the release info`() = runTest {
        harness.enqueueJson(
            """{"enabled":true,"current":{"version":"0.15.3","sha":"abc"},
               "latest":{"tag":"v0.16.0","url":"https://x","publishedAt":null},"updateAvailable":true}""",
        )
        val u = api.updates()
        assertEquals("/api/updates", harness.takeRequest().path)
        assertEquals("v0.16.0", u.latest?.tag)
        assertEquals(true, u.updateAvailable)
    }

    @Test
    fun `health probe reports any HTTP answer as reachable`() = runTest {
        harness.enqueueError(401, "AuthError")
        assertEquals(401, SettingsApi.probeHealth(harness.baseUrl()))
        assertEquals("/api/health", harness.takeRequest().path)
    }

    @Test
    fun `health probe returns null when nothing answers`() = runTest {
        harness.enqueueDisconnect()
        assertNull(SettingsApi.probeHealth(harness.baseUrl()))
    }
}
