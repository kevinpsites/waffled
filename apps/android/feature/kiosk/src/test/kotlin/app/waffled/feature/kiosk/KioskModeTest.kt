package app.waffled.feature.kiosk

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
 * The shared-kiosk state machine (iOS `KioskMode`): the picker shows exactly when the
 * device is paired AND nobody holds a person session.
 */
class KioskModeTest {

    private class FakeHost(var signedIn: Boolean = false, var adoptSucceeds: Boolean = true) : KioskSessionHost {
        val log = mutableListOf<String>()
        override fun isSignedIn(): Boolean = signedIn
        override suspend fun adopt(accessToken: String, refreshToken: String): Boolean {
            log += "adopt:$accessToken"
            if (adoptSucceeds) signedIn = true
            return adoptSucceeds
        }
        override suspend fun dropSession() { log += "drop"; signedIn = false }
        override suspend fun signOut() { log += "signOut"; signedIn = false }
    }

    private val harness = ApiTestHarness(accessToken = "admin-token")
    private val store = KioskDeviceStore(MapKeyValueStore(), XorCrypto())
    private val host = FakeHost()
    private lateinit var mode: KioskMode

    private val maya = KioskProfile(id = "p1", name = "Maya", hasPin = true)

    @Before fun setUp() {
        harness.start()
        val client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        val device = KioskDeviceAuth(client, store)
        mode = KioskMode(store, KioskApi(client, harness.tokens, device), device, host)
    }

    @After fun tearDown() = harness.stop()

    private fun pairing() = harness.enqueueJson("""{"deviceId":"d","deviceSecret":"sec","householdId":"h"}""", status = 201)
    private fun deviceToken() = harness.enqueueJson("""{"accessToken":"dev","expiresIn":900}""")

    @Test fun aFreshPhoneIsNeverAKiosk() {
        assertFalse(mode.state.value.isShared)
        assertFalse(mode.state.value.needsPicker)
    }

