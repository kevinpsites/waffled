package app.waffled.feature.rhythms

import androidx.compose.runtime.Immutable
import app.waffled.core.model.WaffledDates
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant
import java.time.ZoneId

/** Everything both rhythm surfaces render, with every line and date precomputed per load. */
@Immutable
data class RhythmsState(
    val attention: List<RhythmsApi.AttentionItem> = emptyList(),
    val rhythms: List<RhythmsApi.Rhythm> = emptyList(),
    /** True once an attention fetch has finished, failed or not — nothing sits on "Loading…". */
    val loaded: Boolean = false,
    val listLoaded: Boolean = false,
    /** The LATEST register fetch failed; rows from an earlier load may still be shown. */
    val listFailed: Boolean = false,
    val statusLines: Map<String, String> = emptyMap(),
    val detailLines: Map<String, String> = emptyMap(),
    val bands: List<RhythmBand> = emptyList(),
    val paused: List<RhythmsApi.Rhythm> = emptyList(),
    val countdowns: Map<String, RhythmFormat.Countdown> = emptyMap(),
    val progress: Map<String, Int> = emptyMap(),
)

/**
 * The one model behind the Today card ([loadAttention]) and the register ([loadAll]).
 * Port of iOS `RhythmsModel`; dependencies are injected so the logic is testable without a
 * server. Mutations throw, so the caller can surface a failure in place.
 */
