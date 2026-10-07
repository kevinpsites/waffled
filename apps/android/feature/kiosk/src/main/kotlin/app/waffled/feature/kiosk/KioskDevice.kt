package app.waffled.feature.kiosk

import app.waffled.core.auth.KeyValueStore
import app.waffled.core.auth.TokenCrypto
import app.waffled.core.network.ApiErrorText
import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledJson
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import java.util.Base64

/**
 * The shared-kiosk **device identity** — separate from any person's session. Pairing
 * stores a long-lived `deviceSecret`, sealed with [crypto] like the person tokens, which
 * [KioskDeviceAuth] trades for short-lived device tokens.
 *
 * KEEP IN SYNC with iOS `KioskDevice.swift` and the web kiosk client.
 */
class KioskDeviceStore(private val prefs: KeyValueStore, private val crypto: TokenCrypto) {

    /** Unreadable (a lost Keystore key, tampering) reads as unpaired and is cleared. */
    val secret: String?
        get() {
            val sealed = prefs.getString(SECRET_KEY) ?: return null
            return runCatching { String(crypto.decrypt(Base64.getDecoder().decode(sealed)), Charsets.UTF_8) }
                .getOrElse {
                    prefs.remove(SECRET_KEY)
                    null
                }
        }

    val isPaired: Boolean get() = secret != null

    var label: String?
        get() = prefs.getString(LABEL_KEY)
        set(value) {
            val v = value?.trim()
            if (v.isNullOrEmpty()) prefs.remove(LABEL_KEY) else prefs.putString(LABEL_KEY, v)
        }

    fun savePaired(secret: String, label: String?) {
        val sealed = crypto.encrypt(secret.toByteArray(Charsets.UTF_8))
        prefs.putString(SECRET_KEY, Base64.getEncoder().encodeToString(sealed))
        this.label = label
    }

    fun clear() {
        prefs.remove(SECRET_KEY)
        prefs.remove(LABEL_KEY)
    }

    companion object {
        const val SECRET_KEY = "waffled.kiosk.deviceSecret"
        const val LABEL_KEY = "waffled.kiosk.deviceLabel"
    }
}

/**
 * Mints and caches the device access token from the stored secret
 * (`POST /api/kiosk/device/token`, no bearer — the secret IS the credential). Single
 * flight, so concurrent profile polls share one mint.
 */
class KioskDeviceAuth(private val client: HttpClient, private val store: KioskDeviceStore) {

    class NotPaired : Exception("This device is not paired as a kiosk.")

    @Serializable private data class TokenRequest(val deviceSecret: String)

    @Serializable private data class TokenResponse(val accessToken: String, val expiresIn: Int? = null)

    private val mutex = Mutex()

    @Volatile private var cached: String? = null

    suspend fun token(): String = cached ?: refresh(failedToken = null)

    /**
     * Mint a fresh token. With [failedToken], a caller whose token was already replaced
     * by a concurrent mint just gets the current one.
     */
    suspend fun refresh(failedToken: String? = null): String = mutex.withLock {
        cached?.let { current -> if (failedToken != null && current != failedToken) return@withLock current }
        val secret = store.secret ?: throw NotPaired()
        val response = client.post("api/kiosk/device/token") {
            contentType(ContentType.Application.Json)
            setBody(TokenRequest(secret))
        }
        val text = runCatching { response.bodyAsText() }.getOrNull()
        if (response.status.value != 200) {
            cached = null
            throw WaffledApiException(response.status.value, ApiErrorText.from(text, response.status.value))
        }
        val token = WaffledJson.decodeFromString(TokenResponse.serializer(), text.orEmpty()).accessToken
        cached = token
        token
    }

    fun invalidate() {
        cached = null
    }

    /**
     * The device credential as a [TokenProvider], for device-authed calls where a 401
     * means a stale token (profiles, label, heartbeat). A dead device reads as "no token"
     * so the original 401 surfaces.
     */
    val asTokenProvider: TokenProvider = object : TokenProvider {
        override suspend fun accessToken(): String = token()
        override suspend fun refreshAccessToken(failedToken: String?): String? =
            try {
                refresh(failedToken)
            } catch (e: WaffledApiException) {
                null
            }
    }
}