    @Test fun anAlreadyPairedDeviceWithNoSessionShowsThePicker() {
        store.savePaired("sec", "Kitchen")
        val m = KioskMode(store, KioskApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens, KioskDeviceAuth(WaffledHttp.client(harness.tokens, harness.serverAddress), store)), null, host)
        assertTrue(m.state.value.needsPicker)
        assertEquals("Kitchen", m.state.value.deviceLabel)
    }

    @Test fun pairingByCodeStoresTheSecretDropsTheSessionAndShowsThePicker() = runTest {
        host.signedIn = true
        pairing()
        deviceToken()
        harness.enqueueJson("""{"ok":true,"label":"Kitchen"}""")
        assertNull(mode.enableViaCode(" 123456 ", "Kitchen"))
        assertTrue(store.isPaired)
        assertEquals(listOf("drop"), host.log)
        assertTrue(mode.state.value.needsPicker)
        assertEquals("Kitchen", mode.state.value.deviceLabel)
    }

    @Test fun pairingErrorsAreWordedLikeIos() = runTest {
        harness.enqueueError(401, "Unauthorized", "Invalid or expired pairing code.")
        assertEquals("That code is invalid or expired.", mode.enableViaCode("000000", null))
        harness.enqueueError(500)
        assertEquals("Couldn’t pair this device (error 500).", mode.enableViaCode("000000", null))
        harness.enqueueDisconnect()
        assertEquals("Couldn’t reach the server. Check the address and your connection.", mode.enableViaCode("000000", null))
        assertFalse(store.isPaired)
    }

    @Test fun promoteNeedsAnAdmin() = runTest {
        harness.enqueueError(403, "Forbidden")
        assertEquals("Only an admin can turn this device into a kiosk.", mode.enableViaPromote(null))
        pairing()
        assertNull(mode.enableViaPromote("Hall"))
        assertTrue(mode.state.value.needsPicker)
    }

    @Test fun aSuccessfulClaimAdoptsThePersonSession() = runTest {
        store.savePaired("sec", null)
        deviceToken()
        harness.enqueueJson("""{"accessToken":"a1","refreshToken":"r1"}""")
        assertEquals(ClaimOutcome.Ok, mode.claim(maya, "1234"))
        assertEquals(listOf("adopt:a1"), host.log)
        assertFalse(mode.state.value.needsPicker)
    }

    @Test fun aClaimTheHostRefusesToAdoptFails() = runTest {
        store.savePaired("sec", null)
        host.adoptSucceeds = false
        deviceToken()
        harness.enqueueJson("""{"accessToken":"a1","refreshToken":"r1"}""")
        assertEquals(ClaimOutcome.Failed("Couldn’t safely finish switching profiles. Try again."), mode.claim(maya, null))
        assertFalse(mode.state.value.hasProfile)
    }

    @Test fun claimFailuresMapToPinPadOutcomes() = runTest {
        store.savePaired("sec", null)
        deviceToken()
        harness.enqueueJson("""{"error":"Unauthorized","triesLeft":1}""", status = 401)
        harness.enqueueJson("""{"error":"TooManyRequests","retryAfter":60}""", status = 429)
        harness.enqueueError(404, "NotFound")
        harness.enqueueError(500, "Boom", "boom")
        harness.enqueueDisconnect()
        assertEquals(ClaimOutcome.WrongPin(1), mode.claim(maya, "0000"))
        assertEquals(ClaimOutcome.LockedOut(60), mode.claim(maya, "0000"))
        assertEquals(ClaimOutcome.Failed("That profile is no longer available."), mode.claim(maya, null))
        assertEquals(ClaimOutcome.Failed("Couldn’t sign in to that profile."), mode.claim(maya, null))
        assertEquals(ClaimOutcome.Failed("Couldn’t reach the server."), mode.claim(maya, null))
        assertTrue(host.log.isEmpty())
    }

    @Test fun returningToThePickerKeepsThePairing() = runTest {
        store.savePaired("sec", null)
        host.signedIn = true
        val m = KioskMode(store, KioskApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens, KioskDeviceAuth(WaffledHttp.client(harness.tokens, harness.serverAddress), store)), null, host)
        assertFalse(m.state.value.needsPicker)
        m.returnToPicker()
        assertTrue(m.state.value.needsPicker)
        assertTrue(store.isPaired)
    }

    @Test fun anExpiredPersonSessionDropsToThePickerNotLogin() {
        store.savePaired("sec", null)
        host.signedIn = true
        val m = KioskMode(store, KioskApi(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens, KioskDeviceAuth(WaffledHttp.client(harness.tokens, harness.serverAddress), store)), null, host)
        m.onPersonSessionExpired()
        assertTrue(m.state.value.needsPicker)
        assertTrue(m.state.value.isShared)
    }

    @Test fun aRevokedDeviceForgetsThePairingWhenProfilesLoad() = runTest {
        store.savePaired("sec", null)
        harness.enqueueError(401, "Unauthorized", "Unknown or revoked device.")
        assertEquals(ProfilesLoad.Revoked, mode.loadProfiles())
        assertFalse(store.isPaired)
        assertFalse(mode.state.value.isShared)
        assertFalse(mode.state.value.needsPicker)
    }

    @Test fun profilesLoadAndTransportFailureIsRetryable() = runTest {
        store.savePaired("sec", "Kitchen")
        deviceToken()
        harness.enqueueJson("""{"profiles":[{"id":"p1","name":"Maya"}]}""")
        val loaded = mode.loadProfiles()
        assertTrue(loaded is ProfilesLoad.Loaded && loaded.profiles.profiles.size == 1)
        harness.enqueueDisconnect()
        assertEquals(ProfilesLoad.Failed("Couldn’t load profiles. Check the connection."), mode.loadProfiles())
        assertTrue(store.isPaired)
    }

    @Test fun unpairForgetsEverything() = runTest {
        store.savePaired("sec", null)
        host.signedIn = true
        mode.unpair()
        assertFalse(store.isPaired)
        assertEquals(listOf("signOut"), host.log)
        assertFalse(mode.state.value.needsPicker)
    }
}
