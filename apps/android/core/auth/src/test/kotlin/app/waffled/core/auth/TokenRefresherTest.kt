package app.waffled.core.auth

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
        val results = (1..20).map { async { refresher.refresh("access-1") } }.awaitAll()

        assertEquals(1, backend.calls.get(), "refresh must be single-flight")
        assertTrue(results.all { it?.accessToken == "access-2" })
    }

    @Test
    fun theRotatedPairIsPersisted() = runTest {
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val refresher = TokenRefresher(tokens, FakeBackend({ TokenPair("access-2", "refresh-2") }))

        refresher.refresh("access-1")

        assertEquals("access-2", tokens.load()?.accessToken)
        assertEquals("refresh-2", tokens.load()?.refreshToken)
    }

    @Test
    fun aFailedRefreshClearsTheSessionAndSignalsExpiry() = runTest {
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val refresher = TokenRefresher(tokens, FakeBackend({ null }))

        var expired = false
        refresher.onAuthExpired = { expired = true }

        assertNull(refresher.refresh("access-1"))
        assertNull(tokens.load(), "a dead refresh token must not be left on disk")
        assertTrue(expired)
    }

    @Test
    fun aTransientFailureKeepsTheSession() = runTest {
        // Offline, or the server mid-restart: iOS keeps the tokens and retries later.
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val refresher = TokenRefresher(tokens, object : RefreshBackend {
            override suspend fun refresh(refreshToken: String): TokenPair? =
                throw RefreshUnavailableException("offline")
        })
        var expired = false
        refresher.onAuthExpired = { expired = true }

        assertNull(refresher.refresh("access-1"))
        assertEquals(TokenPair("access-1", "refresh-1"), tokens.load())
        assertFalse(expired)
    }

    /** A backend that suspends until the test releases it, so the store can change mid-flight. */
    private class GatedBackend(val result: TokenPair?) : RefreshBackend {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        override suspend fun refresh(refreshToken: String): TokenPair? {
            started.complete(Unit)
            release.await()
            return result
        }
    }

    @Test
    fun aSessionAdoptedDuringARefreshIsNotOverwrittenByTheRotation() = runTest {
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val backend = GatedBackend(TokenPair("access-2", "refresh-2"))
        val refresher = TokenRefresher(tokens, backend)

        val inFlight = async { refresher.refresh("access-1") }
        backend.started.await()
        tokens.save(TokenPair("other-access", "other-refresh")) // a new sign-in lands
        backend.release.complete(Unit)
        inFlight.await()

        assertEquals(TokenPair("other-access", "other-refresh"), tokens.load())
    }

    @Test
    fun aSignOutDuringARefreshIsNotUndoneByTheRotation() = runTest {
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val backend = GatedBackend(TokenPair("access-2", "refresh-2"))
        val refresher = TokenRefresher(tokens, backend)

        val inFlight = async { refresher.refresh("access-1") }
        backend.started.await()
        tokens.clear()
        backend.release.complete(Unit)

        assertNull(inFlight.await())
        assertNull(tokens.load())
    }

    @Test
    fun aRejectionForAReplacedSessionDoesNotEndTheNewOne() = runTest {
        val tokens = store(TokenPair("access-1", "refresh-1"))
        val backend = GatedBackend(result = null)
        val refresher = TokenRefresher(tokens, backend)
        var expired = false
        refresher.onAuthExpired = { expired = true }

        val inFlight = async { refresher.refresh("access-1") }
        backend.started.await()
        tokens.save(TokenPair("other-access", "other-refresh"))
        backend.release.complete(Unit)
        inFlight.await()

        assertEquals(TokenPair("other-access", "other-refresh"), tokens.load())
        assertFalse(expired)
    }

    @Test
    fun refreshingWithNoStoredTokenFailsWithoutCallingTheServer() = runTest {
        val backend = FakeBackend({ TokenPair("nope", "nope") })
        val refresher = TokenRefresher(store(null), backend)

        assertNull(refresher.refresh("access-1"))
        assertEquals(0, backend.calls.get())
    }

    @Test
    fun aLaterBurstRefreshesAgainRatherThanReusingTheFirstFlight() = runTest {
        val backend = FakeBackend({ n -> TokenPair("access-$n", "refresh-$n") })
        val tokens = store(TokenPair("a0", "r0"))
        val refresher = TokenRefresher(tokens, backend)

        // Each caller reports the access token that actually failed for it.
        refresher.refresh(failedAccessToken = "a0")
        refresher.refresh(failedAccessToken = tokens.load()!!.accessToken)

        // Single-flight collapses CONCURRENT callers; it must not cache forever.
        assertEquals(2, backend.calls.get())
    }

    @Test
    fun aStaggered401DoesNotTriggerARedundantRefresh() = runTest {
        // The common production shape, and the one a burst test does NOT cover: caller A
        // refreshes and finishes; caller B — still holding the OLD access token — gets
        // its 401 only afterwards. B must be handed the already-refreshed token, not
        // spend another round-trip (and another rotation) getting an equivalent one.
        val backend = FakeBackend({ n -> TokenPair("access-$n", "refresh-$n") })
        val tokens = store(TokenPair("access-0", "refresh-0"))
        val refresher = TokenRefresher(tokens, backend)

        refresher.refresh(failedAccessToken = "access-0")   // caller A
        val b = refresher.refresh(failedAccessToken = "access-0") // caller B, stale token

        assertEquals(1, backend.calls.get(), "B's token was already refreshed by A")
        assertEquals("access-1", b?.accessToken)
    }

    @Test
    fun callersThatDoNotKnowWhichTokenFailedStillRefresh() = runTest {
        // e.g. the PowerSync connector, which has no access token of its own to compare.
        val backend = FakeBackend({ TokenPair("access-9", "refresh-9") })
        val refresher = TokenRefresher(store(TokenPair("a0", "r0")), backend)

        assertEquals("access-9", refresher.refresh(failedAccessToken = null)?.accessToken)
        assertEquals(1, backend.calls.get())
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
