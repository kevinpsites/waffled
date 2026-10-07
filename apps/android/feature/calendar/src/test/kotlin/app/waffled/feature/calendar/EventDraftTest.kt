package app.waffled.feature.calendar

import app.waffled.core.sync.SyncedEvent
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What the event editor holds while you type.
 *
 * These are the rules that decide what actually reaches the server, and every one of them
 * fails SILENTLY when it's wrong — the save succeeds, and the damage only shows the next
 * time somebody opens the event. That is exactly why they live in a testable value type
 * rather than inside the composable.
 */
class EventDraftTest {

    private val denver: ZoneId = ZoneId.of("America/Denver")
    private val june16 = LocalDate.of(2026, 6, 16)

    private fun event(
        startsAt: String? = "2026-06-16T17:00:00Z",
        endsAt: String? = null,
        allDay: Boolean = false,
    ) = SyncedEvent(
        id = "ev-1",
        householdId = "h",
        title = "Soccer practice",
        startsAt = startsAt,
        endsAt = endsAt,
        allDay = allDay,
        personId = "p1",
    )

    @Test
    fun aNewTimedEventDefaultsToAnHour() {
        val draft = EventDraft.seed(event = null, initialDate = june16, zone = denver)
        val start = draft.startInstant(denver)
        assertEquals(3600, draft.endInstant(denver)!!.epochSecond - start.epochSecond)
    }

    @Test
    fun editingAThreeHourEventKeepsItThreeHoursLong() {
        // The one-hour default is only right for a NEW event. Applying it on edit silently
        // truncates every longer event the moment somebody fixes a typo in its title — and
        // `endsAt` is sent explicitly, so there is no "missing key leaves it alone" rescue.
        val draft = EventDraft.seed(
            event = event(endsAt = "2026-06-16T20:00:00Z"),
            initialDate = june16,
            zone = denver,
        )
        val start = draft.startInstant(denver)
        assertEquals(3 * 3600, draft.endInstant(denver)!!.epochSecond - start.epochSecond)
    }

    @Test
    fun movingTheStartTimeCarriesTheDurationWithIt() {
        // Dragging a 90-minute event an hour later must keep it 90 minutes, not snap it to
        // its old absolute end (which would now be in the past).
        val draft = EventDraft.seed(
            event = event(startsAt = "2026-06-16T17:00:00Z", endsAt = "2026-06-16T18:30:00Z"),
            initialDate = june16,
            zone = denver,
        ).let { it.copy(startTime = it.startTime.plusHours(1)) }

        val start = draft.startInstant(denver)
        assertEquals(90 * 60, draft.endInstant(denver)!!.epochSecond - start.epochSecond)
    }

    @Test
    fun anAllDayEventEndsAtNoonTheDayAfterItsLastDay() {
        // The exclusive shape Google sends, so a made-here event spreads like a synced one.
        val draft = EventDraft.seed(event = event(allDay = true), initialDate = june16, zone = denver)
        assertTrue(draft.allDay)
        assertEquals(june16, draft.lastDay)
        assertEquals(
            LocalDate.of(2026, 6, 17).atTime(12, 0).atZone(denver).toInstant(),
            draft.endInstant(denver),
        )
    }

    @Test
    fun anAllDayStartIsNoonSoAZoneShiftCannotMoveItsDay() {
        val draft = EventDraft.seed(event = event(allDay = true), initialDate = june16, zone = denver)
        assertEquals(june16.atTime(12, 0).atZone(denver).toInstant(), draft.startInstant(denver))
    }

    @Test
    fun editingASyncedTripOpensOnItsLastDay() {
        val draft = EventDraft.seed(
            event = event(startsAt = "2026-07-27T06:00:00Z", endsAt = "2026-08-03T06:00:00Z", allDay = true),
            initialDate = june16,
            zone = denver,
        )
        assertEquals(LocalDate.of(2026, 7, 27), draft.date)
        assertEquals(LocalDate.of(2026, 8, 2), draft.lastDay)
    }

