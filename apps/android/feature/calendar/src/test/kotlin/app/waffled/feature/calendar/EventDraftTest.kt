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
    fun anAllDayEventCarriesNoEndAtAll() {
        val draft = EventDraft.seed(event = event(allDay = true), initialDate = june16, zone = denver)
        assertTrue(draft.allDay)
        assertNull(draft.endInstant(denver))
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
}
