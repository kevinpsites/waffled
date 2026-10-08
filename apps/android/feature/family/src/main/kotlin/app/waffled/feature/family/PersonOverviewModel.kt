package app.waffled.feature.family

import androidx.compose.runtime.Immutable
import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import app.waffled.core.model.WaffledDates
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

@Immutable
data class PersonOverviewSnapshot(
    val overview: FamilyApi.PersonOverview? = null,
    /** Today's chores for this person only. */
    val chores: List<FamilyApi.ChoreInstance> = emptyList(),
    val loading: Boolean = true,
    /** The last load failed; [overview] is then whatever the previous load confirmed. */
    val error: Boolean = false,
) {
    val choresDone: Int get() = chores.count { it.status == "done" }
}

/**
 * The person spotlight's data — `GET /api/persons/:id/overview` plus today's chores. The
 * port of iOS `PersonOverviewModel`. Events come from the synced mirror, not from here.
 *
 * TODO(RestState): `error` is a single flag; adopt RestState when it lands so offline and
 * sign-in-required read differently.
 */
class PersonOverviewModel(
    val personId: String,
    private val fetchOverview: suspend () -> FamilyApi.PersonOverview,
    private val fetchChores: suspend (date: String) -> List<FamilyApi.ChoreInstance>,
    private val today: () -> String,
    private val complete: suspend (id: String) -> Unit = {},
    private val uncomplete: suspend (id: String) -> Unit = {},
    private val refreshBus: RefreshBus? = null,
) {
    private val _state = MutableStateFlow(PersonOverviewSnapshot())
    val state: StateFlow<PersonOverviewSnapshot> = _state.asStateFlow()

    suspend fun load() {
        val (overview, chores) = coroutineScope {
            val o = async { fetchResult(fetchOverview) }
            val c = async { fetchResult { fetchChores(today()) } }
            o.await() to c.await()
        }
        _state.update { prior ->
            if (overview.isSuccess && chores.isSuccess) {
                PersonOverviewSnapshot(
                    overview = overview.getOrThrow(),
                    chores = chores.getOrThrow().filter { it.personId == personId },
                    loading = false,
                    error = false,
                )
            } else {
                prior.copy(loading = false, error = true)
            }
        }
    }

    /**
     * Optimistic check-off from the day list. Returns whether the write landed; only then
     * is the change broadcast, so other chore screens re-fetch for a real change only.
     */
    suspend fun toggleChore(id: String): Boolean {
        val inst = _state.value.chores.firstOrNull { it.id == id } ?: return false
        val wasComplete = inst.status == "done" || inst.status == "awaiting"
        setStatus(id, PersonSpotlight.toggledStatus(inst))
        val write = fetchResult { if (wasComplete) uncomplete(id) else complete(id) }
        if (write.isFailure) {
            setStatus(id, inst.status)
            return false
        }
        refreshBus?.bump(RefreshDomain.Chores)
        load()
        return true
    }

    private fun setStatus(id: String, status: String) {
        _state.update { s -> s.copy(chores = s.chores.map { if (it.id == id) it.copy(status = status) else it }) }
    }

    companion object {
        fun backedBy(personId: String, api: FamilyApi, today: () -> String, refreshBus: RefreshBus?) =
            PersonOverviewModel(
                personId = personId,
                fetchOverview = { api.personOverview(personId) },
                fetchChores = api::choreInstances,
                today = today,
                complete = api::completeChore,
                uncomplete = api::uncompleteChore,
                refreshBus = refreshBus,
            )
    }
}

/** A person's balance joined to its currency definition, in household order. */
@Immutable
data class SpotlightBalance(
    val key: String,
    val symbol: String,
    val label: String,
    val colorHex: String?,
    val amount: Int,
)

/** The spotlight's pure rules, kept out of the composable so they are testable. */
object PersonSpotlight {

    fun firstName(overview: FamilyApi.PersonOverview?): String {
        val name = overview?.person?.name.orEmpty()
        return name.split(' ').firstOrNull { it.isNotEmpty() } ?: name
    }

    fun subtitle(overview: FamilyApi.PersonOverview?): String {
        val parts = buildList {
            overview?.person?.age?.let { add("Age $it") }
            val streak = overview?.topStreak ?: 0
            if (streak > 0) add("🔥 $streak-day streak")
        }
        if (parts.isNotEmpty()) return parts.joinToString(" · ")
        return overview?.person?.memberType?.replaceFirstChar { it.uppercase() } ?: " "
    }

    /** Balances for currencies the household still defines, in its `sortOrder`. */
    fun balances(overview: FamilyApi.PersonOverview): List<SpotlightBalance> {
        val defs = overview.currencies.associateBy { it.key }
        return overview.balances
            .mapNotNull { b -> defs[b.currency]?.let { d -> d to b.balance } }
            .sortedBy { (d, _) -> d.sortOrder }
            .map { (d, amount) -> SpotlightBalance(d.key, d.symbol, d.label, d.color, amount) }
    }

    fun symbol(overview: FamilyApi.PersonOverview?, currency: String): String =
        overview?.currencies?.firstOrNull { it.key == currency }?.symbol?.takeIf { it.isNotEmpty() } ?: "⭐"

    /**
     * Spending your own balance is yours to decide; spending someone else's needs
     * `reward.manage` — the rule the server enforces and the reward shop shows.
     */
    fun maySpend(me: Person?, personId: String): Boolean =
        me != null && (me.id == personId || me.can(Capability.REWARD_MANAGE))

    fun fmt(n: Double?): String = when {
        n == null -> "—"
        n % 1.0 == 0.0 -> n.toLong().toString()
        else -> n.toString()
    }

    fun toggledStatus(inst: FamilyApi.ChoreInstance): String = when {
        inst.status == "done" || inst.status == "awaiting" -> "pending"
        inst.requiresApproval -> "awaiting"
        else -> "done"
    }

    /** An open photo chore can't finish from a tick — the Chores camera flow must. */
    fun needsPhotoToFinish(inst: FamilyApi.ChoreInstance): Boolean =
        inst.requiresPhoto && inst.status == "pending"

    /** The day-list time column, in the household zone. */
    fun eventTime(ev: SyncedEvent, zone: ZoneId, locale: Locale = Locale.getDefault()): String {
        if (ev.allDay) return "All day"
        val start = WaffledDates.parseInstant(ev.startsAt, zone) ?: return "—"
        return WaffledDates.format(start, "h:mm a", zone, locale)
    }

    /**
     * Today's events that are this person's own. iOS also matches joined participants;
     * the Android event row has no participant ids yet, so a joined event is missed.
     */
    fun eventsFor(
        personId: String,
        eventsByDay: Map<LocalDate, List<SyncedEvent>>,
        today: LocalDate,
    ): List<SyncedEvent> = eventsByDay[today].orEmpty().filter { it.involves(personId) }
}
