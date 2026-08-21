package app.waffled.core.auth

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

/** The single network call a refresh needs, kept as a seam so this stays unit-testable. */
interface RefreshBackend {
    /** `POST /api/auth/refresh`. Returns the rotated pair, or null if it was rejected. */
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
     * Returns the fresh pair, or null if the session is finished.
     *
     * Callers that arrive while a refresh is in flight wait for it and get its result,
     * rather than starting their own.
     */
    suspend fun refresh(): TokenPair? {
        val before = store.load()

        return mutex.withLock {
            val current = store.load()

            // Someone else refreshed while we waited for the lock — take their result.
            if (current != null && before != null && current.accessToken != before.accessToken) {
                return@withLock current
            }

            val refreshToken = current?.refreshToken ?: return@withLock null

            val rotated = backend.refresh(refreshToken)
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
}
