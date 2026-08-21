package app.waffled.core.sync

import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The two PowerSync endpoints, pinned to the methods the API actually declares
 * (`apps/api/src/modules/powersync/`):
 *
 * ```
 * GET  /api/powersync/token   (powersync.ts:110)
 * POST /api/powersync/crud    (powersync-crud.ts:161)
 * ```
 *
 * The methods differ, and getting the token one wrong fails in the least helpful way
 * possible: REST keeps working, and sync just sits at "Offline" forever while the log
 * says "Not logged in". That is exactly what happened on the first run.
 */
class KtorSyncBackendTest {

    private val harness = ApiTestHarness()
    private lateinit var backend: KtorSyncBackend

    @Before fun setUp() {
        harness.start()
        backend = KtorSyncBackend(
            WaffledHttp.client(harness.tokens, harness.serverAddress),
            harness.tokens,
        )
    }

    @After fun tearDown() = harness.stop()

    @Test
    fun theTokenEndpointIsAGetNotAPost() = runTest {
        harness.enqueueJson("""{"token":"ps-token","powerSyncUrl":"http://192.168.4.150:8190"}""")
        backend.fetchPowerSyncToken()

        val request = harness.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/powersync/token", request.path)
    }

    @Test
    fun bothCallsCarryTheBearerToken() = runTest {
        // Missing auth here fails in the worst way: REST keeps working while PowerSync
        // loops on "Not logged in" and the UI just says Offline. Exactly what happened.
        harness.enqueueJson("""{"token":"t","powerSyncUrl":"http://h:8190"}""")
        backend.fetchPowerSyncToken()
        assertEquals(
            "Bearer test-access-token",
            harness.takeRequest().getHeader("Authorization"),
        )

        harness.enqueueJson("""{"ok":true}""")
        backend.uploadCrud(listOf(CrudOpDto("PUT", "events", "e1", null)))
        assertEquals(
            "Bearer test-access-token",
            harness.takeRequest().getHeader("Authorization"),
        )
    }

    @Test
    fun a401OnTheTokenCallRefreshesAndRetriesOnce() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"token":"t","powerSyncUrl":"http://h:8190"}""")

        assertEquals("t", backend.fetchPowerSyncToken()?.token)
        assertEquals(1, harness.refreshCount.get())
    }

    @Test
    fun theTokenResponseCarriesTheEndpointTheSERVERChooses() = runTest {
        harness.enqueueJson("""{"token":"ps-token","powerSyncUrl":"http://192.168.4.150:8190"}""")
        val resp = backend.fetchPowerSyncToken()
        assertEquals("ps-token", resp?.token)
        // The URL comes from the server, not from our base URL — if it advertises a
        // localhost the device cannot reach, sync silently stays offline.
        assertEquals("http://192.168.4.150:8190", resp?.powerSyncUrl)
    }

    @Test
    fun aFailedTokenFetchReturnsNullSoPowerSyncRetries() = runTest {
        harness.enqueueUnauthorized()
        assertNull(backend.fetchPowerSyncToken())
    }

    @Test
    fun crudIsPostedAsAnOpsEnvelope() = runTest {
        harness.enqueueJson("""{"ok":true}""")
        backend.uploadCrud(
            listOf(CrudOpDto(op = "PUT", table = "events", id = "e1", data = mapOf("title" to "Dinner"))),
        )

        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/powersync/crud", request.path)

        val body = request.body.readUtf8()
        assertTrue(body.contains("\"ops\""))
        assertTrue(body.contains("events"))
        // Keyed on the CLIENT-generated id, so the optimistic local row and the
        // replicated server row are the same row.
        assertTrue(body.contains("e1"))
    }

    @Test
    fun aFailedCrudUploadTHROWSSoTheQueueSurvives() = runTest {
        // This is the whole basis of offline-safe writes: PowerSync only keeps the
        // transaction queued if we throw. Swallowing here loses the user's edits.
        harness.enqueueError(500, "ServerError", "nope")
        assertFailsWith<app.waffled.core.network.WaffledApiException> {
            backend.uploadCrud(listOf(CrudOpDto("PUT", "events", "e1", null)))
        }
    }
}
