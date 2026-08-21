package app.waffled.core.design

/**
 * The user's theme preference — the Android twin of `DesignSystem/ThemeStore.swift`.
 *
 * Persisted under `waffled.theme` to match the iOS UserDefaults key (the web uses
 * localStorage `waffled:theme`). Default is [System].
 */
enum class ThemePref(val stored: String) {
    Light("light"),
    Dark("dark"),
    System("system");

    /**
     * `true`/`false` forces dark/light; `null` means follow the device — the analogue of
     * iOS returning a `nil` ColorScheme for [System].
     */
    val forcedDark: Boolean?
        get() = when (this) {
            Light -> false
            Dark -> true
            System -> null
        }

    companion object {
        fun fromStored(value: String?): ThemePref =
            entries.firstOrNull { it.stored == value } ?: System
    }
}

/**
 * Minimal key/value seam so [ThemeStore] is unit-testable without an Android runtime.
 * The app supplies a SharedPreferences-backed implementation.
 */
interface ThemePrefsStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
}

private const val THEME_KEY = "waffled.theme"

class ThemeStore(private val prefs: ThemePrefsStore) {

    var pref: ThemePref = ThemePref.fromStored(prefs.getString(THEME_KEY))
        set(value) {
            field = value
            prefs.putString(THEME_KEY, value.stored)
        }
}
