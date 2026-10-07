package app.waffled.feature.bites

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals

/** Port of `PollLoopTests.swift`, on virtual time instead of wall-clock sleeps. */
@OptIn(ExperimentalCoroutinesApi::class)
class PollLoopTest {

    @Test
    fun `repeats the body until the job is cancelled`() = runTest {
        var count = 0
        val job = launch { PollLoop.run(everyMillis = 20) { count++ } }
        advanceTimeBy(121)
        runCurrent()
        job.cancel()
        assertEquals(6, count)

        advanceTimeBy(200)
        assertEquals(6, count)
    }

    @Test
    fun `waits before the first extra call, so it never double-loads on open`() = runTest {
        var count = 0
        val job = launch { PollLoop.run(everyMillis = 200) { count++ } }
        advanceTimeBy(40)
        runCurrent()
        assertEquals(0, count)
        job.cancel()
    }
}
