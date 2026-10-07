package app.waffled.feature.kiosk

import app.waffled.core.network.RestDomain
import app.waffled.core.network.RestFetch
import app.waffled.core.network.RestState
import app.waffled.feature.family.FamilyApi
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * REST data for the kiosk Family page — port of iOS `KioskFamilyModel`. Each feed is a
 * [RestDomain], so a failed refresh keeps the last confirmed values and a successful
 * empty answer is told apart from a first-load failure. Members and today's events come
 * from PowerSync and are not here.
 */
class KioskFamilyModel(
    private val fetchChores: suspend () -> List<FamilyApi.PersonChores>,
    private val fetchStars: suspend () -> List<FamilyApi.FamilyStars>,
) {
    data class Card(val choresDone: Int, val choresTotal: Int, val stars: Int?)

    data class Snapshot(
        val chores: List<FamilyApi.PersonChores> = emptyList(),
        val stars: List<FamilyApi.FamilyStars> = emptyList(),
        val rest: RestState = RestState.Loading,
    ) {
        /** Chores join on person id; the stars overview only carries the name. */
        fun card(personId: String, name: String): Card {
            val pc = chores.firstOrNull { it.id == personId }
            return Card(pc?.done ?: 0, pc?.total ?: 0, stars.firstOrNull { it.name == name }?.stars)
        }
    }

    private val choresD = RestDomain<List<FamilyApi.PersonChores>>()
    private val starsD = RestDomain<List<FamilyApi.FamilyStars>>()
    private var choresEnabled = true
    private var generation = 0

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state.asStateFlow()

    suspend fun load(choresEnabled: Boolean) {
        generation += 1
        val mine = generation
        this.choresEnabled = choresEnabled
        if (choresEnabled) choresD.beginLoading()
        starsD.beginLoading()
        publish()

        val (chores, stars) = coroutineScope {
            val c = async { RestFetch.result(choresEnabled) { fetchChores() } }
            val s = async { RestFetch.result { fetchStars() } }
            c.await() to s.await()
        }
        // A newer load (e.g. the module was switched off) has started: its answer wins.
        if (mine != generation) return
        chores?.let(choresD::apply)
        starsD.apply(stars)
        publish()
    }

    /** Disabled chores are hidden at once but stay cached, so re-enabling stays truthful. */
    private fun publish() {
        val states = if (choresEnabled) listOf(choresD.restState, starsD.restState) else listOf(starsD.restState)
        _state.value = Snapshot(
            chores = if (choresEnabled) choresD.value.orEmpty() else emptyList(),
            stars = starsD.value.orEmpty(),
            rest = RestState.combined(states),
        )
    }
}
