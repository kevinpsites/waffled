package app.waffled.android

import android.content.Context
import android.content.SharedPreferences
import app.waffled.core.auth.AuthApi
import app.waffled.core.auth.EncryptedTokenStore
import app.waffled.core.auth.KtorRefreshBackend
import app.waffled.core.auth.TokenRefresher
import app.waffled.core.auth.WaffledAuth
import app.waffled.core.auth.KeyValueStore
import app.waffled.core.auth.KeystoreTokenCrypto
import app.waffled.core.auth.TokenStore
import app.waffled.core.design.ThemePrefsStore
import app.waffled.core.design.ThemeStore
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.ServerAddressProvider
import app.waffled.core.network.ServerUrl
import app.waffled.core.network.ServerUrlVerdict
import app.waffled.core.network.WaffledHttp
import app.waffled.core.sync.KtorSyncBackend
import app.waffled.core.sync.SyncManager
import app.waffled.core.sync.WaffledConnector
import app.waffled.feature.photos.PhotosApi
import app.waffled.feature.photos.PhotosModel
import io.ktor.client.HttpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Hand-rolled dependency container.
 *
 * Deliberately not Hilt: KSP's newest release lags Kotlin 2.4.10, and annotation
 * processors are exactly what breaks on a bleeding-edge Kotlin. This also keeps each
 * feature module's build file trivial, which matters with many parallel agents.
 *
 * Construct once in [WaffledApp] and pass down; feature ViewModels take what they need
 * as constructor arguments.
 */
class AppContainer(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("waffled.prefs", Context.MODE_PRIVATE)

    val themeStore: ThemeStore = ThemeStore(
        object : ThemePrefsStore {
            override fun getString(key: String): String? = prefs.getString(key, null)
            override fun putString(key: String, value: String) {
                prefs.edit().putString(key, value).apply()
            }
        },
    )

    /** Bumped by writers so REST-backed screens know to re-fetch. */
    val refreshBus = RefreshBus()

    val serverAddress: MutableServerAddress = MutableServerAddress(prefs)

    /**
     * Tokens encrypted at rest under a key held in the Android Keystore — the analogue
     * of the iOS Keychain.
     */
    val tokenStore: TokenStore = EncryptedTokenStore(
        prefs = SharedPrefsKeyValueStore(prefs),
        crypto = KeystoreTokenCrypto(),
    )

    /** `/api/auth` — its own bare client; signing in must not itself need a token. */
    val authApi: AuthApi = AuthApi(serverAddress)

    /**
     * The one [app.waffled.core.network.TokenProvider] the app shares. Feature
     * ViewModels take this (or [httpClient]) rather than assembling their own auth.
     */
    val auth: WaffledAuth = WaffledAuth(
        store = tokenStore,
        refresher = TokenRefresher(
            store = tokenStore,
            backend = KtorRefreshBackend(AuthApi.defaultClient(serverAddress)),
        ),
    )

    /** The authenticated client every feature API slice should use. */
    val httpClient: HttpClient by lazy { WaffledHttp.client(auth, serverAddress) }

    /**
     * PowerSync — the five synced tables (Calendar + People). Started once the user is
     * signed in; everything else in the app is REST.
     */
    val syncManager: SyncManager by lazy {
        SyncManager(
            context = context.applicationContext,
            connector = WaffledConnector(KtorSyncBackend(httpClient, auth)),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
    }

    /**
     * Photos — the reference feature. One line per feature is the intended shape: build
     * the API slice from the shared client, hand it the base URL and the refresh bus.
     */
    val photosModel: PhotosModel by lazy {
        PhotosModel(
            api = PhotosApi(httpClient, auth),
            baseUrl = serverAddress.baseUrl(),
            refreshBus = refreshBus,
        )
    }
}

private class SharedPrefsKeyValueStore(
    private val prefs: SharedPreferences,
) : KeyValueStore {
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }
    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
}

/** Server address, user-editable at runtime because Waffled is self-hosted. */
class MutableServerAddress(private val prefs: SharedPreferences) : ServerAddressProvider {

    override fun baseUrl(): String =
        prefs.getString(KEY, null) ?: BuildConfig.DEFAULT_SERVER_URL

    /**
     * Validate and store. Returns the verdict so the settings screen can explain a
     * refusal — notably plain HTTP to a public host (see ServerUrl).
     */
    fun set(input: String): ServerUrlVerdict {
        val verdict = ServerUrl.validate(input)
        if (verdict is ServerUrlVerdict.Ok) {
            prefs.edit().putString(KEY, verdict.url).apply()
        }
        return verdict
    }

    private companion object {
        const val KEY = "waffled.serverUrl"
    }
}

