package app.waffled.android.auth

import app.waffled.core.auth.AuthApi
import app.waffled.core.auth.InMemoryTokenStore
import app.waffled.core.auth.RefreshBackend
import app.waffled.core.auth.TokenPair
import app.waffled.core.auth.TokenRefresher
import app.waffled.core.auth.WaffledAuth
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The sign-in screen's "Server address" — twin of the iOS `AuthGate` disclosure. A
 * self-hosted stack lives at whatever host and port the family runs it on, so the address
 * must be settable BEFORE anyone can sign in, not only from About.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LoginServerAddressTest {

    private val harness = ApiTestHarness(accessToken = null)
    private val changes = mutableListOf<String>()
    private var refusal: String? = null

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        harness.start()
    }

    @After fun tearDown() {
        harness.stop()
        Dispatchers.resetMain()
    }

    private fun vm(): SessionViewModel {
        val store = InMemoryTokenStore()
        val noRefresh = object : RefreshBackend {
            override suspend fun refresh(refreshToken: String): TokenPair? = null
        }
        harness.enqueueJson("""{"initialized":true,"methods":["password"]}""")
        val vm = SessionViewModel(
            auth = WaffledAuth(store, TokenRefresher(store, noRefresh)),
            api = AuthApi(harness.serverAddress),
            currentServer = { "http://10.0.0.85:8080" },
            changeServer = { input -> changes += input; refusal },
        )
        settle { vm.phase.value is SessionPhase.SignedOut }
        return vm
    }

    /** The harness is a real HTTP server: requests complete on OkHttp's threads. */
    private fun settle(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(10)
        }
    }

    private fun SessionViewModel.useServerAndWait() {
        useServer()
        settle { !login.value.isBusy }
    }

    @Test
    fun theFieldStartsWithTheServerInUse() {
        assertEquals("http://10.0.0.85:8080", vm().login.value.serverUrl)
    }

    @Test
    fun usingANewServerSwitchesAndReReadsItsSignInMethods() {
        val vm = vm()
        harness.enqueueJson("""{"initialized":true,"methods":["password","oidc"]}""")

        vm.onServerUrlChange("http://192.168.1.20:9000")
        vm.useServerAndWait()

        assertEquals(listOf("http://192.168.1.20:9000"), changes)
        val phase = vm.phase.value as SessionPhase.SignedOut
        assertTrue(phase.status?.supportsOidc == true)
        assertNull(vm.login.value.error)
        assertEquals(false, vm.login.value.isBusy)
    }

    @Test
    fun aServerThatDoesNotAnswerSaysSo() {
        val vm = vm()
        harness.enqueueError(502)

        vm.onServerUrlChange("http://10.0.0.85:9999")
        vm.useServerAndWait()

        assertTrue(vm.login.value.error.orEmpty().startsWith("Couldn't reach"))
    }

    @Test
    fun aRefusedAddressIsShownAndNothingIsReRead() {
        val vm = vm()
        refusal = "Enter a full server address beginning with http:// or https://."

        vm.onServerUrlChange("not a url")
        vm.useServerAndWait()

        assertEquals(refusal, vm.login.value.error)
        assertEquals(1, harness.server.requestCount)
    }
}
