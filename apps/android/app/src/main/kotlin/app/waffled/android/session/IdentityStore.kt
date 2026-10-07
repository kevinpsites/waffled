package app.waffled.android.session

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.Person
import app.waffled.core.sync.SyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import java.time.ZoneId

/**
 * Who is signed in and what the household has switched on — the iOS
 * `SyncManager.loadIdentity()` / `reloadModules()`, which `core:sync` does not do.
 *
 * Pushes the REST answer into [SyncManager] (current person, module flags, zone) so every
 * existing consumer of those flows sees it, and backfills the roster over REST when
 * PowerSync hasn't delivered one (an Offline sync must not leave every screen person-less).
 */
class IdentityStore(
    private val api: HouseholdApi,
    private val sync: SyncManager,
    scope: CoroutineScope,
) {
    private val _restPerson = MutableStateFlow<Person?>(null)
    private val _restWeekStart = MutableStateFlow<String?>(null)
    private val _rewardsEnabled = MutableStateFlow(true)

    /** `settings.chores.rewards`; combine with the chores module for "rewards on". */
    val rewardsEnabled: StateFlow<Boolean> = _rewardsEnabled.asStateFlow()

    /** The `me` / `viewer` handed to every feature — see [Viewer.merge]. */
    val viewer: StateFlow<Person?> =
        combine(sync.currentPerson, _restPerson, Viewer::merge)
            .stateIn(scope, SharingStarted.Eagerly, null)

    /** Null until either the synced row or the REST read says — see [weekStart]. */
    val householdWeekStart: StateFlow<HouseholdWeekStart?> =
        combine(sync.householdWeekStart, _restWeekStart, ::weekStart)
            .stateIn(scope, SharingStarted.Eagerly, null)

    /** Read once and on every deliberate refresh. A failed read keeps what we had. */
    suspend fun load() {
        val id = runCatching { api.identity() }.getOrNull() ?: return
        _restPerson.value = id.person
        _rewardsEnabled.value = id.rewardsEnabled
        _restWeekStart.value = id.weekStart
        id.person?.let { sync.setCurrentPerson(it.id) }
        sync.setModules(id.modules)
        id.timezone?.let { tz -> runCatching { ZoneId.of(tz) }.getOrNull()?.let(sync::setHouseholdZone) }
        if (sync.members.value.isEmpty()) {
            runCatching { api.persons() }.getOrNull()?.takeIf { it.isNotEmpty() }?.let(sync::setMembers)
        }
    }

    /** Clears the session's identity on sign-out so the next person never sees it. */
    fun clear() {
        _restPerson.value = null
        _restWeekStart.value = null
        sync.setCurrentPerson(null)
    }

    companion object {
        fun weekStart(synced: String?, rest: String?): HouseholdWeekStart? =
            (synced ?: rest)?.let(HouseholdWeekStart::parse)
    }
}
