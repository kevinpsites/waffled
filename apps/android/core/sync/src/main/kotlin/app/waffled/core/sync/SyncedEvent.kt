package app.waffled.core.sync

import app.waffled.core.model.WaffledDates
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * One row from the synced `events` (or `event_occurrences`) table.
 *
 * Values are stored loosely in SQLite — text and integers — so booleans arrive as 0/1
 * and every timestamp is a string.
 */
data class SyncedEvent(
    val id: String,
    val householdId: String,
    val title: String,
    val startsAt: String?,
    val endsAt: String? = null,
    val allDay: Boolean = false,
    val isCountdown: Boolean = false,
    val location: String? = null,
    val description: String? = null,
    val personId: String? = null,
    val calendarId: String? = null,
    val goalId: String? = null,
    val goalStepId: String? = null,
    /** null / `waffled` / `google` / `microsoft` / `ics` — the last is READ-ONLY. */
    val origin: String? = null,
    val originRefId: String? = null,
    /** Non-null marks a recurring master; its occurrences render instead. */
    val rrule: String? = null,
    /** `family` (shared) | `personal` (only [ownerPersonId] sees it). */
    val visibility: String? = null,
    val ownerPersonId: String? = null,
    val timezone: String? = null,
    val status: String? = null,
    val updatedAt: String? = null,
    /**
     * For a row from `event_occurrences`: the recurring master it belongs to.
     *
     * Essential, not decorative. Occurrence rows carry no `rrule` (the master does, and
     * the master is excluded from the query), so without this an occurrence is
     * indistinguishable from a plain event — and `GET /api/events/:id` 404s on an
     * occurrence id, because the API wants the series. Null for a plain event.
     */
    val seriesId: String? = null,
    /** The occurrence's slot in the series, used to scope an edit to this instance. */
    val originalStart: String? = null,
    /** Set when this occurrence already has a per-instance override row. */
    val overrideId: String? = null,
    /**
     * The rhythm this slot was booked for (`events.rhythm_id`). On an occurrence it is the
     * master's — the link only ever lives on the series row.
     */
    val rhythmId: String? = null,
) {
    /** Belongs to a rhythm. Means *rhythm*, never *recurring*. */
    val isRhythm: Boolean get() = rhythmId != null

    /** An event from a subscribed feed cannot be edited here. */
    val isReadOnly: Boolean get() = origin == "ics"

    /** True when this row came from `event_occurrences` rather than `events`. */
    val isOccurrence: Boolean get() = seriesId != null

    /**
     * The id the API will accept for an edit: the series for an occurrence, otherwise the
     * event itself. Pair it with [originalStart] to scope a change to one instance.
     */
    val editableId: String get() = seriesId ?: id
}

/**
 * Per-viewer visibility.
 *
 * PowerSync streams the whole household to every device — the server does not filter per
 * viewer — so the CLIENT must, or a personal event appears on the shared kitchen tablet.
 */
object EventVisibility {

    private const val PERSONAL = "personal"

    fun isVisible(event: SyncedEvent, viewerPersonId: String?): Boolean {
        // Anything not explicitly personal is family — older rows predate the column, and
        // defaulting those to hidden would make real events silently vanish.
        if (!event.visibility.equals(PERSONAL, ignoreCase = true)) return true

        // Marked personal but unowned: malformed. Hide rather than leak.
        val owner = event.ownerPersonId ?: return false
        return viewerPersonId != null && owner == viewerPersonId
    }

    fun visible(events: List<SyncedEvent>, viewerPersonId: String?): List<SyncedEvent> =
        events.filter { isVisible(it, viewerPersonId) }
}

/**
 * Day bucketing.
 *
 * ⚠️ Buckets in the HOUSEHOLD's timezone, never UTC — an evening event would otherwise
 * land on tomorrow.
 *
 * This is deliberately an eager, precomputed map rather than something recomputed while
 * rendering: date math in a sort/filter hot path is one of the two documented jank
 * sources carried over from iOS.
 */
object EventBucketing {

    /** Longest span an all-day event is spread across, so a corrupt end can't build a huge index. */
    const val MAX_SPAN_DAYS: Int = 366

    /**
     * Each event under every household-local day it covers, each day ordered timed
     * before all-day, then by start — the twin of iOS `Agenda.byDay`.
     */
    fun byDay(events: List<SyncedEvent>, zone: ZoneId): Map<LocalDate, List<SyncedEvent>> {
        val withInstant = events.mapNotNull { e ->
            val at: Instant = WaffledDates.parseInstant(e.startsAt, zone) ?: return@mapNotNull null
            Triple(at, e, dayKeys(e, zone))
        }
        val grouped = linkedMapOf<LocalDate, MutableList<SyncedEvent>>()
        withInstant
            .sortedWith(compareBy<Triple<Instant, SyncedEvent, List<LocalDate>>> { it.second.allDay }.thenBy { it.first })
            .forEach { (_, e, days) -> days.forEach { grouped.getOrPut(it) { mutableListOf() }.add(e) } }
        return grouped
    }

    /** The household-local day an event starts on; null when its start is unreadable. */
    fun startDay(event: SyncedEvent, zone: ZoneId): LocalDate? =
        WaffledDates.parseInstant(event.startsAt, zone)?.let { WaffledDates.localDay(it, zone) }

    /**
     * The exclusive end day of an all-day event whose end falls after its start day; null
     * otherwise. The all-day end is exclusive (Google's shape, and what the editor writes).
     */
    fun exclusiveEndDay(event: SyncedEvent, zone: ZoneId): LocalDate? {
        if (!event.allDay) return null
        val start = startDay(event, zone) ?: return null
        val end = WaffledDates.parseInstant(event.endsAt, zone)?.let { WaffledDates.localDay(it, zone) } ?: return null
        return end.takeIf { it.isAfter(start) }
    }

    /** Every day an event covers: all-day runs up to its exclusive end; timed stays on its start day. */
    fun dayKeys(event: SyncedEvent, zone: ZoneId): List<LocalDate> {
        val start = startDay(event, zone) ?: return emptyList()
        val end = exclusiveEndDay(event, zone) ?: return listOf(start)
        return generateSequence(start) { it.plusDays(1) }
            .takeWhile { it.isBefore(end) }
            .take(MAX_SPAN_DAYS)
            .toList()
    }

    /** Answered by comparing days, without building the span. */
    fun covers(event: SyncedEvent, day: LocalDate, zone: ZoneId): Boolean {
        val start = startDay(event, zone) ?: return false
        val end = exclusiveEndDay(event, zone) ?: return day == start
        return !day.isBefore(start) && day.isBefore(end)
    }

    /**
     * Has this event finished? All-day: once its last covered day is behind today in the
     * household zone. Timed: once its end — or its start, if open-ended — is behind now.
     */
    fun isPast(event: SyncedEvent, zone: ZoneId, now: Instant = Instant.now()): Boolean {
        if (event.allDay) {
            val start = startDay(event, zone) ?: return false
            val today = WaffledDates.localDay(now, zone)
            val end = exclusiveEndDay(event, zone) ?: return start.isBefore(today)
            return !end.isAfter(today)
        }
        val end = WaffledDates.parseInstant(event.endsAt, zone)
            ?: WaffledDates.parseInstant(event.startsAt, zone)
            ?: return false
        return end.isBefore(now)
    }
}
