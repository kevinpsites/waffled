package app.waffled.feature.calendar

import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.SyncedEvent
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** A brand-new timed event runs an hour, matching the web and iOS editors. */
private const val DEFAULT_DURATION_SECONDS = 3600L

/** Where the editor starts a new event when it has no better idea. */
private val DEFAULT_START_TIME: LocalTime = LocalTime.of(9, 0)

/**
 * Everything the event editor holds while you are typing.
 *
 * A value type rather than a pile of `mutableStateOf`s inside the composable, because these
 * rules decide what actually reaches the server and every one of them fails SILENTLY when
 * it's wrong: the save returns 200 and the damage only surfaces the next time somebody
 * opens the event. They need tests, so they need to be reachable from one.
 */
internal data class EventDraft(
    val title: String = "",
    val date: LocalDate,
    val startTime: LocalTime = DEFAULT_START_TIME,
    val allDay: Boolean = false,
    val location: String = "",
    val personIds: List<String> = emptyList(),
    val isCountdown: Boolean = false,
    val repeat: RepeatState = RepeatState.NONE,
    val originalRrule: String? = null,
    val isRecurring: Boolean = false,
    val goalId: String? = null,
    val goalStepId: String? = null,
    /**
     * How long the event runs, carried across a start-time change.
     *
     * ⚠️ Seeded from the event's own end. Falling back to the one-hour default on EDIT would
     * truncate every longer event the moment somebody fixed a typo in its title — and
     * `endsAt` is sent EXPLICITLY in the update body, so there is no "missing key leaves it
     * alone" rescue.
     */
    val durationSeconds: Long = DEFAULT_DURATION_SECONDS,
    /**
     * The event's start as it was when the editor opened, verbatim.
     *
     * This is what the server matches an occurrence override against — so it must be the
     * ORIGINAL start, not the edited one. Sending the edited value makes the override match
     * no occurrence at all, and the write reports success while landing nowhere.
     */
    val occurrenceStartIso: String? = null,
    val original: RecurringEventSeriesFields? = null,
    /**
     * The id the API accepts for this event: the series for a recurring occurrence (whose
     * own row id 404s on every route), else the event itself. Null for a new event.
     */
    val editId: String? = null,
    /** The last day an all-day event covers (inclusive); saved as the exclusive end. */
    val lastDay: LocalDate = date,
) {

    val canSave: Boolean get() = title.isNotBlank()

    /** The rule to send: none for "just this one", which an override cannot carry. */
    fun seriesRrule(scope: EditScope?): String? =
        if (scope == EditScope.This) null else Recurrence.buildRrule(repeat, date)

    /** Only an explicit "was recurring, now isn't" on the series clears the rule. */
    fun clearsRrule(scope: EditScope?): Boolean =
        scope != EditScope.This && seriesRrule(scope) == null && originalRrule != null

    /** All-day starts at noon, like iOS, so a device/household zone gap can't shift its day. */
    fun startInstant(zone: ZoneId): Instant =
        date.atTime(if (allDay) LocalTime.NOON else startTime).atZone(zone).toInstant()

    /**
     * All-day: noon the day after [lastDay] (exclusive, the shape Google sends). Timed: the
     * start plus the carried duration, so moving the start keeps the length.
     */
    fun endInstant(zone: ZoneId): Instant? =
        if (allDay) EventEnd.allDayExclusiveEnd(lastDay, zone) else startInstant(zone).plusSeconds(durationSeconds)

    /** Move the start day; an all-day span moves with it. */
    fun withDate(newDate: LocalDate): EventDraft {
        val span = java.time.temporal.ChronoUnit.DAYS.between(date, lastDay).coerceAtLeast(0)
        return copy(date = newDate, lastDay = newDate.plusDays(span))
    }

    /** The all-day Ends date; never before the start day. */
    fun withLastDay(day: LocalDate): EventDraft = copy(lastDay = maxOf(date, day))

    /** The timed Ends date and time, stored as a length (floored at 15 minutes). */
    fun withTimedEnd(day: LocalDate, time: LocalTime, zone: ZoneId): EventDraft {
        val start = date.atTime(startTime).atZone(zone).toInstant()
        val end = day.atTime(time).atZone(zone).toInstant()
        return copy(durationSeconds = EventEnd.minutes(start, end) * 60)
    }

    /** Where the timed Ends pills read from. */
    fun timedEnd(zone: ZoneId): java.time.LocalDateTime =
        date.atTime(startTime).atZone(zone).plusSeconds(durationSeconds).toLocalDateTime()

    /** Adopt the loaded detail as the baseline the series rule compares against. */
    fun withSeriesBaseline(fields: RecurringEventSeriesFields): EventDraft = copy(original = fields)

    /**
     * Has anything a per-occurrence override CANNOT represent changed?
     *
     * With no baseline loaded the answer is "nothing has", which is the safe default: it
     * only ever widens the choice offered, and the server still rejects an impossible one.
     */
    fun seriesUnchanged(): Boolean {
        val before = original ?: return true
        return RecurringEventEditPolicy.canApplyToSingleOccurrence(before, current())
    }

    private fun current() = RecurringEventSeriesFields(
        allDay = allDay,
        isCountdown = isCountdown,
        participantIds = personIds,
        goalId = goalId,
        goalStepId = goalStepId,
        rrule = Recurrence.buildRrule(repeat, date),
        recurrenceEndAt = original?.recurrenceEndAt,
    )

    companion object {

        fun seed(event: SyncedEvent?, initialDate: LocalDate, zone: ZoneId): EventDraft {
            if (event == null) return EventDraft(date = initialDate)

            // Seeded in the HOUSEHOLD's zone, not the device's: otherwise the editor opens
            // on a different clock time than the agenda row the user just tapped.
            val start = WaffledDates.parseInstant(event.startsAt, zone)
            val local = start?.atZone(zone)
            val end = WaffledDates.parseInstant(event.endsAt, zone)
            val date = local?.toLocalDate() ?: initialDate

            return EventDraft(
                title = event.title,
                date = date,
                lastDay = if (event.allDay && start != null) EventEnd.allDayLastDay(start, end, zone) else date,
                startTime = local?.toLocalTime() ?: DEFAULT_START_TIME,
                allDay = event.allDay,
                location = event.location.orEmpty(),
                personIds = listOfNotNull(event.personId),
                isCountdown = event.isCountdown,
                goalId = event.goalId,
                goalStepId = event.goalStepId,
                repeat = Recurrence.parseRepeat(event.rrule),
                originalRrule = event.rrule,
                isRecurring = event.isOccurrence || !event.rrule.isNullOrEmpty(),
                // An all-day end is a day boundary, not a length.
                durationSeconds = if (event.allDay) DEFAULT_DURATION_SECONDS else durationOf(start, end),
                // An override may have moved the start; the server keys the slot by the original.
                occurrenceStartIso = event.originalStart ?: event.startsAt,
                editId = event.editableId,
            )
        }

        /** Rounded through [EventEnd.minutes], the same way the Ends picker writes it back. */
        private fun durationOf(start: Instant?, end: Instant?): Long {
            if (start == null || end == null) return DEFAULT_DURATION_SECONDS
            // A non-positive span is malformed data, not a zero-length event.
            if (end.epochSecond <= start.epochSecond) return DEFAULT_DURATION_SECONDS
            return EventEnd.minutes(start, end) * 60
        }
    }
}
