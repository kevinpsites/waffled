package app.waffled.feature.goals

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest

/**
 * Routes MockWebServer responses BY PATH rather than by arrival order.
 *
 * The goal detail and the review queues both fan their reads out in parallel — they are
 * independent, and doing them serially triples the wait on a phone. That makes arrival
 * order genuinely non-deterministic, so `enqueue`'s FIFO queue hands the activity payload
 * to the detail request roughly half the time and the test fails for reasons that have
 * nothing to do with the code.
 *
 * Anything with no route registered answers a 404 naming the path, so a typo'd route
 * reads as "no route for /api/…" instead of a decoding error twenty frames away.
 */
internal class PathDispatcher : Dispatcher() {

    private val routes = mutableMapOf<String, ArrayDeque<MockResponse>>()

    /** Answer [path] with [body]. Register more than once to answer repeat calls in turn. */
    fun on(path: String, body: String, status: Int = 200) = apply {
        add(
            path,
            MockResponse()
                .setResponseCode(status)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    /** Replace whatever [path] was answering with [body] — for a reload that changes. */
    fun only(path: String, body: String, status: Int = 200) = apply {
        routes.remove(path)
        on(path, body, status)
    }

    /**
     * A 204 for [path]. Built without a body on purpose: MockWebServer throws a
     * ProtocolException for a 204 that carries a Content-Length, which reads as a
     * confusing transport error rather than a bad test.
     */
    fun onNoContent(path: String) = apply { add(path, MockResponse().setResponseCode(204)) }

    fun onError(path: String, status: Int, error: String = "error", message: String? = null) = apply {
        val body = buildString {
            append("""{"error":"$error"""")
            if (message != null) append(""","message":"$message"""")
            append("}")
        }
        add(path, MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body))
    }

    private fun add(path: String, response: MockResponse) {
        routes.getOrPut(path) { ArrayDeque() }.addLast(response)
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val path = request.path?.substringBefore('?').orEmpty()
        // The LAST registered response repeats, so a test that reloads doesn't have to
        // register the same unchanging payload twice.
        val queue = routes[path]
        val next = when {
            queue == null -> null
            queue.size > 1 -> queue.removeFirst()
            else -> queue.firstOrNull()
        }
        return next ?: MockResponse()
            .setResponseCode(404)
            .setHeader("Content-Type", "application/json")
            .setBody("""{"error":"NoRoute","message":"no route for $path"}""")
    }
}
