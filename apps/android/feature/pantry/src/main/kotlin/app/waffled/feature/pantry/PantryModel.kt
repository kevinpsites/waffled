package app.waffled.feature.pantry

import androidx.compose.runtime.Immutable
import app.waffled.core.network.MediaUrl
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.RestDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.ZoneId

/**
 * How an expiry label should read against the palette.
 *
 * The row stores the *tone*, not a `Color`: a colour can only be resolved inside a
 * composable (it comes from the theme's `CompositionLocal`), and the whole point of
 * [PantryRow] is that it is built off the main thread with no Compose context.
 */
enum class ExpiryTone {
    /** Already past. */
    Danger,

    /** Today, or within three days. */
    Warn,

    /** A date far enough out to be ordinary. */
    Plain,
}

/**
 * One pantry row, with every derived value already computed.
 *
 * This is the structural answer to the documented performance trap. On iOS, computing
 * `startOfDay` inside the expiring comparator janked hard on every search keystroke,
 * because filtering and sorting run on each recomposition while the data changes only on
 * load. So all the date math, the allergen matching, the URL resolution and the search
 * text happen ONCE per load, here — and the list, the sort comparator and every
 * composable do an O(1) field read.
 *
 * Adding a derived value to a composable instead of to this class is how the trap comes
 * back.
 */
@Immutable
data class PantryRow(
    val item: PantryApi.Item,
    /** Days until the best-by date (negative once past), or null when there isn't one. */
    val daysToExpiry: Int?,
    /** Days the item has been on hand, or null when it has no added-date. */
    val daysOnHand: Int?,
    /** Expires within three days, or already has. */
    val isSoon: Boolean,
    /** A countable amount at or below the item's own threshold (else the household's). */
    val isLow: Boolean,
    /** On hand at least the household's "been a while" threshold. */
    val isOld: Boolean,
    /** The allergens on this item that the household flags — avoid-list ∪ per-person. */
    val flagged: List<String>,
    /** Who those flagged allergens affect, by name. */
    val affects: List<String>,
    /** The configured section this item files under, or "Other". */
    val section: String,
    /** Absolute URL for the product photo, or null when there is nothing to show. */
    val imageUrl: String?,
    /** Coil's cache key — the storage PATH, never the (possibly signed) URL. */
    val imageCacheKey: String?,
    /** The name-derived emoji shown when there is no photo. */
    val emoji: String,
    /** "Expired" / "Today" / "2 days" / "Jul 22", for a list row. */
    val expiryLabel: String?,
    /** The same, in the detail screen's wording ("2 days left"). */
    val expiryLabelLong: String?,
    val expiryTone: ExpiryTone,
    /** "8 mo" — only meaningful when [isOld]. */
    val ageLabel: String?,
    /** "best by Jul 22" style short date, for the detail's Added / Best by rows. */
    val bestByShort: String?,
    val addedShort: String?,
    /** Lowercased name + brand, so search is a `contains` and not a per-keystroke lowercase. */
    val searchText: String,
) {
    val id: String get() = item.id
    val name: String get() = item.name
    val usedUp: Boolean get() = item.usedUp
    val isMeal: Boolean get() = item.isMeal == true

    /** "2 tubs", "a pinch", or null when there is nothing to say. */
    val amountLabel: String?
        get() = listOf(item.amount.trim(), item.unit.trim())
            .filter { it.isNotEmpty() }
            .takeIf { it.isNotEmpty() }
            ?.joinToString(" ")
}

/** Which group of the pantry is on screen. */
sealed interface PantryFilter {
    data object All : PantryFilter
    data object UseSoon : PantryFilter
    data object RunningLow : PantryFilter
    data object BeenAWhile : PantryFilter
    data class Location(val name: String) : PantryFilter
}

/** The list's sort order. */
enum class PantrySort(val label: String) {
    Expiring("Expiring"),
    Az("A–Z"),
    Recent("Recent"),
    Oldest("Oldest"),
}

/** The badge counts behind the filter chips. */
@Immutable
data class PantryCounts(
    val all: Int = 0,
    val useSoon: Int = 0,
    val runningLow: Int = 0,
    val beenAWhile: Int = 0,
    val byLocation: Map<String, Int> = emptyMap(),
)

