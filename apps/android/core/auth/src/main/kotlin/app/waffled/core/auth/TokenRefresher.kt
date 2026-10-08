package app.waffled.core.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * An access/refresh pair.
 *
 * `accessToken` is a ~1h HS256 JWT. `refreshToken` is opaque, ~60d, and
 * **single-use / rotating** — every successful refresh returns a new one and invalidates
 * the old.
 */
data class TokenPair(
    val accessToken: String,
    val refreshToken: String,
)

/** Where tokens live. The app supplies a Keystore-encrypted implementation. */
interface TokenStore {
    fun load(): TokenPair?
    fun save(tokens: TokenPair)
    fun clear()
}

/** Test/dev double. Never use this in the app — tokens must be encrypted at rest. */
class InMemoryTokenStore : TokenStore {
    @Volatile private var tokens: TokenPair? = null
    override fun load(): TokenPair? = tokens
    override fun save(tokens: TokenPair) { this.tokens = tokens }
    override fun clear() { tokens = null }
}

/** The refresh could not be attempted or answered (offline, 5xx) — the session is NOT over. */
class RefreshUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** The single network call a refresh needs, kept as a seam so this stays unit-testable. */
interface RefreshBackend {
    /**
     * `POST /api/auth/refresh`. Returns the rotated pair, or null if the refresh token was
     * rejected. Throws [RefreshUnavailableException] when the server couldn't be asked.
     */
    suspend fun refresh(refreshToken: String): TokenPair?
}

/**
 * Refreshes the session, **single-flight**.
 *
 * A burst of 401s must produce exactly ONE call to `/api/auth/refresh`. Because the
 * refresh token rotates and is single-use, parallel refreshes would race: the first
 * rotates the token, and every other caller then presents a spent one and gets signed
 * out. Twin of the iOS `TokenRefresher` actor.
 */
class TokenRefresher(
    private val store: TokenStore,
    private val backend: RefreshBackend,
) {
    private val mutex = Mutex()

    /** Called when the refresh token is rejected — the session is over. */
    var onAuthExpired: (() -> Unit)? = null

    /**
     * Returns the fresh pair, or null when there is none to use right now — the session
     * ended, or the server couldn't be reached (tokens kept for the next attempt).
     *
     * Pass [failedAccessToken] — the token that actually got the 401. Inside the lock we
     * compare it against what is stored: if they differ, somebody already refreshed and
     * the caller is simply behind, so hand back the stored pair instead of spending
     * another round-trip and another rotation.
     *
     * Comparing against the caller's *own* failed token (rather than a value read before
     * the lock) is what makes this correct for **staggered** 401s, not just a
     * simultaneous burst: a caller whose request was in flight during someone else's
     * refresh still recognises that its token is the stale one.
     *
     * Pass null when the caller has no access token to compare — e.g. the PowerSync
     * connector — and a refresh always happens.
     */
    suspend fun refresh(failedAccessToken: String?): TokenPair? = mutex.withLock {
        val current = store.load() ?: return@withLock null

        // Somebody already replaced the token this caller was using.
        if (failedAccessToken != null && current.accessToken != failedAccessToken) {
            return@withLock current
        }

        val rotated = try {
            backend.refresh(current.refreshToken)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Offline or a 5xx: keep the tokens, as iOS does; the next 401 tries again.
            return@withLock null
        }

        // A sign-out or adopt landed while the call was in flight (only this lock rotates):
        // that session wins, and this outcome belonged to the one it replaced. Null, not the
        // new pair, so the old principal's request is never replayed under it.
        if (store.load() != current) return@withLock null

        if (rotated == null) {
            // The refresh token is dead. Don't leave it on disk to be retried.
            store.clear()
            onAuthExpired?.invoke()
            return@withLock null
        }

        store.save(rotated)
        rotated
    }
}
