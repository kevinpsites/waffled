package app.waffled.feature.recipes

import android.content.Context
import app.waffled.core.network.WaffledJson

/**
 * Where a live cook session is written so it survives the process being killed.
 *
 * This is the difference between two things that sound the same: "the timer keeps counting
 * while the app is backgrounded" (which an in-memory coroutine manages) and "the timer is
 * still right after Android reclaims the app mid-simmer" (which only an absolute instant on
 * disk can). [CookSessionStore] writes after **every** mutation, because the kill is never
 * announced.
 *
 * `SharedPreferences` rather than DataStore on purpose: this write is synchronous, tiny,
 * and happens on the same tick as a state change the user just caused. DataStore's
 * suspending API would either need a scope inside the store (making every mutator async for
 * no gain) or a fire-and-forget launch that can lose the last write to the very kill it
 * exists to survive.
 */
class SharedPrefsCookStateStore(context: Context) : CookStateStore {

    private val prefs = context.applicationContext
        .getSharedPreferences("waffled.cook", Context.MODE_PRIVATE)

    override fun load(): CookPersistedState? {
        val raw = prefs.getString(KEY, null) ?: return null
        // A snapshot written by an older build may no longer decode. Losing a cook session
        // is a nuisance; crashing on launch because of one is not a trade worth making.
        return runCatching { WaffledJson.decodeFromString<CookPersistedState>(raw) }.getOrNull()
    }

    override fun save(state: CookPersistedState?) {
        val editor = prefs.edit()
        if (state == null) editor.remove(KEY)
        else editor.putString(KEY, WaffledJson.encodeToString(state))
        // `commit`, not `apply`: the point of this file is to be on disk before the process
        // dies, and `apply` is explicitly allowed to defer that.
        editor.commit()
    }

    private companion object {
        const val KEY = "session"
    }
}
