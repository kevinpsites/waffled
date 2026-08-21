package app.waffled.android

import android.content.Context
import android.content.SharedPreferences
import app.waffled.core.auth.EncryptedTokenStore
import app.waffled.core.auth.KeyValueStore
import app.waffled.core.auth.KeystoreTokenCrypto
import app.waffled.core.auth.TokenStore
import app.waffled.core.design.ThemePrefsStore
import app.waffled.core.design.ThemeStore
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.ServerAddressProvider
import app.waffled.core.network.ServerUrl
import app.waffled.core.network.ServerUrlVerdict

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

