package app.waffled.android

import android.content.Context
import android.content.SharedPreferences
import app.waffled.core.auth.TokenPair
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
     * ⚠️ Placeholder. Tokens MUST be encrypted at rest before this ships — a Keystore
     * AES-GCM wrapper over these prefs. Tracked as the first task of the auth work;
     * deliberately obvious rather than quietly insecure.
     */
    val tokenStore: TokenStore = SharedPrefsTokenStore(prefs)
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

private class SharedPrefsTokenStore(private val prefs: SharedPreferences) : TokenStore {

    override fun load(): TokenPair? {
        val access = prefs.getString(ACCESS, null) ?: return null
        val refresh = prefs.getString(REFRESH, null) ?: return null
        return TokenPair(access, refresh)
    }

    override fun save(tokens: TokenPair) {
        prefs.edit()
            .putString(ACCESS, tokens.accessToken)
            .putString(REFRESH, tokens.refreshToken)
            .apply()
    }

    override fun clear() {
        prefs.edit().remove(ACCESS).remove(REFRESH).apply()
    }

    private companion object {
        const val ACCESS = "waffled.auth.access"
        const val REFRESH = "waffled.auth.refresh"
    }
}
