package app.waffled.core.auth

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
 * Drives the real `/api/auth` contract, transcribed from a live server:
 *
 * ```
 * GET  /api/auth/status -> {"initialized":true,"methods":["password"]}
 * POST /api/auth/login  -> {accessToken, refreshToken, expiresIn, memberships[], pendingInvites[]}
 * ```
 *
 * `methods` is what decides which login UI to show — a self-hosted stack may offer
 * password, OIDC, or both, so the client must ask rather than assume.
 */
class AuthApiTest {

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

    // ---- status ----

    @Test
    fun statusReportsTheAvailableLoginMethods() = runTest {
        harness.enqueueJson("""{"initialized":true,"methods":["password"]}""")
        val status = api.status()
        assertEquals(true, status?.initialized)
        assertEquals(listOf("password"), status?.methods)
        assertEquals(true, status?.supportsPassword)
        assertEquals(false, status?.supportsOidc)
    }

    @Test
    fun statusRecognisesAnOidcOnlyStack() = runTest {
        harness.enqueueJson("""{"initialized":true,"methods":["oidc"]}""")
        val status = api.status()
        assertFalse(status!!.supportsPassword)
        assertTrue(status.supportsOidc)
    }

    @Test
    fun statusHandlesAStackOfferingBoth() = runTest {
        // The real local stack: {"initialized":true,"methods":["password","oidc"],
        //                        "oidc":{"buttonLabel":"Sign in with SSO"}}
        harness.enqueueJson(
            """{"initialized":true,"methods":["password","oidc"],"oidc":{"buttonLabel":"Sign in with SSO"}}""",
        )
        val status = api.status()!!
        assertTrue(status.supportsPassword)
        assertTrue(status.supportsOidc)
        // The server names its own identity provider — relay it, don't invent wording.
        assertEquals("Sign in with SSO", status.oidcButtonLabel)
    }

    @Test
    fun theSsoButtonFallsBackToGenericWordingWhenTheServerNamesNothing() = runTest {
        harness.enqueueJson("""{"initialized":true,"methods":["oidc"]}""")
        assertEquals("Continue with single sign-on", api.status()!!.oidcButtonLabel)
    }

    @Test
    fun anUnreachableServerYieldsNullStatusRatherThanThrowing() = runTest {
        harness.enqueueDisconnect()
        assertNull(api.status())
    }

    // ---- login ----

    @Test
    fun loginReturnsTokensAndMemberships() = runTest {
        harness.enqueueJson(
            """
            {"accessToken":"acc","refreshToken":"ref","expiresIn":3600,
             "memberships":[{"householdId":"h1","householdName":"The Seinfelds",
                             "personId":"p1","isAdmin":true,"memberType":"adult"}],
             "pendingInvites":[]}
            """.trimIndent(),
        )

        val result = api.login("jerry@seinfeld.demo", "seinfeld123")
        check(result is LoginResult.Success)

        assertEquals(TokenPair("acc", "ref"), result.tokens)
        assertEquals("The Seinfelds", result.memberships.single().householdName)
        assertEquals("p1", result.memberships.single().personId)
        assertTrue(result.memberships.single().isAdmin)
    }

    @Test
    fun loginPostsTheCredentialsAsJson() = runTest {
        harness.enqueueJson("""{"accessToken":"a","refreshToken":"r","memberships":[]}""")
        api.login("jerry@seinfeld.demo", "seinfeld123")

        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/auth/login", request.path)
        val body = request.body.readUtf8()
        assertTrue(body.contains("jerry@seinfeld.demo"))
        assertTrue(body.contains("seinfeld123"))
    }

    @Test
    fun badCredentialsRelayTheServersMessage() = runTest {
        // Never invent our own wording — the server knows why it refused.
        harness.enqueueError(401, "AuthError", "Incorrect email or password.")
        val result = api.login("jerry@seinfeld.demo", "wrong")
        check(result is LoginResult.Failed)
        assertEquals("Incorrect email or password.", result.message)
    }

    @Test
    fun anUnreachableServerFailsWithAUsableMessageNotACrash() = runTest {
        harness.enqueueDisconnect()
        val result = api.login("a@b.c", "x")
        check(result is LoginResult.Failed)
        assertTrue(result.message.isNotBlank())
    }

    @Test
    fun aLoginMissingTokensIsTreatedAsAFailure() = runTest {
        // Defensive: a 200 with no tokens must not read as a successful sign-in.
        harness.enqueueJson("""{"memberships":[]}""")
        assertTrue(api.login("a@b.c", "x") is LoginResult.Failed)
    }
}
