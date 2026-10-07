package app.waffled.feature.rewards

import androidx.compose.runtime.Immutable
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.RestDomain
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One snapshot of the household reward economy: the currency catalog, everyone's
 * balances, the catalog, what's pending, and (for managers) what's archived.
 *
 * They travel together because every screen needs more than one of them at once — a
 * coin chip is meaningless without the currency's symbol, and a reward tile is
 * meaningless without the viewer's balance.
 */
@Immutable
data class RewardsEconomy(
    val currencies: List<RewardsApi.Currency> = emptyList(),
    val people: List<RewardsApi.PersonBalance> = emptyList(),
    /** Active rewards, already in sort order. */
    val rewards: List<RewardsApi.Reward> = emptyList(),
    val pending: List<RewardsApi.RewardRedemption> = emptyList(),
    /** Archived rewards — always empty for someone without `reward.manage`. */
    val archived: List<RewardsApi.Reward> = emptyList(),
)

/**
 * REST-backed state for the Rewards tab — the port of the iOS `RewardsModel`.
 *
 * Rewards are **not** a PowerSync table, so this loads over the API on appear, on
 * pull-to-refresh, and after every write; and every write bumps
 * [RefreshDomain.Rewards] so other REST-backed screens (a Today balance tile, the
 * person spotlight) re-fetch. Nothing else would ever hear about the change.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule.
 */
