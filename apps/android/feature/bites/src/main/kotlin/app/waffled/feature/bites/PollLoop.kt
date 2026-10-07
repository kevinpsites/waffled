package app.waffled.feature.bites

import kotlinx.coroutines.delay

/**
 * Repeats [body] every [everyMillis] until the calling coroutine is cancelled — keeps the
 * control panel in step with what the kid does on the device itself.
 *
 * Sleeps BEFORE the first call: the caller has just done its own initial load. Launch it
 * from a lifecycle-scoped effect so backgrounding the app stops the polling.
 */
object PollLoop {
    suspend fun run(everyMillis: Long, body: suspend () -> Unit) {
        while (true) {
            delay(everyMillis)
            body()
        }
    }
}