class RhythmsModel(
    private val fetchAttention: suspend (from: String, to: String) -> List<RhythmsApi.AttentionItem>,
    private val fetchRhythms: suspend () -> List<RhythmsApi.Rhythm>,
    /** `completedAt` null is "now", stamped by the server. */
    private val complete: suspend (id: String, completedAt: String?) -> Unit,
    private val skip: suspend (id: String, periodStart: String) -> Unit,
    private val book: suspend (id: String, startsAt: String, allDay: Boolean, periodStart: String?) -> Unit,
    /** Create when `id` is null, otherwise PATCH. */
    private val save: suspend (id: String?, body: JsonObject) -> Unit,
    private val remove: suspend (id: String) -> Unit,
    /** The household's zone — the same one the other Today cards day-bucket in. */
    val zone: () -> ZoneId = { ZoneId.systemDefault() },
    val now: () -> Instant = { Instant.now() },
) {
    private val _state = MutableStateFlow(RhythmsState())
    val state: StateFlow<RhythmsState> = _state.asStateFlow()

    private var personNames: Map<String, String> = emptyMap()

    /** Person id → name, for the register's subtitle; the endpoint carries only the id. */
    fun setPersonNames(names: Map<String, String>) {
        if (names == personNames) return
        personNames = names
        if (_state.value.listLoaded) regroup()
    }

    // ---- loads ----

    /**
     * What needs attention today. ONE-day window: `to` also decides which period a
     * scheduling rhythm reports on. Unknown kinds are dropped row by row.
     */
    suspend fun loadAttention() {
        val today = RhythmFormat.ymd(now(), zone())
        val items = runCatchingCancellable { fetchAttention(today, today) }
        if (items != null) {
            val sorted = RhythmAttention.sorted(items.filter { it.kind != AttentionKind.Unknown })
            _state.update { it.copy(attention = sorted, statusLines = statusLines(sorted, now(), zone())) }
        }
        _state.update { it.copy(loaded = true) }
        regroup()
    }

    /**
     * Reload the register. A failure keeps the rows already on screen but is ALWAYS
     * reported — "nothing here yet" is a claim about the household, and a failed request
     * (a 403 after the module was switched off, say) is no evidence for it.
     */
    suspend fun loadAll() {
        val list = runCatchingCancellable { fetchRhythms() }
        _state.update {
            if (list != null) it.copy(rhythms = list, listFailed = false, listLoaded = true)
            else it.copy(listFailed = true, listLoaded = true)
        }
        regroup()
    }

    /** Reload only the surfaces that have actually been shown. */
    private suspend fun refresh() {
        if (_state.value.loaded) loadAttention()
        if (_state.value.listLoaded) loadAll()
    }

    private fun regroup() {
        val clock = now()
        val zone = zone()
        val s = _state.value
        val grouped = mutableMapOf<RhythmFormat.Urgency, MutableList<RhythmsApi.Rhythm>>()
        val countdowns = mutableMapOf<String, RhythmFormat.Countdown>()
        val progress = mutableMapOf<String, Int>()
        val daysToGo = mutableMapOf<String, Int>()
        for (r in s.rhythms) {
            val band = RhythmFormat.urgency(r, attentionItem(r), clock, zone)
            grouped.getOrPut(band) { mutableListOf() } += r
            RhythmFormat.countdown(r, band, clock, zone)?.let { countdowns[r.id] = it }
            RhythmFormat.periodProgress(r, clock, zone)?.let { progress[r.id] = it }
            RhythmFormat.daysToGo(r, clock, zone)?.let { daysToGo[r.id] = it }
        }
        // Soonest first; a rhythm with no date sorts last.
        val bands = RhythmBand.ORDER.mapNotNull { (urgency, title, hint) ->
            val rows = grouped[urgency]?.sortedBy { daysToGo[it.id] ?: Int.MAX_VALUE }
            if (rows.isNullOrEmpty()) null else RhythmBand(urgency, title, hint, rows)
        }
        _state.update {
            it.copy(
                detailLines = detailLines(s.rhythms, personNames, clock, zone),
                bands = bands,
                paused = grouped[RhythmFormat.Urgency.Paused].orEmpty().sortedBy { r -> r.title },
                countdowns = countdowns,
                progress = progress,
            )
        }
    }

    /**
     * The attention row for a rhythm, if any. Checks `isActive` because pausing is local
     * and the held list is stale until the refetch: a paused row must not offer to book.
     */
    fun attentionItem(rhythm: RhythmsApi.Rhythm): RhythmsApi.AttentionItem? {
        if (!rhythm.isActive) return null
        return _state.value.attention.firstOrNull { it.rhythm.id == rhythm.id }
    }

    // ---- mutations ----

    /** [on] backdates the completion — the clock restarts from when it was actually done. */
    suspend fun markDone(id: String, on: Instant? = null) {
        complete(id, on?.let(RhythmFormat::isoInstant))
        refresh()
    }

    suspend fun skipPeriod(item: RhythmsApi.AttentionItem) {
        val periodStart = item.periodStart ?: return
        skip(item.rhythm.id, periodStart)
        refresh()
    }

    suspend fun book(id: String, startsAt: Instant, allDay: Boolean, periodStart: String? = null) {
        book(id, RhythmFormat.isoInstant(startsAt), allDay, periodStart)
        refresh()
    }

    /** Pause / resume — reversible, unlike [delete]. */
    suspend fun setActive(id: String, isActive: Boolean) {
        save(id, buildJsonObject { put("isActive", JsonPrimitive(isActive)) })
        refresh()
    }

    /** Moves the clock without claiming the thing was done. */
    suspend fun pushOut(rhythm: RhythmsApi.Rhythm) {
        val moved = RhythmFormat.pushOut(rhythm.nextDueAt, now(), zone()) ?: return
        save(rhythm.id, buildJsonObject { put("nextDueAt", JsonPrimitive(RhythmFormat.isoInstant(moved))) })
        refresh()
    }

    suspend fun save(form: RhythmForm) {
        val zone = zone()
        val body = if (form.editingId == null) {
            form.createBody(WaffledDates.localDay(now(), zone), zone)
        } else {
            form.patchBody()
        }
        save(form.editingId, body)
        refresh()
    }

    suspend fun delete(id: String) {
        remove(id)
        refresh()
    }

    private suspend fun <T> runCatchingCancellable(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    companion object {
        /** The production wiring: every dependency is a call on [api]. */
        fun from(
            api: RhythmsApi,
            zone: () -> ZoneId = { ZoneId.systemDefault() },
            now: () -> Instant = { Instant.now() },
        ) = RhythmsModel(
            fetchAttention = api::attention,
            fetchRhythms = api::rhythms,
            complete = { id, at -> api.complete(id, at) },
            skip = api::skip,
            book = { id, startsAt, allDay, periodStart -> api.schedule(id, startsAt, allDay, periodStart) },
            save = { id, body -> if (id != null) api.update(id, body) else api.create(body) },
            remove = api::delete,
            zone = zone,
            now = now,
        )

        fun statusLines(items: List<RhythmsApi.AttentionItem>, now: Instant, zone: ZoneId): Map<String, String> =
            buildMap {
                for (item in items) {
                    when (item.kind) {
                        AttentionKind.Due ->
                            put(item.rhythm.id, RhythmFormat.dueLabel(item.dueAt.orEmpty(), item.overdue ?: false, now, zone))
                        AttentionKind.Unscheduled ->
                            put(item.rhythm.id, RhythmFormat.periodLabel(item.bookableUntil.orEmpty(), now, zone))
                        AttentionKind.Unknown -> {}
                    }
                }
            }

        /**
         * The register row's subtitle: the cadence first (the one thing the countdown at
         * the row's edge can't say), then where this one stands. A scheduling row never
         * says "last done" — whether it happened is deliberately not tracked.
         */
        fun detailLines(
            rhythms: List<RhythmsApi.Rhythm>,
            names: Map<String, String>,
            now: Instant,
            zone: ZoneId,
        ): Map<String, String> = rhythms.associate { r ->
            val parts = mutableListOf(RhythmFormat.sentence(RhythmFormat.cadenceLabel(r.every)))
            if (!r.isActive) {
                parts += "paused"
            } else {
                when (r.shape) {
                    RhythmShape.Unknown -> {}
                    RhythmShape.Completion -> parts += if (r.lastCompletedAt == null) {
                        "never done"
                    } else {
                        "last done ${RhythmFormat.shortDate(r.lastCompletedAt, zone)}"
                    }
                    RhythmShape.Scheduling -> parts += schedulingState(r, zone)
                }
            }
            r.personId?.let { names[it] }?.let { parts += it }
            r.notes?.trim()?.takeIf { it.isNotEmpty() }?.let { parts += it }
            r.id to parts.joinToString(" · ")
        }

        private fun schedulingState(r: RhythmsApi.Rhythm, zone: ZoneId): String = when {
            // No current period: the server tiles the grid from startsOn up to now.
            r.currentPeriodStart == null && r.startsOn != null ->
                "periods start ${RhythmFormat.shortDate(r.startsOn, zone)}"
            r.satisfied == true -> r.bookedAt?.let {
                "on the calendar for " + RhythmFormat.bookedWhen(it, r.bookedAllDay ?: false, zone)
            } ?: "handled without a booking"
            // A live series missing one period is not a missing series — saying so sent
            // people to build a second series beside the first.
            r.autoSchedule -> if (r.hasSeries == true) "nothing on the calendar this time" else "the series needs putting back"
            else -> "not on the calendar yet"
        }

        /**
         * This rhythm's open period, shaped as the row the booking sheet expects — or null
         * when settled, paused or not a booking rhythm. Deliberately not [attentionItem]: a
         * period can be booked before its runway opens, which `/attention` can't report.
         */
        fun openPeriod(r: RhythmsApi.Rhythm): RhythmsApi.AttentionItem? {
            if (r.shape != RhythmShape.Scheduling || !r.isActive || r.satisfied == true) return null
            val start = r.currentPeriodStart ?: return null
            val end = r.currentPeriodEnd ?: return null
            val window = r.windowEnd ?: return null
            return RhythmsApi.AttentionItem(
                rawKind = AttentionKind.Unscheduled.wire, rhythm = r, periodStart = start,
                periodEnd = end, windowEnd = window, hasSeries = r.hasSeries,
            )
        }

        /** Booking restores a recurrence only when there is none left. */
        fun needsSeriesBack(r: RhythmsApi.Rhythm, hasSeries: Boolean? = r.hasSeries): Boolean =
            r.autoSchedule && hasSeries != true
    }
}