class RewardsModel(
    /** Public so the sheets can issue their own writes against one slice. */
    val api: RewardsApi,
    private val refreshBus: RefreshBus? = null,
) {

    private val domain = RestDomain<RewardsEconomy>()

    private val _loading = MutableStateFlow(false)
    private val _error = MutableStateFlow(false)
    private val _revision = MutableStateFlow(0)

    val state: StateFlow<RestDomain.Snapshot<RewardsEconomy>> = domain.state
    val loadingState: StateFlow<Boolean> = _loading.asStateFlow()
    val errorState: StateFlow<Boolean> = _error.asStateFlow()

    /**
     * Bumped once per write, for screens holding state this model doesn't own.
     *
     * The reward shop also fetches a per-person overview (the saving-toward pin), which
     * no reload of this model can refresh for it. Keying its effect on the ECONOMY would
     * be wrong twice over: a write triggers both an explicit refetch and an
     * identity-change refetch, while a write whose reload failed leaves the economy
     * structurally identical and refetches nothing — stale in exactly the case that
     * matters. A monotonic counter fires exactly once per write, either way.
     */
    val revision: StateFlow<Int> = _revision.asStateFlow()

    val economy: RewardsEconomy get() = domain.value ?: RewardsEconomy()
    val loaded: Boolean get() = domain.loaded
    val loading: Boolean get() = _loading.value
    val error: Boolean get() = _error.value

    // ---- lookups ---------------------------------------------------------------

    fun currency(key: String): RewardsApi.Currency? = economy.currencies.firstOrNull { it.key == key }

    /** Only spendable currencies can price a reward — the editor's picker uses these. */
    val spendableCurrencies: List<RewardsApi.Currency> get() = economy.currencies.filter { it.spendable }

    fun person(id: String): RewardsApi.PersonBalance? = economy.people.firstOrNull { it.personId == id }

    /** A person's balance in one currency, from the single earning ledger. */
    fun balance(personId: String, currency: String): Int = RewardsMath.balanceOf(person(personId), currency)

    /** The currency a screen falls back to when nothing is pinned. */
    val defaultCurrencyKey: String
        get() = economy.currencies.firstOrNull { it.isDefault }?.key
            ?: economy.currencies.firstOrNull()?.key
            ?: "stars"

    /** The symbol to draw for a currency key — a star when the household hasn't said. */
    fun symbol(currencyKey: String): String = currency(currencyKey)?.symbol?.takeIf { it.isNotBlank() } ?: "⭐"

    // ---- loading ---------------------------------------------------------------

    /**
     * Fetch the whole economy.
     *
     * The three core reads fan out in parallel (they're independent, and doing them
     * serially triples the wait on a phone). The archived list is fetched **separately
     * and best-effort**: it is `reward.manage`-only, so a kid opening Rewards gets a 403
     * there — which must not flag the page as broken.
     */
    suspend fun load() {
        _loading.value = true
        try {
            val fetched = runCatching {
                coroutineScope {
                    val balances = async { api.balances() }
                    val catalog = async { api.catalog() }
                    val pending = async { api.redemptions(status = "pending") }
                    Triple(balances.await(), catalog.await(), pending.await())
                }
            }
            val core = fetched.getOrNull()
            _error.value = fetched.isFailure

            val next = core?.let { (balances, catalog, pending) ->
                RewardsEconomy(
                    currencies = balances.currencies,
                    people = balances.people,
                    rewards = catalog.sortedBy { it.sortOrder },
                    pending = pending,
                    archived = runCatching { api.archivedRewards() }.getOrDefault(emptyList()),
                )
            }
            // RestDomain contract: a real value replaces; null means the fetch FAILED —
            // keep what we had so a flaky network never blanks the shop, but still mark
            // it loaded so we don't sit on a spinner forever.
            domain.apply(next)
        } finally {
            _loading.value = false
        }
    }

    /**
     * Tell the rest of the app the reward economy moved. Called after every write —
     * including the ones the sheets issue directly against [api].
     */
    fun invalidate() {
        _revision.value += 1
        refreshBus?.bump(RefreshDomain.Rewards)
    }

    // ---- writes ----------------------------------------------------------------

    /**
     * Run a write, then invalidate and reload whatever the outcome.
     *
     * Refreshing even after a failure is deliberate: the server may have applied the
     * change and rejected only the response, and re-reading costs one request next to
     * showing a stale approvals queue.
     */
    private suspend fun write(block: suspend () -> Unit): Boolean = attempt(block) == null

    /** As [write], handing back the failure for a caller that must say why. */
    private suspend fun attempt(block: suspend () -> Unit): Throwable? {
        val failure = runCatching { block() }.exceptionOrNull()
        invalidate()
        load()
        return failure
    }

    /** Create (id == null) or edit a reward. */
    suspend fun saveReward(
        id: String?,
        title: String,
        emoji: String?,
        cost: Int,
        currency: String,
        category: String?,
        requiresApproval: Boolean,
    ): Boolean = write {
        // Costs are whole units; a negative one would be a gift, not a price.
        val safeCost = cost.coerceAtLeast(0)
        if (id == null) {
            api.createReward(title, emoji, safeCost, currency, category, requiresApproval)
        } else {
            api.updateReward(id, title, emoji, safeCost, currency, category, requiresApproval)
        }
    }

    suspend fun archiveReward(id: String): Boolean = write { api.archiveReward(id) }

    suspend fun restoreReward(id: String): Boolean = write { api.restoreReward(id) }

    /**
     * Redeem only — never approve. The server debits at once when the household has
     * approval off and leaves the redemption pending for a parent when it's on.
     *
     * Returns null on success, else the text to show: the server's reason when it gave
     * one, so a refusal never passes for a celebration.
     */
    suspend fun redeem(rewardId: String, personId: String): String? {
        return when (val f = attempt { api.redeem(rewardId, personId) }) {
            null -> null
            is WaffledApiException -> f.userMessage
            else -> REDEEM_FAILED
        }
    }

    suspend fun approve(redemptionId: String): Boolean = write { api.approveRedemption(redemptionId) }

    suspend fun deny(redemptionId: String): Boolean = write { api.denyRedemption(redemptionId) }

    suspend fun awardSpot(personId: String, amount: Int, currency: String?, note: String?): Boolean =
        write { api.awardSpot(personId, amount, currency, note) }

    /** Pin (or clear, with a null [rewardId]) what a person is saving toward. */
    suspend fun setSavingToward(personId: String, rewardId: String?): Boolean =
        write { api.setSavingToward(personId, rewardId) }

    companion object {
        const val REDEEM_FAILED = "That didn't go through. Check your connection and try again."
    }
}
