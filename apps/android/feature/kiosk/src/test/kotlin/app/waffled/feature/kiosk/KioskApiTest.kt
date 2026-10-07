package app.waffled.feature.kiosk

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The kiosk wire contract, against MockWebServer. Shapes and status codes come from the
 * server (`apps/api/src/modules/kiosk/kiosk.ts`); KEEP IN SYNC with it and with the web
 * `apps/web/src/lib/api/kiosk.ts`.
 */
class KioskApiTest {

    private val harness = ApiTestHarness(accessToken = "person-token")
    private val store = KioskDeviceStore(MapKeyValueStore(), XorCrypto())
    private lateinit var device: KioskDeviceAuth
    private lateinit var api: KioskApi

    @Before fun setUp() {
        harness.start()
        val client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        device = KioskDeviceAuth(client, store)
        api = KioskApi(client, harness.tokens, device)
    }

    @After fun tearDown() = harness.stop()

    private fun take() = requireNotNull(harness.server.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS)) { "no request reached the server" }

    private fun body(raw: String) = Json.parseToJsonElement(raw).jsonObject

    private fun enqueueDeviceToken(token: String = "dev-access") =
        harness.enqueueJson("""{"accessToken":"$token","expiresIn":900}""")

    // ---- pairing ----

    @Test fun pairSendsTheCodeAndLabelWithNoBearer() = runTest {
        harness.enqueueJson("""{"deviceId":"d1","deviceSecret":"sec","householdId":"h1"}""", status = 201)
        val pairing = api.pairDevice(code = "123456", label = "Kitchen")
        assertEquals("sec", pairing.deviceSecret)
        val req = take()
        assertEquals("/api/kiosk/pair", req.path)
        assertEquals("POST", req.method)
        assertNull(req.getHeader("Authorization"))
        val sent = body(req.body.readUtf8())
        assertEquals("123456", sent["code"]?.jsonPrimitive?.content)
        assertEquals("Kitchen", sent["label"]?.jsonPrimitive?.content)
    }

    @Test fun pairOmitsABlankLabel() = runTest {
        harness.enqueueJson("""{"deviceId":"d1","deviceSecret":"sec","householdId":"h1"}""", status = 201)
        api.pairDevice(code = "123456", label = " ")
        assertFalse(body(take().body.readUtf8()).containsKey("label"))
    }

    @Test fun anExpiredCodeIsA401() = runTest {
        harness.enqueueError(401, "Unauthorized", "Invalid or expired pairing code.")
        val e = assertFailsWith<WaffledApiException> { api.pairDevice("000000", null) }
        assertEquals(401, e.status)
    }

    @Test fun promoteUsesThePersonBearer() = runTest {
        harness.enqueueJson("""{"deviceId":"d1","deviceSecret":"sec","householdId":"h1"}""", status = 201)
        api.promoteDevice(label = "Hall")
        val req = take()
        assertEquals("/api/kiosk/promote", req.path)
        assertEquals("Bearer person-token", req.getHeader("Authorization"))
    }

    // ---- device token + profiles ----

    @Test fun profilesMintADeviceTokenFromTheSecretThenUseIt() = runTest {
        store.savePaired("sec", "Kitchen")
        enqueueDeviceToken()
        harness.enqueueJson(
            """{"deviceLabel":"Kitchen","profiles":[
                {"id":"p1","name":"Maya","avatarEmoji":"🧒","colorHex":"#7C6FCD","hasPin":true},
                {"id":"p2","name":"Sam"}]}""",
        )
        val resp = api.profiles()
        assertEquals("Kitchen", resp.deviceLabel)
        assertEquals(listOf("p1", "p2"), resp.profiles.map { it.id })
        assertTrue(resp.profiles[0].hasPin)
        assertFalse(resp.profiles[1].hasPin)

        val mint = take()
        assertEquals("/api/kiosk/device/token", mint.path)
        assertNull(mint.getHeader("Authorization"))
        assertEquals("sec", body(mint.body.readUtf8())["deviceSecret"]?.jsonPrimitive?.content)
        val list = take()
        assertEquals("/api/kiosk/profiles", list.path)
        assertEquals("Bearer dev-access", list.getHeader("Authorization"))
    }

    @Test fun theDeviceTokenIsCachedAcrossCalls() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken()
        harness.enqueueJson("""{"profiles":[]}""")
        harness.enqueueJson("""{"profiles":[]}""")
        api.profiles()
        api.profiles()
        assertEquals(3, harness.requestCount)
    }

    @Test fun aStaleDeviceTokenIsReMintedOnceAndReplayed() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken("old")
        harness.enqueueUnauthorized()
        enqueueDeviceToken("new")
        harness.enqueueJson("""{"profiles":[{"id":"p1","name":"Maya","hasPin":false}]}""")
        assertEquals(1, api.profiles().profiles.size)
        take(); take(); take()
        assertEquals("Bearer new", take().getHeader("Authorization"))
        assertEquals(0, harness.refreshCount.get(), "the PERSON token provider must not be asked")
    }

    @Test fun aRevokedDeviceSurfacesAs401() = runTest {
        store.savePaired("sec", null)
        harness.enqueueError(401, "Unauthorized", "Unknown or revoked device.")
        val e = assertFailsWith<WaffledApiException> { api.profiles() }
        assertEquals(401, e.status)
    }

    @Test fun anUnpairedDeviceMakesNoRequest() = runTest {
        assertFailsWith<KioskDeviceAuth.NotPaired> { api.profiles() }
        assertEquals(0, harness.requestCount)
    }

    // ---- claim ----

    @Test fun claimReturnsThePersonSessionEvenWhenPersonOmitsHasPin() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken()
        harness.enqueueJson(
            """{"accessToken":"a1","refreshToken":"r1","expiresIn":900,
                "person":{"id":"p1","householdId":"h1","name":"Maya","memberType":"kid","isAdmin":false}}""",
        )
        val result = api.claimProfile("p1", pin = "1234")
        val ok = assertIs<KioskClaimResult.Success>(result)
        assertEquals("a1", ok.claim.accessToken)
        assertEquals("r1", ok.claim.refreshToken)
        assertFalse(ok.claim.person!!.hasPin)

        take()
        val req = take()
        assertEquals("/api/kiosk/profile/p1", req.path)
        assertEquals("Bearer dev-access", req.getHeader("Authorization"))
        assertEquals("1234", body(req.body.readUtf8())["pin"]?.jsonPrimitive?.content)
    }

    @Test fun claimWithoutAPinSendsNoPinKey() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken()
        harness.enqueueJson("""{"accessToken":"a","refreshToken":"r"}""")
        api.claimProfile("p1", pin = null)
        take()
        assertTrue(body(take().body.readUtf8()).isEmpty())
    }

    @Test fun aWrongPinIsNotRetried() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken()
        harness.enqueueJson("""{"error":"Unauthorized","message":"Incorrect PIN.","triesLeft":2}""", status = 401)
        val result = api.claimProfile("p1", pin = "0000")
        assertEquals(KioskClaimResult.WrongPin(triesLeft = 2), result)
        // Mint + ONE claim: a replay would burn a second attempt against the lockout.
        assertEquals(2, harness.requestCount)
        assertEquals(0, harness.refreshCount.get())
    }

    @Test fun lockoutCarriesRetryAfterDefaultingTo30() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken()
        harness.enqueueJson("""{"error":"TooManyRequests","retryAfter":120}""", status = 429)
        harness.enqueueJson("""{"error":"TooManyRequests"}""", status = 429)
        assertEquals(KioskClaimResult.LockedOut(retryAfter = 120), api.claimProfile("p1", "1111"))
        assertEquals(KioskClaimResult.LockedOut(retryAfter = 30), api.claimProfile("p1", "1111"))
    }

    @Test fun aMissingProfileAndOtherFailuresAreDistinct() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken()
        harness.enqueueError(404, "NotFound", "profile not found")
        harness.enqueueError(500, "Internal", "boom")
        assertEquals(KioskClaimResult.NotFound, api.claimProfile("gone", null))
        assertEquals(KioskClaimResult.Other("boom"), api.claimProfile("p1", null))
    }

    // ---- device-side housekeeping ----

    @Test fun labelIsPutWithTheDeviceBearer() = runTest {
        store.savePaired("sec", null)
        enqueueDeviceToken()
        harness.enqueueJson("""{"ok":true,"label":"Hall"}""")
        api.setDeviceLabel("Hall")
        take()
        val req = take()
        assertEquals("PUT", req.method)
        assertEquals("/api/kiosk/device/label", req.path)
        assertEquals("Hall", body(req.body.readUtf8())["label"]?.jsonPrimitive?.content)
    }

    @Test fun heartbeatNeverThrows() = runTest {
        store.savePaired("sec", null)
        harness.enqueueDisconnect()
        api.heartbeat()
    }
}
