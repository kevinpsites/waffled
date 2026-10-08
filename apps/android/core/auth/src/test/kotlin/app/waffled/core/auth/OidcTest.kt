package app.waffled.core.auth

import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Backend-mediated single sign-on — twin of the iOS `Session.loginWithOIDC`:
 *
 * ```
 * browser → GET  /api/auth/oidc/start?redirect=waffled://auth/callback → IdP
 * IdP     → waffled://auth/callback?code=…   (or ?error=…&error_description=…)
 * app     → POST /api/auth/oidc/exchange {code} → {accessToken, refreshToken, memberships}
 * ```
 *
 * Tokens never ride the redirect; only a one-time code does.
 */
class OidcTest {

    private val harness = ApiTestHarness(accessToken = null)
    private lateinit var api: AuthApi

    @Before fun setUp() {
        harness.start()
        api = AuthApi(harness.serverAddress)
    }

    @After fun tearDown() {
        api.close()
        harness.stop()
    }

    @Test
    fun theStartUrlCarriesTheAppsCallback() {
        assertEquals(
            "${harness.baseUrl()}/api/auth/oidc/start?redirect=waffled%3A%2F%2Fauth%2Fcallback",
            api.oidcStartUrl(),
        )
    }

    @Test
    fun exchangingTheCodeReturnsASession() = runTest {
        harness.enqueueJson(
            """{"accessToken":"a1","refreshToken":"r1","expiresIn":900,
               "memberships":[{"householdId":"h1","householdName":"Sites","personId":"p1","isAdmin":true}]}""",
        )

        val result = assertIs<LoginResult.Success>(api.oidcExchange("one-time"))

        assertEquals(TokenPair("a1", "r1"), result.tokens)
        assertEquals("h1", result.memberships.single().householdId)
        val sent = harness.server.takeRequest()
        assertEquals("/api/auth/oidc/exchange", sent.path)
        assertEquals("""{"code":"one-time"}""", sent.body.readUtf8())
    }

    @Test
    fun anUninvitedAccountIsToldSo() = runTest {
        harness.enqueueError(403, "Forbidden", "nope")
        val result = assertIs<LoginResult.Failed>(api.oidcExchange("c"))
        assertEquals("This account isn't invited to this household yet.", result.message)
    }

    @Test
    fun anExpiredCodeRelaysTheServer() = runTest {
        harness.enqueueError(401, "Unauthorized", "Invalid or expired sign-in.")
        val result = assertIs<LoginResult.Failed>(api.oidcExchange("c"))
        assertEquals("Invalid or expired sign-in.", result.message)
    }

    // ---- the deep link back ----

    @Test
    fun aCallbackWithACodeIsReadyToExchange() {
        assertEquals(OidcCallback.Code("abc"), OidcCallback.parse("waffled://auth/callback?code=abc"))
    }

    @Test
    fun theServersOwnErrorWordingIsShown() {
        val parsed = OidcCallback.parse(
            "waffled://auth/callback?error=access_denied&error_description=Your%20account%20is%20disabled",
        )
        assertEquals(OidcCallback.Failed("Your account is disabled"), parsed)
    }

    @Test
    fun notInvitedHasItsOwnWording() {
        assertEquals(
            OidcCallback.Failed("This account isn't invited to this household yet."),
            OidcCallback.parse("waffled://auth/callback?error=not_invited"),
        )
    }

    @Test
    fun aCallbackWithNothingInItFails() {
        assertIs<OidcCallback.Failed>(OidcCallback.parse("waffled://auth/callback"))
    }

    @Test
    fun otherDeepLinksAreNotOurs() {
        assertEquals(OidcCallback.NotOurs, OidcCallback.parse("waffled://calendar/connected?ok=1"))
        assertEquals(OidcCallback.NotOurs, OidcCallback.parse("https://example.com/auth/callback?code=x"))
        assertTrue(OidcCallback.parse("not a uri") is OidcCallback.NotOurs)
    }
}