/**
 * REST-backed state for the Pantry — the port of the iOS `PantryModel`.
 *
 * Pantry is **online-only**, so this loads over REST on appear, on pull-to-refresh and
 * after every write; every write also bumps `RefreshDomain.Pantry`, because there is no
 * reactive query to tell the Today card that anything changed.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls, so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule. "Today"
 * is injected for the same reason — a derivation that changes meaning at midnight is not
 * a test.
 */
class PantryModel(
    /** Public so the editor and scan sheets can issue writes against one slice. */
    val api: PantryApi,
    private val baseUrl: String,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val refreshBus: RefreshBus? = null,
    private val clock: () -> LocalDate = { LocalDate.now(zone) },
) {

    private val domain = RestDomain<List<PantryRow>>()

    private val _config = MutableStateFlow(PantryApi.ListResponse())
    private val _loading = MutableStateFlow(false)
    private val _error = MutableStateFlow(false)

    /** The rows, wrapped in the shared snapshot the screen collects. */
    val state: StateFlow<RestDomain.Snapshot<List<PantryRow>>> = domain.state

    /** The household's pantry config — sections, allergen context, thresholds. */
    val config: StateFlow<PantryApi.ListResponse> = _config.asStateFlow()

    val loadingState: StateFlow<Boolean> = _loading.asStateFlow()
    val errorState: StateFlow<Boolean> = _error.asStateFlow()

    /** Every row, on-hand and used-up, for logic outside a composable. */
    val rows: List<PantryRow> get() = domain.value.orEmpty()
    val loaded: Boolean get() = domain.loaded
    val loading: Boolean get() = _loading.value
    val error: Boolean get() = _error.value

    val locations: List<String> get() = _config.value.locations
    val locationIcons: Map<String, String> get() = _config.value.locationIcons.orEmpty()
    val allergenPeople: Map<String, List<String>> get() = _config.value.allergenPeople

    /** Household setting: show the Pantry card on Today. Defaults on, so nothing flashes off. */
    val showOnToday: Boolean get() = _config.value.showOnToday

    /**
     * The household's **effective** avoid-set: its declared avoid-list ∪ every allergen a
     * member has. A union, never an override — see [PantryAllergen.avoidSet].
     */
    val avoidSet: Set<String>
        get() = PantryAllergen.avoidSet(_config.value.avoidAllergens, _config.value.allergenPeople)

    // ---- loading ---------------------------------------------------------------------

    suspend fun load() {
        _loading.value = true
        try {
            val fetched = runCatching { api.list() }
            fetched.getOrNull()?.let { response ->
                _config.value = response
                domain.succeeded(derive(response.items, response))
            }
            // RestDomain contract: a failure keeps whatever we already had — a flaky
            // network must never blank a pantry — but still marks loaded, so the screen
            // doesn't sit on a spinner forever.
            if (fetched.isFailure) domain.failed()
            _error.value = fetched.isFailure
        } finally {
            _loading.value = false
        }
    }

    // ---- derivation (once per load) ------------------------------------------------------

    private fun derive(
        items: List<PantryApi.Item>,
        config: PantryApi.ListResponse,
    ): List<PantryRow> {
        // Hoisted out of the loop: `today`, the avoid-set and the stale cutoff are
        // constant for the whole batch, so computing them per item would be the same
        // mistake in a smaller box.
        val today = clock()
        val avoid = PantryAllergen.avoidSet(config.avoidAllergens, config.allergenPeople)
        val staleDays = (config.staleMonths ?: DEFAULT_STALE_MONTHS) * DAYS_PER_MONTH
        val sections = config.locations
        return items.map { item -> row(item, today, avoid, config, staleDays, sections) }
    }

    private fun row(
        item: PantryApi.Item,
        today: LocalDate,
        avoid: Set<String>,
        config: PantryApi.ListResponse,
        staleDays: Double,
        sections: List<String>,
    ): PantryRow {
        val days = PantryExpiry.daysUntil(item.expiresOn, today)
        val age = PantryExpiry.daysSince(item.addedOn, today)
        val flagged = PantryAllergen.flagged(item.allergens.orEmpty(), avoid)
        val amount = item.amount.trim().toDoubleOrNull()
        val (label, longLabel, tone) = expiry(days, item.expiresOn)

        return PantryRow(
            item = item,
            daysToExpiry = days,
            daysOnHand = age,
            isSoon = days != null && days <= SOON_DAYS,
            // Free text ("a pinch") isn't a count, so it can't be running low.
            isLow = amount != null && amount <= (item.lowAt ?: config.lowThreshold),
            isOld = age != null && age >= staleDays,
            flagged = flagged,
            affects = PantryAllergen.affected(flagged, config.allergenPeople),
            section = if (sections.contains(item.location)) item.location else PantrySections.OTHER,
            imageUrl = MediaUrl.resolve(item.imageUrl, baseUrl),
            imageCacheKey = MediaUrl.cacheKey(item.imageUrl),
            emoji = PantryFood.emoji(item.name),
            expiryLabel = label,
            expiryLabelLong = longLabel,
            expiryTone = tone,
            ageLabel = age?.let { PantryExpiry.ageLabel(it) },
            bestByShort = PantryExpiry.shortLabel(item.expiresOn, zone),
            addedShort = PantryExpiry.shortLabel(item.addedOn, zone),
            searchText = (item.name + " " + item.brand.orEmpty()).lowercase(),
        )
    }

    private fun expiry(days: Int?, expiresOn: String?): Triple<String?, String?, ExpiryTone> {
        if (days == null) return Triple(null, null, ExpiryTone.Plain)
        if (days < 0) return Triple("Expired", "Expired", ExpiryTone.Danger)
        if (days == 0) return Triple("Today", "Today", ExpiryTone.Warn)
        if (days <= SOON_DAYS) {
            val unit = if (days == 1) "day" else "days"
            return Triple("$days $unit", "$days $unit left", ExpiryTone.Warn)
        }
        val short = PantryExpiry.shortLabel(expiresOn, zone)
        return Triple(short, short, ExpiryTone.Plain)
    }

    // ---- grouping, filtering, sorting -------------------------------------------------------

    val onHand: List<PantryRow> get() = rows.filter { !it.usedUp }

    /**
     * The rows to draw: the on-hand items narrowed by [filter] and [query], in [sort]
     * order.
     *
     * Every predicate here is a field read. Nothing parses a date, resolves a URL or
     * lowercases a string — that all happened at load.
     */
    fun shown(
        filter: PantryFilter = PantryFilter.All,
        query: String = "",
        sort: PantrySort = PantrySort.Expiring,
    ): List<PantryRow> {
        var out = onHand
        out = when (filter) {
            PantryFilter.All -> out
            PantryFilter.UseSoon -> out.filter { it.isSoon }
            PantryFilter.RunningLow -> out.filter { it.isLow }
            PantryFilter.BeenAWhile -> out.filter { it.isOld }
            is PantryFilter.Location -> out.filter { it.section == filter.name }
        }
        val needle = query.trim().lowercase()
        if (needle.isNotEmpty()) out = out.filter { it.searchText.contains(needle) }
        return sorted(out, sort)
    }

    /** The used-up bucket, narrowed by the same search. */
    fun usedUp(query: String = ""): List<PantryRow> {
        val needle = query.trim().lowercase()
        return rows.filter { it.usedUp && (needle.isEmpty() || it.searchText.contains(needle)) }
    }

    private fun sorted(list: List<PantryRow>, sort: PantrySort): List<PantryRow> = when (sort) {
        PantrySort.Az -> list.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        PantrySort.Recent -> list.sortedByDescending { it.item.createdAt.orEmpty() }
        PantrySort.Oldest -> list.sortedBy { it.item.addedOn.orEmpty() }
        // Dated items first, soonest first, ties broken by name; undated last.
        // `compareBy` with a null-last comparator would read as "no date sorts high",
        // which is the opposite of what an expiry list means, so it is spelled out.
        PantrySort.Expiring -> list.sortedWith(
            Comparator { a, b ->
                val x = a.daysToExpiry
                val y = b.daysToExpiry
                when {
                    x != null && y != null -> if (x != y) x.compareTo(y) else a.name.compareTo(b.name)
                    x != null -> -1
                    y != null -> 1
                    else -> a.name.compareTo(b.name)
                }
            },
        )
    }

    /** Counts for the filter chips, over on-hand items only. */
    fun counts(): PantryCounts {
        var all = 0
        var soon = 0
        var low = 0
        var old = 0
        val byLocation = mutableMapOf<String, Int>()
        for (row in onHand) {
            all++
            if (row.isSoon) soon++
            if (row.isLow) low++
            if (row.isOld) old++
            byLocation[row.section] = (byLocation[row.section] ?: 0) + 1
        }
        return PantryCounts(all, soon, low, old, byLocation)
    }

    /**
     * The sections worth showing: the configured ones in order, plus any stray location
     * that still holds an item, keeping only those with something in them.
     */
    fun sectionsInUse(): List<String> {
        val counts = counts().byLocation
        val configured = locations.filter { (counts[it] ?: 0) > 0 }
        val other = if ((counts[PantrySections.OTHER] ?: 0) > 0) listOf(PantrySections.OTHER) else emptyList()
        return configured + other
    }

    /** The Today card's attention list: use-soon first (soonest first), then merely low. */
    fun needsAttention(): List<PantryRow> {
        val soon = onHand.filter { it.isSoon }.sortedBy { it.daysToExpiry ?: Int.MAX_VALUE }
        val low = onHand.filter { it.isLow && !it.isSoon }.sortedBy { it.name }
        return soon + low
    }

    // ---- writes ------------------------------------------------------------------------------

    /** Swap one item in (or append it), re-deriving its row rather than reusing a stale one. */
    fun replace(updated: PantryApi.Item) {
        val config = _config.value
        val current = rows
        val next = if (current.any { it.id == updated.id }) {
            current.map { if (it.id == updated.id) updated else it.item }
        } else {
            current.map { it.item } + updated
        }
        domain.succeeded(derive(next, config))
    }

    /**
     * Bump a numeric amount by ±1.
     *
     * Stepping at or below one marks the item **used up** rather than letting it sit at
     * zero — an empty jar you still own is not the same as a jar with nothing in it, and
     * used-up rows are recoverable and offer "add to the shopping list".
     */
    suspend fun adjust(row: PantryRow, delta: Double) {
        val current = PantryAmount.parse(row.item.amount) ?: if (delta > 0) 0.0 else 1.0
        val next = current + delta
        if (next <= 0) {
            setUsedUp(row, true)
            return
        }
        patch(row) { put("amount", PantryAmount.format(next)) }
    }

    suspend fun setUsedUp(row: PantryRow, usedUp: Boolean) {
        patch(row) { put("usedUp", usedUp) }
    }

    /** Apply an already-built body (the editor's). */
    suspend fun update(id: String, body: JsonObject): Boolean {
        val result = runCatching { api.update(id, body) }
        result.getOrNull()?.let { replace(it) }
        if (result.isSuccess) invalidate()
        return result.isSuccess
    }

    private suspend fun patch(
        row: PantryRow,
        build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
    ) {
        val result = runCatching { api.update(row.id, PantryApi.patch(build)) }
        result
            .onSuccess {
                replace(it)
                invalidate()
            }
            // A failed patch means we don't know what the server holds; re-read rather
            // than leaving an optimistic value the server never accepted.
            .onFailure { load() }
    }

    /** Optimistic delete, reverted if the server refuses. */
    suspend fun delete(row: PantryRow) {
        val snapshot = rows
        domain.succeeded(snapshot.filterNot { it.id == row.id })
        val result = runCatching { api.delete(row.id) }
        if (result.isFailure) {
            domain.succeeded(snapshot)
        } else {
            invalidate()
        }
    }

    /**
     * Consume rows after a cook. [MODE_SKIP][PantryApi.MODE_SKIP] entries are dropped by
     * the API slice, so the caller can hand over its whole choice map.
     */
    suspend fun consume(choices: List<Pair<String, String>>): Boolean {
        val result = runCatching { api.consume(choices) }
        if (result.isSuccess) {
            invalidate()
            load()
        }
        return result.isSuccess
    }

    private fun invalidate() {
        refreshBus?.bump(RefreshDomain.Pantry)
    }

    companion object {
        /** "Use soon" means three days or fewer — including already past. */
        const val SOON_DAYS = 3

        private const val DEFAULT_STALE_MONTHS = 6.0
        private const val DAYS_PER_MONTH = 30.44
    }
}
