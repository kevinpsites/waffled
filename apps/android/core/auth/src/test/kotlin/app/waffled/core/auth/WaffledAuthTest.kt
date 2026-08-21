package app.waffled.core.auth

import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * `WaffledAuth` is the adapter that lets `core:network`'s `TokenProvider` be satisfied by
 * the token store + refresher.
 *
 * Without it every feature ViewModel would have to wire its own — the pilot agent hit
 * exactly this on its first screen, so it belongs in Phase 0.
 */
class WaffledAuthTest {

    private class FakeBackend(val result: (Int) -> TokenPair?) : RefreshBackend {
        val calls = AtomicInteger(0)
        override suspend fun refresh(refreshToken: String): TokenPair? = result(calls.incrementAndGet())
    }

    private fun auth(initial: TokenPair?, backend: RefreshBackend): Pair<WaffledAuth, TokenStore> {
        val store = InMemoryTokenStore().apply { initial?.let { save(it) } }
        return WaffledAuth(store, TokenRefresher(store, backend)) to store
    }

    @Test
    fun accessTokenComesFromTheStore() = runTest {
        val (a, _) = auth(TokenPair("access-1", "refresh-1"), FakeBackend { null })
        assertEquals("access-1", a.accessToken())
    }

    @Test
    fun accessTokenIsNullWhenSignedOut() = runTest {
        val (a, _) = auth(null, FakeBackend { null })
        assertNull(a.accessToken())
    }

    @Test
    fun refreshReturnsTheNewAccessTokenAsAString() = runTest {
        // TokenProvider speaks in Strings; TokenRefresher speaks in TokenPairs. Bridging
        // the two is this class's whole reason to exist.
        val (a, store) = auth(TokenPair("access-1", "refresh-1"), FakeBackend { TokenPair("access-2", "refresh-2") })
        assertEquals("access-2", a.refreshAccessToken("access-1"))
        assertEquals("access-2", store.load()?.accessToken)
    }

    @Test
    fun refreshPassesTheFailedTokenSoStaggered401sDoNotDoubleRefresh() = runTest {
        val backend = FakeBackend { n -> TokenPair("access-$n", "refresh-$n") }
        val (a, _) = auth(TokenPair("access-0", "refresh-0"), backend)

        a.refreshAccessToken("access-0") // caller A
        a.refreshAccessToken("access-0") // caller B, still holding access-0

        assertEquals(1, backend.calls.get())
    }

    @Test
    fun aDeadSessionReportsNullAndClears() = runTest {
        val (a, store) = auth(TokenPair("access-1", "refresh-1"), FakeBackend { null })
        assertNull(a.refreshAccessToken("access-1"))
        assertNull(store.load())
    }

    @Test
    fun signOutClearsTheStore() = runTest {
        val (a, store) = auth(TokenPair("access-1", "refresh-1"), FakeBackend { null })
        a.signOut()
        assertNull(store.load())
        assertNull(a.accessToken())
    }

    @Test
    fun signedInReflectsWhetherThereIsAToken() = runTest {
        val (signedIn, _) = auth(TokenPair("a", "r"), FakeBackend { null })
        val (signedOut, _) = auth(null, FakeBackend { null })
        assertEquals(true, signedIn.isSignedIn())
        assertEquals(false, signedOut.isSignedIn())
    }
}
