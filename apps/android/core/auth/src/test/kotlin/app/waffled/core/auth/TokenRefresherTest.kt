package app.waffled.core.auth

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The access token is a ~1h HS256 JWT; the refresh token is opaque, ~60d, and
 * SINGLE-USE/ROTATING. That rotation is why refresh must be single-flight: if a burst of
 * 401s each fired their own refresh, the first would rotate the token and the rest would
 * present an already-spent one and get logged out.
 *
 * Twin of `Sync/TokenRefresher.swift` (an actor on iOS; a Mutex here).
 */
class TokenRefresherTest {

    private class FakeBackend(
        private val result: (Int) -> TokenPair?,
        val calls: AtomicInteger = AtomicInteger(0),
        private val delayMs: Long = 20,
    ) : RefreshBackend {
        override suspend fun refresh(refreshToken: String): TokenPair? {
            val n = calls.incrementAndGet()
            delay(delayMs) // simulate the round-trip so callers genuinely overlap
            return result(n)
        }
    }

    private fun store(initial: TokenPair?) = InMemoryTokenStore().apply {
        if (initial != null) save(initial)
    }

    @Test
    fun aBurstOfConcurrentCallersProducesExactlyOneRefresh() = runTest {
        val backend = FakeBackend({ TokenPair("access-2", "refresh-2") })
        val refresher = TokenRefresher(store(TokenPair("access-1", "refresh-1")), backend)

        // Twenty screens all get a 401 at once.
        val results = (1..20).map { async { refresher.refresh() } }.awaitAll()

        assertEquals(1, backend.calls.get(), "refresh must be single-flight")
        assertTrue(results.all { it?.accessToken == "access-2" })
    }

    @Test
    fun theRotatedPairIsPersisted() = runTest {
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val refresher = TokenRefresher(tokens, FakeBackend({ TokenPair("access-2", "refresh-2") }))

        refresher.refresh()

        assertEquals("access-2", tokens.load()?.accessToken)
        assertEquals("refresh-2", tokens.load()?.refreshToken)
    }

    @Test
    fun aFailedRefreshClearsTheSessionAndSignalsExpiry() = runTest {
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val refresher = TokenRefresher(tokens, FakeBackend({ null }))

        var expired = false
        refresher.onAuthExpired = { expired = true }

        assertNull(refresher.refresh())
        assertNull(tokens.load(), "a dead refresh token must not be left on disk")
        assertTrue(expired)
    }

    @Test
    fun refreshingWithNoStoredTokenFailsWithoutCallingTheServer() = runTest {
        val backend = FakeBackend({ TokenPair("nope", "nope") })
        val refresher = TokenRefresher(store(null), backend)

        assertNull(refresher.refresh())
        assertEquals(0, backend.calls.get())
    }

    @Test
    fun aLaterBurstRefreshesAgainRatherThanReusingTheFirstFlight() = runTest {
        val backend = FakeBackend({ n -> TokenPair("access-$n", "refresh-$n") })
        val refresher = TokenRefresher(store(TokenPair("a0", "r0")), backend)

        refresher.refresh()
        refresher.refresh()

        // Single-flight collapses CONCURRENT callers; it must not cache forever.
        assertEquals(2, backend.calls.get())
    }
}

class InMemoryTokenStoreTest {

    @Test
    fun roundTripsAndClears() {
        val s = InMemoryTokenStore()
        assertNull(s.load())

        s.save(TokenPair("a", "r"))
        assertEquals(TokenPair("a", "r"), s.load())

        s.clear()
        assertNull(s.load())
    }
}
