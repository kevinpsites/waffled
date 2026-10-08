package app.waffled.feature.calendar

import androidx.compose.runtime.Immutable
import app.waffled.core.design.LockNoteText
import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.EventBucketing
import app.waffled.core.sync.SyncedEvent
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Which event origins Waffled may edit — the port of iOS's `EventOrigin`.
 *
 * An ICS subscription is a one-way read: Waffled polls the URL and has nowhere to send a
 * change back to, so the server refuses edits and deletes on those events (409
 * `ReadOnlyEvent` on REST; the PowerSync upload sink drops non-PUT ops on them). The app
 * must check BEFORE offering the action — otherwise the edit applies to the local mirror,
 * the server rejects it unseen, and the next poll silently puts it back, which looks like
 * the app losing the user's work.
 *
 * Google and Outlook events stay editable: those have a write-target calendar and Waffled
 * pushes changes back out to the provider.
 */
object EventOrigin {

    val readOnlyOrigins: Set<String> = setOf("ics")

    /** The copy shown when the gate fires. Canonical text lives in `core:design`. */
    const val READ_ONLY_NOTE: String = LockNoteText.SUBSCRIBED_FEED_EVENT

    fun isReadOnly(origin: String?): Boolean = origin != null && origin in readOnlyOrigins

    /**
     * The detail screen has two sources for the origin: the REST detail DTO (rich, but
     * absent until it loads and never offline) and the local mirror row. Prefer the
     * server's answer, fall back to the mirror — never default to "editable" just because
     * the network is slow.
     */
    fun isReadOnly(detailOrigin: String?, mirrorOrigin: String?): Boolean =
        isReadOnly(detailOrigin ?: mirrorOrigin)

    /**
     * May the edit sheet offer Save and Delete for this event?
     *
     * The gate lives on the SHEET rather than on the screens that present it: the detail
     * view is only one route in, and gating each call site is only ever as complete as
     * whoever enumerated them. `null` is a brand-new event, which is never gated.
     */
    fun blocksEditing(event: SyncedEvent?): Boolean = event != null && event.isReadOnly
}

/**
 * One agenda row: the synced event plus every derived value the list would otherwise
 * recompute per frame.
 *
 * Precomputing the instants, the day and the labels here is the point — a lazy list
 * recomposes constantly, and date maths in a sort / filter / render path is one of the two
 * documented jank sources carried over from iOS. The row exposes only fields.
 */
@Immutable
data class EventRow(
    val event: SyncedEvent,
    /** The household-local day this row belongs to. */
    val day: LocalDate,
    val startsAt: Instant?,
    val endsAt: Instant?,
    /** "8:30 AM", or "All day". Formatted once, here. */
    val timeLabel: String,
    override val people: EventPeople,
    /** The resolved chip colour, or null for unassigned (the call site keeps its grey). */
    val colorHex: String?,
    /** A multi-day all-day event's exclusive end day; null for anything on one day. */
    val exclusiveEndDay: LocalDate? = null,
    /** The household-local day the event starts on — before [day] for a multi-day event. */
    val startDay: LocalDate? = null,
) : CalendarEntry {
    override val id: String get() = event.id
    val title: String get() = event.title
    val allDay: Boolean get() = event.allDay
    val isReadOnly: Boolean get() = event.isReadOnly
    val location: String? get() = event.location
    val ownerEmoji: String? get() = people.ownerAvatarEmoji
}

/** One day's worth of rows, in agenda order. */
@Immutable
data class DayGroup(val day: LocalDate, val items: List<EventRow>)

/**
 * Pure agenda shaping — row building, ordering and grouping.
 *
 * ⚠️ This does NOT re-bucket or re-filter. `core:sync` already streams
 * `SyncManager.eventsByDay`, bucketed in the household timezone, and
 * `SyncManager.visibleEvents`, filtered for the viewer; both are locked by their own tests
 * there. What lives here is only what the calendar screen adds on top: the derived per-row
 * values, and re-asserting the agenda ORDER over rows (the same order `EventBucketing` uses).
 */
object Agenda {

    private const val TIME_PATTERN = "h:mm a"
    const val ALL_DAY_LABEL: String = "All day"

    /**
     * Turn the synced day buckets into rows, once per data change.
     *
     * [byDay] comes straight from `SyncManager.eventsByDay` — already bucketed in the
     * household zone. Rows with no resolvable day never reach here: the bucketing drops
     * them, because a row with no day has nowhere to render.
     */
    fun buildRows(
        byDay: Map<LocalDate, List<SyncedEvent>>,
        zone: ZoneId,
        palette: EventPalette = EventPalette(),
        peopleOf: (SyncedEvent) -> EventPeople = { EventPeople(ownerPersonId = it.personId) },
    ): Map<LocalDate, List<EventRow>> =
        byDay.mapValues { (day, events) ->
            order(events.map { row(it, day, zone, palette, peopleOf(it)) })
        }

    private fun row(
        event: SyncedEvent,
        day: LocalDate,
        zone: ZoneId,
        palette: EventPalette,
        people: EventPeople,
    ): EventRow {
        val startsAt = WaffledDates.parseInstant(event.startsAt, zone)
        return EventRow(
            event = event,
            day = day,
            startsAt = startsAt,
            endsAt = WaffledDates.parseInstant(event.endsAt, zone),
            timeLabel = when {
                event.allDay -> ALL_DAY_LABEL
                startsAt != null -> WaffledDates.format(startsAt, TIME_PATTERN, zone)
                else -> ""
            },
            people = people,
            colorHex = palette.hex(people),
            exclusiveEndDay = EventBucketing.exclusiveEndDay(event, zone),
            startDay = startsAt?.let { WaffledDates.localDay(it, zone) },
        )
    }

    /**
     * Agenda order: timed before all-day, then by start instant — matching the server and
     * the web. Comparing only precomputed fields keeps this out of the date-maths trap.
     */
    fun order(rows: List<EventRow>): List<EventRow> =
        rows.sortedWith(
            compareBy<EventRow> { it.allDay }
                .thenBy { it.startsAt ?: Instant.MAX },
        )

    /** One day's rows — an O(1) lookup, never a rescan. */
    fun forDay(byDay: Map<LocalDate, List<EventRow>>, day: LocalDate): List<EventRow> =
        byDay[day].orEmpty()

    /** Days at or after [from], ascending, items in the index's already-sorted order. */
    fun upcoming(byDay: Map<LocalDate, List<EventRow>>, from: LocalDate): List<DayGroup> =
        byDay.keys.filter { !it.isBefore(from) }.sorted().map { DayGroup(it, byDay.getValue(it)) }

    /**
     * Has this event already ended? All-day events are "past" only once their LAST covered
     * day is behind today (in the household zone — an evening UTC timestamp is still today
     * locally); timed events once their end, or their start if open-ended, is behind now.
     * Mirrors the web's `isPastEvent`; drives the subtle fade on finished rows.
     */
    fun isPast(row: EventRow, zone: ZoneId, now: Instant = Instant.now()): Boolean {
        if (row.allDay) {
            val today = WaffledDates.localDay(now, zone)
            return row.exclusiveEndDay?.let { !it.isAfter(today) } ?: row.day.isBefore(today)
        }
        val end = row.endsAt ?: row.startsAt ?: return false
        return end.isBefore(now)
    }
}
