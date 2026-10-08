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
import kotlin.test.assertIs
import kotlin.test.assertNull

/** The single sign-on return leg on the sign-in screen — twin of iOS `loginWithOIDC`. */
@OptIn(ExperimentalCoroutinesApi::class)
class LoginOidcTest {

    private val harness = ApiTestHarness(accessToken = null)
    private val adopted = mutableListOf<TokenPair>()

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
        harness.enqueueJson("""{"initialized":true,"methods":["oidc"],"oidc":{}}""")
        val vm = SessionViewModel(
            auth = WaffledAuth(store, TokenRefresher(store, noRefresh)),
            api = AuthApi(harness.serverAddress),
            adoptSession = { adopted += it; null },
        )
        settle { vm.phase.value is SessionPhase.SignedOut }
        return vm
    }

    private fun settle(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(10)
        }
    }

    @Test
    fun aReturnedCodeSignsIn() {
        val vm = vm()
        harness.enqueueJson("""{"accessToken":"a1","refreshToken":"r1","memberships":[{"householdId":"h1"}]}""")

        vm.completeOidc("waffled://auth/callback?code=one-time")
        settle { vm.phase.value is SessionPhase.SignedIn }

        assertEquals(listOf(TokenPair("a1", "r1")), adopted)
        assertEquals("h1", assertIs<SessionPhase.SignedIn>(vm.phase.value).memberships.single().householdId)
    }

    @Test
    fun aReturnedErrorIsShownWithoutCallingTheServer() {
        val vm = vm()

        vm.completeOidc("waffled://auth/callback?error=not_invited")

        assertEquals("This account isn't invited to this household yet.", vm.login.value.error)
        assertEquals(1, harness.server.requestCount)
        assertIs<SessionPhase.SignedOut>(vm.phase.value)
    }

    @Test
    fun anExchangeTheServerRefusesIsShown() {
        val vm = vm()
        harness.enqueueError(401, "Unauthorized", "Invalid or expired sign-in.")

        vm.completeOidc("waffled://auth/callback?code=stale")
        settle { !vm.login.value.isBusy }

        assertEquals("Invalid or expired sign-in.", vm.login.value.error)
        assertEquals(emptyList(), adopted)
    }

    @Test
    fun someOtherDeepLinkIsIgnored() {
        val vm = vm()
        vm.completeOidc("waffled://calendar/connected")
        assertNull(vm.login.value.error)
        assertEquals(1, harness.server.requestCount)
    }
}
