package app.waffled.core.testing

import app.waffled.core.network.ServerAddressProvider
import app.waffled.core.network.TokenProvider
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.util.concurrent.atomic.AtomicInteger

/**
 * The shared harness for API-layer tests.
 *
 * Every feature module drives its own `…Api.kt` against a real MockWebServer rather than
 * a mocked client — the closest analogue to how this repo tests the API (real routes,
 * real responses, assert on what comes back). Without this, seventeen agents each
 * hand-roll the same fakes.
 *
 * Usage:
 * ```
 * private val harness = ApiTestHarness()
 * private lateinit var api: PhotosApi
 *
 * @Before fun setUp() {
 *     harness.start()
 *     // Build the client yourself — the harness supplies the token and address seams.
 *     api = PhotosApi(WaffledHttp.client(harness.tokens, harness.serverAddress))
 * }
 * @After fun tearDown() = harness.stop()
 *
 * @Test fun loadsPhotos() = runTest {
 *     // Match the REAL response envelope; most routes wrap their list in an object.
 *     harness.enqueueJson("{\"photos\":[{\"id\":\"1\"}]}")
 *     assertEquals("1", api.list().first().id)
 *     assertEquals("/api/photos", harness.takeRequest().path)
 * }
 * ```
 */
class ApiTestHarness(
    /** Access token handed to requests; null simulates being signed out. */
    var accessToken: String? = "test-access-token",
) {
    val server = MockWebServer()

    /** How many times a 401 triggered a refresh — assert single-flight behaviour. */
    val refreshCount = AtomicInteger(0)

    /** What [TokenProvider.refreshAccessToken] returns; null means the session is dead. */
    var refreshedToken: String? = "refreshed-access-token"

    fun start() {
        server.start()
    }

    fun stop() {
        server.shutdown()
    }

    /** The origin MockWebServer is listening on, shaped like a real server address. */
    fun baseUrl(): String = server.url("/").toString().trimEnd('/')

    val serverAddress: ServerAddressProvider = object : ServerAddressProvider {
        override fun baseUrl(): String = this@ApiTestHarness.baseUrl()
    }

    val tokens: TokenProvider = object : TokenProvider {
        override suspend fun accessToken(): String? = this@ApiTestHarness.accessToken
        override suspend fun refreshAccessToken(failedToken: String?): String? {
            refreshCount.incrementAndGet()
            refreshedToken?.let { accessToken = it }
            return refreshedToken
        }
    }

    // ---- queuing responses ----

    fun enqueueJson(body: String, status: Int = 200) {
        server.enqueue(
            MockResponse()
                .setResponseCode(status)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    /** An error shaped like the API's `{error, message}` envelope. */
    fun enqueueError(status: Int, error: String = "error", message: String? = null) {
        val body = buildString {
            append("""{"error":"$error"""")
            if (message != null) append(""","message":"$message"""")
            append("}")
        }
        enqueueJson(body, status)
    }

    fun enqueueUnauthorized() = enqueueError(401, "AuthError", "Missing Bearer token")

    /** Simulate the server being unreachable mid-response. */
    fun enqueueDisconnect() {
        server.enqueue(
            MockResponse().apply {
                socketPolicy = okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START
            },
        )
    }

    fun takeRequest(): RecordedRequest = server.takeRequest()

    val requestCount: Int get() = server.requestCount
}
