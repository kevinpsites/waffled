package app.waffled.core.auth

import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * `POST /api/auth/refresh`: only a rejected refresh token (401/403) ends the session. A
 * dropped connection or a 5xx is "try later" — the iOS `TokenRefresher` keeps the tokens
 * on a network failure for the same reason.
 */
class KtorRefreshBackendTest {

    private val harness = ApiTestHarness(accessToken = null)
    private lateinit var client: HttpClient
    private lateinit var backend: KtorRefreshBackend

    @Before fun setUp() {
        harness.start()
        client = AuthApi.defaultClient(harness.serverAddress)
        backend = KtorRefreshBackend(client)
    }

    @After fun tearDown() {
        client.close()
        harness.stop()
    }

    @Test
    fun aRotatedPairIsReturned() = runTest {
        harness.enqueueJson("""{"accessToken":"a2","refreshToken":"r2"}""")
        assertEquals(TokenPair("a2", "r2"), backend.refresh("r1"))
    }

    @Test
    fun a401MeansTheRefreshTokenIsDead() = runTest {
        harness.enqueueError(401, "Unauthorized", "Invalid refresh token")
        assertNull(backend.refresh("r1"))
    }

    @Test
    fun a403IsAlsoARejection() = runTest {
        harness.enqueueError(403, "Forbidden", "revoked")
        assertNull(backend.refresh("r1"))
    }

    @Test
    fun aServerErrorIsTransientNotARejection() = runTest {
        harness.enqueueError(503, "Unavailable", "restarting")
        assertFailsWith<RefreshUnavailableException> { backend.refresh("r1") }
    }

    @Test
    fun aDroppedConnectionIsTransientNotARejection() = runTest {
        harness.enqueueDisconnect()
        assertFailsWith<RefreshUnavailableException> { backend.refresh("r1") }
    }
}