    @Test
    fun anAllDayEndDoesNotSeedATimedDuration() {
        // A three-day trip's end is not a 72-hour length; toggling it to timed starts at an hour.
        val draft = EventDraft.seed(
            event = event(startsAt = "2026-07-27T06:00:00Z", endsAt = "2026-07-30T06:00:00Z", allDay = true),
            initialDate = june16,
            zone = denver,
        ).copy(allDay = false)
        assertEquals(3600, draft.endInstant(denver)!!.epochSecond - draft.startInstant(denver).epochSecond)
    }

    @Test
    fun movingTheStartDayCarriesTheAllDaySpan() {
        val draft = EventDraft.seed(event = null, initialDate = june16, zone = denver)
            .copy(allDay = true)
            .withLastDay(LocalDate.of(2026, 6, 18))
            .withDate(LocalDate.of(2026, 6, 20))
        assertEquals(LocalDate.of(2026, 6, 22), draft.lastDay)
    }

    @Test
    fun theLastDayCannotFallBeforeTheStart() {
        val draft = EventDraft.seed(event = null, initialDate = june16, zone = denver)
            .withLastDay(LocalDate.of(2026, 6, 10))
        assertEquals(june16, draft.lastDay)
    }

    @Test
    fun aTimedEndCanLandOnALaterDayAndKeepsTheLengthWhenTheStartMoves() {
        val draft = EventDraft.seed(event = null, initialDate = june16, zone = denver)
            .copy(startTime = LocalTime.of(20, 0))
            .withTimedEnd(LocalDate.of(2026, 6, 17), LocalTime.of(1, 30), denver)
        assertEquals(330 * 60L, draft.durationSeconds)
        val moved = draft.withDate(LocalDate.of(2026, 6, 18))
        assertEquals(330 * 60L, moved.endInstant(denver)!!.epochSecond - moved.startInstant(denver).epochSecond)
    }

    @Test
    fun aTimedEndBeforeTheStartFloorsAtFifteenMinutes() {
        val draft = EventDraft.seed(event = null, initialDate = june16, zone = denver)
            .withTimedEnd(june16, LocalTime.of(8, 0), denver)
        assertEquals(15 * 60L, draft.durationSeconds)
    }

    @Test
    fun aSlightlyShortEventRoundsRatherThanTruncates() {
        val draft = EventDraft.seed(
            event = event(startsAt = "2026-06-16T17:00:00Z", endsAt = "2026-06-16T17:59:36Z"),
            initialDate = june16,
            zone = denver,
        )
        assertEquals(3600L, draft.durationSeconds)
    }

    @Test
    fun theOccurrenceKeyIsTheORIGINALStartNotTheEditedOne() {
        // The server identifies WHICH occurrence to override by its original start. Sending
        // the edited start makes it match no occurrence, so a "just this one" edit lands
        // nowhere — and reports success.
        val draft = EventDraft.seed(event = event(), initialDate = june16, zone = denver)
        val moved = draft.copy(startTime = LocalTime.of(6, 0))

        assertEquals("2026-06-16T17:00:00Z", moved.occurrenceStartIso)
        assertTrue(moved.startInstant(denver).toString() != moved.occurrenceStartIso)
    }

    @Test
    fun aBrandNewEventHasNoOccurrenceKey() {
        assertNull(EventDraft.seed(event = null, initialDate = june16, zone = denver).occurrenceStartIso)
    }

    @Test
    fun seedsTheDateAndTimeFromTheEventInTheHouseholdZone() {
        // 17:00 UTC is 11:00 in Denver. Seeding in the device zone would open the editor on
        // a different clock time than the agenda row the user just tapped.
        val draft = EventDraft.seed(event = event(), initialDate = june16, zone = denver)
        assertEquals(june16, draft.date)
        assertEquals(LocalTime.of(11, 0), draft.startTime)
    }

    // ---- the series-edit rules -------------------------------------------------

