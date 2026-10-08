package app.waffled.feature.family

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The REST feeds behind optional hub tiles. Photos is core, so it is always loaded and
 * always counted, and deliberately absent here.
 */
data class FamilyRestModules(
    val chores: Boolean,
    val goals: Boolean,
    val rewards: Boolean,
    val lists: Boolean,
) {
    companion object {
        val ALL = FamilyRestModules(chores = true, goals = true, rewards = true, lists = true)
        val NONE = FamilyRestModules(chores = false, goals = false, rewards = false, lists = false)
    }
}

/** What the hub draws — every tile line is derived here so the screen stays declarative. */
@Immutable
data class FamilyHubSnapshot(
    val choresSubtitle: String = "Loading…",
    val goalsSubtitle: String = "Loading…",
    val rewardsSubtitle: String = "Loading…",
    val listsSubtitle: String = "Loading…",
    val photosSubtitle: String = "Loading…",
    val photosCount: Int = 0,
    val loaded: Boolean = false,
    /** Every enabled feed answered on its last fetch — only then may the hub look settled. */
    val isAuthoritative: Boolean = false,
    /** Authoritative AND every enabled feed is genuinely empty. */
    val isEmpty: Boolean = false,
)

/**
 * REST-backed counts for the Family hub tiles — the port of iOS `FamilyHubModel`. None of
 * these are PowerSync tables, so they load over the API, concurrently, on appear, on
 * pull-to-refresh and whenever a `RefreshBus` domain they show is bumped.
 *
 * Fetches are injected so the account/module scoping is drivable from a JVM test; use
 * [backedBy] in `app`.
 */
class FamilyHubModel(
    private val fetchChores: suspend () -> List<FamilyApi.PersonChores>,
    private val fetchGoals: suspend () -> List<FamilyApi.GoalRef>,
    private val fetchStars: suspend () -> List<FamilyApi.FamilyStars>,
    private val fetchLists: suspend () -> List<FamilyApi.ListRef>,
    private val fetchPhotos: suspend () -> List<FamilyApi.PhotoRef>,
) {
    private val chores = FeedSlot<FamilyApi.PersonChores>()
    private val goals = FeedSlot<FamilyApi.GoalRef>()
    private val stars = FeedSlot<FamilyApi.FamilyStars>()
    private val lists = FeedSlot<FamilyApi.ListRef>()
    private val photos = FeedSlot<FamilyApi.PhotoRef>()

    private var modules = FamilyRestModules.ALL
    private var dataScope: Any? = null
    private var generation = 0

    private val _state = MutableStateFlow(FamilyHubSnapshot())
    val state: StateFlow<FamilyHubSnapshot> = _state.asStateFlow()

    /**
     * Load every enabled feed. [scope] is compared with `==` and must change on every
     * sign-in and server change: a new scope wipes confirmed values first, so the next
     * account never sees the last one's data while its own request is in flight.
     */
    suspend fun load(scope: Any, modules: FamilyRestModules) {
        generation += 1
        val mine = generation
        if (dataScope != scope) {
            dataScope = scope
            listOf(chores, goals, stars, lists, photos).forEach { it.reset() }
        }
        this.modules = modules
        publish()

        val results = coroutineScope {
            val c = async { if (modules.chores) fetchResult(fetchChores) else null }
            val g = async { if (modules.goals) fetchResult(fetchGoals) else null }
            val s = async { if (modules.rewards) fetchResult(fetchStars) else null }
            val l = async { if (modules.lists) fetchResult(fetchLists) else null }
            val p = async { fetchResult(fetchPhotos) }
            Results(c.await(), g.await(), s.await(), l.await(), p.await())
        }

        // A newer load (or a new scope) has started since: its answer wins.
        if (mine != generation) return
        results.chores?.let(chores::apply)
        results.goals?.let(goals::apply)
        results.stars?.let(stars::apply)
        results.lists?.let(lists::apply)
        photos.apply(results.photos)
        publish()
    }

    private class Results(
        val chores: Result<List<FamilyApi.PersonChores>>?,
        val goals: Result<List<FamilyApi.GoalRef>>?,
        val stars: Result<List<FamilyApi.FamilyStars>>?,
        val lists: Result<List<FamilyApi.ListRef>>?,
        val photos: Result<List<FamilyApi.PhotoRef>>,
    )

    private fun activeSlots(): List<FeedSlot<*>> = buildList {
        add(photos)
        if (modules.chores) add(chores)
        if (modules.goals) add(goals)
        if (modules.rewards) add(stars)
        if (modules.lists) add(lists)
    }

    private fun publish() {
        val active = activeSlots()
        val authoritative = active.all { it.authoritative }
        _state.value = FamilyHubSnapshot(
            choresSubtitle = chores.subtitle(choresLine()),
            goalsSubtitle = goals.subtitle(goalsLine()),
            rewardsSubtitle = stars.subtitle(rewardsLine()),
            listsSubtitle = lists.subtitle(lists.value.size.let { "$it list${if (it == 1) "" else "s"}" }),
            photosSubtitle = photos.subtitle(photosLine()),
            photosCount = photos.value.size,
            loaded = active.all { it.loaded },
            isAuthoritative = authoritative,
            isEmpty = authoritative && active.all { it.value.isEmpty() },
        )
    }

    private fun choresLine(): String {
        val remaining = chores.value.sumOf { maxOf(0, it.total - it.done) }
        return if (remaining > 0) "$remaining to do today" else "All done today 🎉"
    }

    private fun goalsLine(): String {
        val active = goals.value.size
        if (active == 0) return "No goals yet"
        val featured = goals.value.count { it.isFeatured }
        return if (featured > 0) "$active active · $featured featured" else "$active active"
    }

    private fun rewardsLine(): String {
        val ranked = stars.value.filter { it.stars > 0 }.sortedByDescending { it.stars }
        if (ranked.isEmpty()) return "No stars yet"
        return ranked.take(2).joinToString(" · ") { "${it.name ?: "—"} ${it.stars}" }
    }

    private fun photosLine(): String {
        val count = photos.value.size
        val memory = photos.value.firstNotNullOfOrNull { p -> p.memory?.takeIf { it.isNotEmpty() } }
        return when {
            memory != null -> "“$memory” · $count new"
            count > 0 -> "$count photo${if (count == 1) "" else "s"}"
            else -> "No photos yet"
        }
    }

    companion object {
        fun backedBy(api: FamilyApi) = FamilyHubModel(
            fetchChores = api::choresToday,
            fetchGoals = api::goals,
            fetchStars = api::familyStars,
            fetchLists = api::lists,
            fetchPhotos = api::photos,
        )
    }
}
