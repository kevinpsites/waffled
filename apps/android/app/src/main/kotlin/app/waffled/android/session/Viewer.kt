package app.waffled.android.session

import app.waffled.core.model.Person

/** Builds the `me`/`viewer` every feature gates on. */
object Viewer {

    /**
     * The synced row for display (live name/avatar edits) with the REST session's grants —
     * synced persons carry no `is_admin`/`capabilities`. A synced row for someone else
     * (a re-claimed shared device mid-update) never inherits these grants.
     */
    fun merge(synced: Person?, rest: Person?): Person? = when {
        rest == null -> synced
        synced == null || synced.id != rest.id -> rest
        else -> synced.copy(isAdmin = rest.isAdmin, capabilities = rest.capabilities)
    }
}
