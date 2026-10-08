package app.waffled.core.design

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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

    private val _pref = MutableStateFlow(ThemePref.fromStored(prefs.getString(THEME_KEY)))

    /**
     * Observable on purpose. Reading a plain `var` in a composable would mean a Settings
     * toggle writes the preference and nothing on screen changes — and the bug would look
     * like it lived in Settings.
     */
    val prefFlow: StateFlow<ThemePref> = _pref.asStateFlow()

    var pref: ThemePref
        get() = _pref.value
        set(value) {
            _pref.value = value
            prefs.putString(THEME_KEY, value.stored)
        }
}
