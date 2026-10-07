package app.waffled.feature.family

import androidx.compose.runtime.Immutable
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The four approval writes, injected so the queue's optimistic flow is testable. */
interface ApprovalActions {
    suspend fun approveRedemption(id: String)
    suspend fun denyRedemption(id: String)
    suspend fun approveChore(id: String)
    suspend fun rejectChore(id: String)
}

@Immutable
data class ApprovalsSnapshot(
    val redemptions: List<FamilyApi.Redemption> = emptyList(),
    val chores: List<FamilyApi.ChoreInstance> = emptyList(),
    val loading: Boolean = true,
    val isAuthoritative: Boolean = false,
) {
    val total: Int get() = redemptions.size + chores.size
    val isEmpty: Boolean get() = total == 0

    /** A missing count must still leave a visible route to the queue. */
    val showsEntryPoint: Boolean get() = !isEmpty || !isAuthoritative
    val showsAllCaughtUp: Boolean get() = isEmpty && isAuthoritative

    val entryTitle: String
        get() = when {
            !isAuthoritative -> "Check approvals"
            total == 1 -> "1 to approve"
            else -> "$total to approve"
        }
}

/**
 * The household's pending approvals — reward purchases awaiting a yes/no and chore
 * completions awaiting a parent's OK. The port of iOS `ApprovalsModel`.
 *
 * Owned by `app`, not by a screen: one instance feeds the hub tile badges, the
 * [ApprovalsBanner] and the [ApprovalsScreen], so all three agree on the count.
 */
class ApprovalsModel(
    private val fetchRedemptions: suspend () -> List<FamilyApi.Redemption>,
    private val fetchChores: suspend () -> List<FamilyApi.ChoreInstance>,
    private val actions: ApprovalActions? = null,
    private val refreshBus: RefreshBus? = null,
) {
    private val redemptions = FeedSlot<FamilyApi.Redemption>()
    private val chores = FeedSlot<FamilyApi.ChoreInstance>()
    private var dataScope: Any? = null
    private var generation = 0
    private var choresEnabled = true
    private var rewardsEnabled = true
    private var answered = false

    private val _state = MutableStateFlow(ApprovalsSnapshot())
    val state: StateFlow<ApprovalsSnapshot> = _state.asStateFlow()

    /**
     * Load each enabled queue. A disabled module is neither fetched nor shown, even if
     * rows from before it was turned off are still held. [scope] follows the same rule as
     * [FamilyHubModel.load]: it changes on every sign-in and server change.
     */
    suspend fun load(scope: Any, choresEnabled: Boolean = true, rewardsEnabled: Boolean = true) {
        generation += 1
        val mine = generation
        if (dataScope != scope) {
            dataScope = scope
            redemptions.reset()
            chores.reset()
            answered = false
        }
        this.choresEnabled = choresEnabled
        this.rewardsEnabled = rewardsEnabled
        publish()

        val (r, c) = coroutineScope {
            val r = async { if (rewardsEnabled) fetchResult(fetchRedemptions) else null }
            val c = async { if (choresEnabled) fetchResult(fetchChores) else null }
            r.await() to c.await()
        }
        if (mine != generation) return
        r?.let(redemptions::apply)
        c?.let(chores::apply)
        answered = true
        publish()
    }

    /**
     * Optimistically clear a reward purchase, run the decision, and on failure re-fetch
     * the true queue. Only a decision that landed is broadcast.
     */
    suspend fun decideRedemption(id: String, approve: Boolean): Boolean {
        val act = actions ?: return false
        redemptions.edit { rows -> rows.filterNot { it.id == id } }
        publish()
        return settle(RefreshDomain.Rewards) {
            if (approve) act.approveRedemption(id) else act.denyRedemption(id)
        }
    }

    /** As [decideRedemption], for a chore check-off ("Not yet" sends it back). */
    suspend fun decideChore(id: String, approve: Boolean): Boolean {
        val act = actions ?: return false
        chores.edit { rows -> rows.filterNot { it.id == id } }
        publish()
        return settle(RefreshDomain.Chores) {
            if (approve) act.approveChore(id) else act.rejectChore(id)
        }
    }

    private suspend fun settle(domain: RefreshDomain, write: suspend () -> Unit): Boolean {
        val ok = fetchResult(write).isSuccess
        if (ok) {
            refreshBus?.bump(domain)
        } else {
            dataScope?.let { load(it, choresEnabled, rewardsEnabled) }
        }
        return ok
    }

    private fun publish() {
        val active = buildList {
            if (rewardsEnabled) add(redemptions)
            if (choresEnabled) add(chores)
        }
        val authoritative = if (active.isEmpty()) answered else active.all { it.authoritative }
        _state.value = ApprovalsSnapshot(
            redemptions = if (rewardsEnabled) redemptions.value else emptyList(),
            chores = if (choresEnabled) chores.value else emptyList(),
            loading = if (active.isEmpty()) !answered else !active.all { it.loaded },
            isAuthoritative = authoritative,
        )
    }

    companion object {
        fun backedBy(api: FamilyApi, refreshBus: RefreshBus?) = ApprovalsModel(
            fetchRedemptions = api::pendingRedemptions,
            fetchChores = api::awaitingChores,
            actions = object : ApprovalActions {
                override suspend fun approveRedemption(id: String) = api.approveRedemption(id)
                override suspend fun denyRedemption(id: String) = api.denyRedemption(id)
                override suspend fun approveChore(id: String) = api.approveChore(id)
                override suspend fun rejectChore(id: String) = api.rejectChore(id)
            },
            refreshBus = refreshBus,
        )
    }
}
