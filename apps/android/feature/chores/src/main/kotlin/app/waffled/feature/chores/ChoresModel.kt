package app.waffled.feature.chores

import androidx.compose.runtime.Immutable
import app.waffled.core.model.Person
import app.waffled.core.network.MediaUrl
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.RestDomain
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/**
 * One row on the board: the wire instance plus everything the list would otherwise have
 * to compute per frame.
 *
 * Resolving the proof URL and formatting the due/overdue labels **at load time** is the
 * point. A lazy list recomposes constantly, and doing date math per row is the documented
 * iOS performance trap; here the row only reads fields.
 */
@Immutable
data class ChoreRow(
    val instance: ChoresApi.ChoreInstance,
    /** Absolute URL for the proof photo, or null when there is nothing to show. */
    val proofImageUrl: String?,
    /**
     * Coil's cache key — the storage PATH, never the (possibly signed) URL. A signed URL
     * carries an expiry, so keying on it means the key changes every load and the cache
     * never hits. That is how expiring URLs broke the photo screensaver on web.
     */
    val proofCacheKey: String?,
    /** "4:30 PM", or null when the chore has no set time. */
    val dueTimeLabel: String?,
    /** "since yesterday" for a carried-forward one-off, else null. */
    val overdueLabel: String?,
    /** "due Tue" for a future-dated one-off already on the list, else null. */
    val upcomingLabel: String?,
) {
    val id: String get() = instance.id
    val choreId: String get() = instance.choreId
    val title: String get() = instance.choreTitle
    val emoji: String? get() = instance.emoji
    val personId: String? get() = instance.personId
    val personName: String? get() = instance.personName
    val status: String get() = instance.status
    val streak: Int get() = instance.streak
    val rewardAmount: Int get() = instance.rewardAmount
    val rewardCurrency: String? get() = instance.rewardCurrency
    val requiresPhoto: Boolean get() = instance.requiresPhoto
    val isDone: Boolean get() = instance.isDone
    val isAwaiting: Boolean get() = instance.isAwaiting

    /** A photo was attached but has since expired server-side. */
    val proofExpired: Boolean get() = proofImageUrl == null && instance.hadProof

    /** The tick must capture a photo before this chore can finish. */
    val needsPhotoToFinish: Boolean
        get() = instance.requiresPhoto && !instance.isDone && !instance.isAwaiting
}

/** A person's (or the up-for-grabs) column of chores for the day. */
@Immutable
data class ChoreColumn(
    val id: String,
    val name: String,
    val emoji: String?,
    val colorHex: String?,
    val isGrabs: Boolean,
    val items: List<ChoreRow>,
) {
    val done: Int get() = items.count { it.isDone }
    val allDone: Boolean get() = items.isNotEmpty() && done == items.size
}

/** Grouping the day's rows into columns — pure, so the ordering rule is testable. */
object ChoreColumns {

    /** The synthetic column id for chores nobody has taken. */
    const val GRABS_ID = "__grabs__"

    /**
     * Up for grabs first, then every household member in order, then any orphans.
     *
     * Up for grabs leads **even when empty**: anyone-can-claim chores need a home to be
     * added to, which is how the web board behaves. An orphan column catches a chore
     * assigned to someone who is no longer in the member list, so their work can't
     * vanish off the board.
     */
    fun build(rows: List<ChoreRow>, members: List<Person>): List<ChoreColumn> {
        val byPerson = LinkedHashMap<String, MutableList<ChoreRow>>()
        val grabs = mutableListOf<ChoreRow>()
        for (row in rows) {
            val personId = row.personId
            if (personId == null) grabs += row else byPerson.getOrPut(personId) { mutableListOf() } += row
        }

        val columns = mutableListOf(
            ChoreColumn(
                id = GRABS_ID,
                name = "Up for grabs",
                emoji = "🙌",
                colorHex = null,
                isGrabs = true,
                items = grabs,
            ),
        )

        val seen = mutableSetOf<String>()
        for (member in members) {
            seen += member.id
            columns += ChoreColumn(
                id = member.id,
                name = member.name,
                emoji = member.avatarEmoji,
                colorHex = member.colorHex,
                isGrabs = false,
                items = byPerson[member.id].orEmpty(),
            )
        }
        for ((personId, items) in byPerson) {
            if (personId in seen) continue
            columns += ChoreColumn(
                id = personId,
                name = items.firstOrNull()?.personName ?: "Someone",
                emoji = null,
                colorHex = null,
                isGrabs = false,
                items = items,
            )
        }
        return columns
    }
}

/**
 * REST-backed state for the chores board — the port of iOS `ChoresModel` (plus the chore
 * half of `ApprovalsModel`).
 *
 * Chores are **online-only**, so the board loads over the API on appear, on
 * pull-to-refresh, on every day step, and after every write. Every write also bumps
 * `RefreshDomain.Chores`, because no reactive query exists to tell the Today card or the
 * tab badge that anything changed.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls, so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule.
 */