    @Test
    fun anUntouchedRecurringEventCanStillBeSavedForOneOccurrence() {
        val draft = EventDraft.seed(event = event(), initialDate = june16, zone = denver)
            .withSeriesBaseline(
                RecurringEventSeriesFields(
                    allDay = false,
                    isCountdown = false,
                    participantIds = listOf("p1"),
                    goalId = null,
                    goalStepId = null,
                    rrule = null,
                    recurrenceEndAt = null,
                ),
            )
            .copy(personIds = listOf("p1"))

        assertTrue(draft.seriesUnchanged())
    }

    @Test
    fun changingWhoIsOnItTakesSingleOccurrenceOffTheMenu() {
        // A per-occurrence override can only carry title/start/end/location, so offering
        // "just this one" after a participant change would appear to save and then not.
        val draft = EventDraft.seed(event = event(), initialDate = june16, zone = denver)
            .withSeriesBaseline(
                RecurringEventSeriesFields(
                    allDay = false,
                    isCountdown = false,
                    participantIds = listOf("p1"),
                    goalId = null,
                    goalStepId = null,
                    rrule = null,
                    recurrenceEndAt = null,
                ),
            )
            .copy(personIds = listOf("p1", "p2"))

        assertFalse(draft.seriesUnchanged())
    }

    // ---- recurring occurrences -------------------------------------------------

    private fun occurrence() = SyncedEvent(
        id = "occ-row-7",
        householdId = "h",
        title = "Soccer practice",
        // An override moved this one; the server still knows it by its original slot.
        startsAt = "2026-06-16T18:00:00Z",
        endsAt = "2026-06-16T19:00:00Z",
        personId = "p1",
        seriesId = "series-1",
        originalStart = "2026-06-16T17:00:00Z",
    )

    @Test
    fun anOccurrenceIsEditedThroughItsSeriesId() {
        // The occurrence row's own id is not an event the API knows: GET/PATCH/DELETE on it 404.
        val draft = EventDraft.seed(event = occurrence(), initialDate = june16, zone = denver)
        assertEquals("series-1", draft.editId)
    }

    @Test
    fun aPlainEventIsEditedThroughItsOwnId() {
        assertEquals("ev-1", EventDraft.seed(event = event(), initialDate = june16, zone = denver).editId)
        assertNull(EventDraft.seed(event = null, initialDate = june16, zone = denver).editId)
    }

    @Test
    fun anOccurrenceIsKeyedByItsOriginalSlotEvenAfterAnOverrideMovedIt() {
        val draft = EventDraft.seed(event = occurrence(), initialDate = june16, zone = denver)
        assertEquals("2026-06-16T17:00:00Z", draft.occurrenceStartIso)
    }

    @Test
    fun anOccurrenceIsRecurringThoughItsRowCarriesNoRule() {
        // Occurrence rows have no rrule (the master does), so the rule alone would skip the
        // "which occurrences?" question and write to the whole series.
        assertTrue(EventDraft.seed(event = occurrence(), initialDate = june16, zone = denver).isRecurring)
        assertFalse(EventDraft.seed(event = event(), initialDate = june16, zone = denver).isRecurring)
    }

    @Test
    fun justThisOneSendsNoSeriesRule() {
        val draft = EventDraft.seed(event = occurrence(), initialDate = june16, zone = denver)
            .copy(repeat = RepeatState(freq = RepeatFreq.Weekly), originalRrule = "FREQ=WEEKLY")
        assertNull(draft.seriesRrule(EditScope.This))
        assertFalse(draft.clearsRrule(EditScope.This))
        assertTrue(draft.seriesRrule(EditScope.All) != null)
    }

    @Test
    fun stoppingTheRepeatClearsTheRuleOnlyForTheSeries() {
        val draft = EventDraft.seed(event = occurrence(), initialDate = june16, zone = denver)
            .copy(repeat = RepeatState.NONE, originalRrule = "FREQ=WEEKLY")
        assertTrue(draft.clearsRrule(EditScope.All))
        assertTrue(draft.clearsRrule(null))
        assertFalse(draft.clearsRrule(EditScope.This))
    }
}