class ChoresModel(
    /** Public so the editor and proof sheets can issue writes against one slice. */
    val api: ChoresApi,
    private val baseUrl: String,
    initialDate: String,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val locale: Locale = Locale.getDefault(),
    /**
     * Bumped after every write so other REST-backed screens re-fetch. Optional only so a
     * test can leave it out.
     */
    private val refreshBus: RefreshBus? = null,
    /** "Today", injected so the date stepper is testable without touching the clock. */
    private val clock: () -> LocalDate = { LocalDate.now(zone) },
) {

    private val domain = RestDomain<List<ChoreRow>>()

    private val _date = MutableStateFlow(initialDate)
    private val _awaiting = MutableStateFlow<List<ChoreRow>>(emptyList())
    private val _currencies = MutableStateFlow<List<ChoresApi.Currency>>(emptyList())
    private val _loading = MutableStateFlow(false)
    private val _error = MutableStateFlow(false)
    private val _proofError = MutableStateFlow<String?>(null)

    /** The day being viewed, `yyyy-MM-dd`. */
    val date: StateFlow<String> = _date.asStateFlow()

    /**
     * The day's rows, sorted with their labels precomputed, wrapped in the shared
     * [RestDomain] snapshot the screen collects.
     */
    val state: StateFlow<RestDomain.Snapshot<List<ChoreRow>>> = domain.state

    /** The current rows, for logic that isn't inside a composable. */
    val rows: List<ChoreRow> get() = domain.value.orEmpty()

    /** Whether we have ever loaded — drives spinner vs empty state. */
    val loaded: Boolean get() = domain.loaded

    /** Every completion awaiting a parent's OK, across all dates. */
    val awaiting: StateFlow<List<ChoreRow>> = _awaiting.asStateFlow()

    val currencies: StateFlow<List<ChoresApi.Currency>> = _currencies.asStateFlow()
    val loadingState: StateFlow<Boolean> = _loading.asStateFlow()
    val errorState: StateFlow<Boolean> = _error.asStateFlow()

    val loading: Boolean get() = _loading.value
    val error: Boolean get() = _error.value

    /**
     * A dismissible banner for a failed proof upload — including the 422 "a photo is
     * required" guard. Mirrors the web board's `proofErr`.
     */
    val proofError: StateFlow<String?> = _proofError.asStateFlow()

    /** The header's labels for the day being viewed. */
    fun meta(): ChoreDates.DayMeta = ChoreDates.meta(_date.value, clock(), locale)

    /** The symbol to draw beside a reward amount; falls back to a star. */
    fun currencySymbol(key: String?): String {
        val list = _currencies.value
        val match = key?.let { k -> list.firstOrNull { it.key == k } }
            ?: list.firstOrNull { it.isDefault }
        return match?.symbol ?: "⭐"
    }

    fun dismissProofError() {
        _proofError.value = null
    }

    // ---- loading -------------------------------------------------------------------

    suspend fun load() {
        _loading.value = true
        try {
            val fetched = runCatching { api.instances(_date.value) }
            // RestDomain contract: a real list (even an empty one) replaces; null means
            // the fetch FAILED — keep what we had so a flaky network never blanks the
            // board, but still mark it loaded so we don't sit on a spinner forever.
            domain.apply(fetched.getOrNull()?.let(::toRows))
            _error.value = fetched.isFailure
        } finally {
            _loading.value = false
        }
    }

    /** The approvals queue. Safe to call for anyone — the server scopes what it returns. */
    suspend fun loadAwaiting() {
        runCatching { api.awaiting() }
            .onSuccess { _awaiting.value = toRows(it) }
    }

    /** The household's reward currencies. Loaded once; failure just leaves the star. */
    suspend fun loadCurrencies() {
        runCatching { api.currencies() }.onSuccess { _currencies.value = it }
    }

    suspend fun shift(days: Int) {
        _date.value = ChoreDates.shift(_date.value, days)
        load()
    }

    suspend fun goToday() {
        _date.value = clock().toString()
        load()
    }

    // ---- writes ---------------------------------------------------------------------

    /**
     * Optimistic complete / uncomplete — a chore needing approval lands in "awaiting" —
     * then reload to pick up the true stars, streak and status.
     */
    suspend fun toggle(row: ChoreRow) {
        val previous = row.status
        val isComplete = previous == ChoresApi.STATUS_DONE || previous == ChoresApi.STATUS_AWAITING
        val next = when {
            isComplete -> ChoresApi.STATUS_PENDING
            row.instance.requiresApproval -> ChoresApi.STATUS_AWAITING
            else -> ChoresApi.STATUS_DONE
        }
        setStatus(row.id, next)

        val sent = runCatching {
            if (isComplete) api.uncomplete(row.id) else api.complete(row.id)
        }
        if (sent.isFailure) {
            // Put the row back the way it was; the server never accepted the change.
            setStatus(row.id, previous)
            return
        }
        invalidate()
        load()
    }

    /**
     * Assign (or reassign) a chore to a person **without** completing it — the drop
     * gesture. A no-op when it is already theirs, so a stray drop costs no request.
     */
    suspend fun assign(id: String, personId: String) {
        val row = rows.firstOrNull { it.id == id } ?: return
        if (row.personId == personId) return
        write { api.assign(id, personId) }
    }

    /** Send a chore back to up-for-grabs. A no-op when it is already unassigned. */
    suspend fun unassign(id: String) {
        val row = rows.firstOrNull { it.id == id } ?: return
        if (row.personId == null) return
        write { api.assign(id, null) }
    }

    /** Claim an up-for-grabs chore for a person and mark it done in one motion. */
    suspend fun claimComplete(id: String, personId: String) {
        write {
            api.claim(id, personId)
            api.complete(id)
        }
    }

    /**
     * Finish a photo-required chore with an already-encoded image: upload the blob, then
     * complete with it (claiming [claimFor] first on the up-for-grabs path).
     *
     * Takes the encoded bytes rather than a `Uri` so the whole flow is testable on the
     * JVM — encoding is `MediaImageEncoder`'s job and needs a real Android runtime.
     */
    suspend fun completeWithProof(
        id: String,
        base64: String,
        contentType: String,
        claimFor: String? = null,
    ) {
        _proofError.value = null
        val outcome = runCatching {
            val uploaded = api.uploadMedia(base64, contentType)
            if (claimFor != null) api.claim(id, claimFor)
            api.complete(id, storageKey = uploaded.key, contentType = uploaded.contentType)
        }
        outcome
            .onSuccess {
                invalidate()
                load()
            }
            .onFailure { _proofError.value = proofErrorText(it) }
    }

    suspend fun approve(id: String) {
        dropAwaiting(id)
        write { api.approve(id) }
        // Reloaded UNCONDITIONALLY, outside the write: the optimistic drop must not
        // outlive a failed decision, or a parent watching the row vanish from "Needs your
        // OK" would believe they had approved something the server refused.
        loadAwaiting()
    }

    suspend fun reject(id: String) {
        dropAwaiting(id)
        write { api.reject(id) }
        loadAwaiting()
    }

    /** Optimistically remove a decided row from the queue, before the round trip. */
    fun dropAwaiting(id: String) {
        _awaiting.value = _awaiting.value.filterNot { it.id == id }
    }

    /**
     * Create (a null [choreId]) or edit a chore definition, then reload the day.
     *
     * Returns null on success, else a user-facing message — so the editor can show why it
     * failed instead of dismissing on a silent failure, which is what a non-parent hitting
     * the manage-only endpoint would otherwise see.
     */
    suspend fun save(choreId: String?, body: JsonObject): String? {
        val sent = runCatching {
            if (choreId != null) api.updateChore(choreId, body) else api.createChore(body)
        }
        val failure = sent.exceptionOrNull()
        if (failure != null) {
            val status = (failure as? WaffledApiException)?.status
            return if (status == 401 || status == 403) {
                "Only a parent can add or edit chores. Switch to a parent to make changes."
            } else {
                "Couldn’t save this chore — please try again."
            }
        }
        invalidate()
        load()
        return null
    }

    suspend fun delete(choreId: String) {
        write { api.deleteChore(choreId) }
    }

    // ---- internals -------------------------------------------------------------------

    /** Run a write, then tell everyone and refresh the board. */
    private suspend inline fun write(block: () -> Unit) {
        val sent = runCatching { block() }
        if (sent.isFailure) {
            _error.value = true
            return
        }
        invalidate()
        load()
    }

    /**
     * Tell the rest of the app a chore changed. Call after any write — chores aren't
     * synced, so nothing else would ever hear about it.
     */
    fun invalidate() {
        refreshBus?.bump(RefreshDomain.Chores)
    }

    private fun setStatus(id: String, status: String) {
        domain.apply(
            rows.map { row ->
                if (row.id == id) row.copy(instance = row.instance.copy(status = status)) else row
            },
        )
    }

    private fun toRows(instances: List<ChoresApi.ChoreInstance>): List<ChoreRow> {
        val viewing = _date.value
        // Sort ONCE here, not in a property the render reads N× per pass.
        return ChoreSort.sortChores(instances).map { instance ->
            ChoreRow(
                instance = instance,
                proofImageUrl = MediaUrl.resolve(instance.proofUrl, baseUrl),
                proofCacheKey = MediaUrl.cacheKey(instance.proofUrl),
                dueTimeLabel = ChoreDates.timeLabel(instance.dueTime, locale),
                overdueLabel = ChoreDates.overdueLabel(instance.dueOn, viewing, locale),
                upcomingLabel = ChoreDates.upcomingLabel(instance.dueOn, viewing, locale),
            )
        }
    }

    /** Turn an upload/complete failure into something a child could act on. */
    private fun proofErrorText(failure: Throwable): String = when {
        failure is WaffledApiException && failure.status == 422 ->
            "A photo is required to finish this chore."
        // Otherwise relay the SERVER's message — it knows why, and we don't.
        failure is WaffledApiException -> failure.userMessage
        else -> "Couldn’t upload that photo — please try again."
    }
}
