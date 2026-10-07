package app.waffled.feature.calendar

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.Person
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The calendar's derived state.
 *
 * The rule under test is the one `DerivedEventState` in `core:sync` documents for its own
 * three inputs, and which this model inherits for ITS three: the rows depend on the synced
 * events, on the household display settings, and on the member list — and the last two
 * arrive over REST, LATER than the events. Rebuilding only when the events change would
 * resolve every colour once against the defaults and never correct itself, which compiles,
 * passes a naive test, and is wrong only on screen.
 */
class CalendarModelTest {

    private val denver: ZoneId = ZoneId.of("America/Denver")
    private val june16 = LocalDate.of(2026, 6, 16)

    private fun event(id: String, owner: String? = null, startsAt: String = "2026-06-16T17:00:00Z") =
        SyncedEvent(id = id, householdId = "h", title = id, startsAt = startsAt, personId = owner)

    private fun scope() = TestScope(UnconfinedTestDispatcher())

    private fun model(
        events: MutableStateFlow<Map<LocalDate, List<SyncedEvent>>>,
        scope: TestScope,
    ) = CalendarModel(eventsByDay = events, scope = scope)

    @Test
    fun rowsCarryTheSyncedParticipants() = runTest {
        val shared = event("e1", owner = "p1").copy(participantIds = listOf("p2", "p3"))
        val model = model(MutableStateFlow(mapOf(june16 to listOf(shared))), scope())

        assertEquals(setOf("p2", "p3"), model.rowsByDay.value.getValue(june16).first().people.participantIds)
    }

    @Test
    fun buildsRowsFromTheSyncedDayBucketsWithoutRebucketing() = runTest {
        val scope = scope()
        val events = MutableStateFlow(mapOf(june16 to listOf(event("e1"))))
        val model = model(events, scope)
        // Pinned, or the label follows whatever zone the build machine happens to be in.
        model.setZone(denver)

        assertEquals(listOf("e1"), model.rowsByDay.value[june16]?.map { it.id })
        assertEquals("11:00 AM", model.rowsByDay.value.getValue(june16).first().timeLabel)
    }

    @Test
    fun theOwnersColourReachesTheRowOnceTheMembersLand() {
        // The synced event row carries no colour at all, so without the member join every
        // accent bar renders in the fallback grey — visible only on screen, never in a test
        // that asserts on ids.
        val scope = scope()
        val events = MutableStateFlow(mapOf(june16 to listOf(event("e1", owner = "p1"))))
        val model = model(events, scope)

        assertNull(model.rowsByDay.value.getValue(june16).first().colorHex)

        model.setMembers(listOf(Person(id = "p1", name = "Jerry", colorHex = "#2F7FED")))

        assertEquals("#2F7FED", model.rowsByDay.value.getValue(june16).first().colorHex)
    }

    @Test
    fun aWholeFamilyEventRepaintsWhenTheDisplaySettingsArrive() {
        // The family colour is a REST setting that lands after the events. If the rows are
        // keyed only on events, this event keeps Jerry's blue for ever.
        val scope = scope()
        val events = MutableStateFlow(mapOf(june16 to listOf(event("e1", owner = "p1"))))
        val model = model(events, scope)
        model.setMembers(
            listOf(Person(id = "p1", name = "Jerry", colorHex = "#2F7FED")),
        )
        // One member: never a family event, so it keeps the owner's colour.
        assertEquals("#2F7FED", model.rowsByDay.value.getValue(june16).first().colorHex)

        model.setDisplay(CalendarApi.HouseholdDisplay(style = EventStyle.Tinted, familyHex = "#123ABC"))

        assertEquals(EventStyle.Tinted, model.palette.value.style)
        assertEquals("#123ABC", model.palette.value.familyHex)
    }

    @Test
    fun theZoneChangesWhichDayALateEventLabelsAsAndItRebuilds() {
        // 2026-06-17 03:00 UTC is 21:00 on the 16th in Denver but 03:00 on the 17th in UTC.
        // The bucketing belongs to core:sync, but the LABEL is ours, and it must follow the
        // household zone rather than whichever one happened to load first.
        val scope = scope()
        val events = MutableStateFlow(mapOf(june16 to listOf(event("late", startsAt = "2026-06-17T03:00:00Z"))))
        val model = model(events, scope)

        model.setZone(ZoneId.of("UTC"))
        assertEquals("3:00 AM", model.rowsByDay.value.getValue(june16).first().timeLabel)

        model.setZone(denver)
        assertEquals("9:00 PM", model.rowsByDay.value.getValue(june16).first().timeLabel)
    }

    @Test
    fun theAgendaStartsAtTodayAndSkipsWhatHasAlreadyGone() {
        val scope = scope()
        val events = MutableStateFlow(
            mapOf(
                LocalDate.of(2026, 6, 10) to listOf(event("past", startsAt = "2026-06-10T17:00:00Z")),
                june16 to listOf(event("today", startsAt = "2026-06-16T17:00:00Z")),
                LocalDate.of(2026, 6, 20) to listOf(event("future", startsAt = "2026-06-20T17:00:00Z")),
            ),
        )
        val model = model(events, scope)

        val groups = model.upcoming(from = june16)
        assertEquals(listOf(june16, LocalDate.of(2026, 6, 20)), groups.map { it.day })
    }

    @Test
    fun thePersonFilterKeepsOnlyThatPersonsDaysAndDropsEmptyOnes() {
        val scope = scope()
        val events = MutableStateFlow(
            mapOf(
                june16 to listOf(event("mine", owner = "p1")),
                LocalDate.of(2026, 6, 17) to listOf(event("theirs", owner = "p2", startsAt = "2026-06-17T17:00:00Z")),
            ),
        )
        val model = model(events, scope)

        val filtered = model.filtered(personId = "p1")

        assertEquals(setOf(june16), filtered.keys)
        assertEquals(listOf("mine"), filtered.getValue(june16).map { it.id })
        // No filter = everything, and the same map instance rather than a rebuilt copy.
        assertEquals(2, model.filtered(personId = null).size)
    }

    @Test
    fun aFailedRefreshSaysSoWithTheServersMessageAndKeepsWhatItHad() = runTest {
        val harness = app.waffled.core.testing.ApiTestHarness()
        harness.start()
        try {
            val api = CalendarApi(
                app.waffled.core.network.WaffledHttp.client(harness.tokens, harness.serverAddress),
                harness.tokens,
            )
            val model = model(MutableStateFlow(emptyMap()), scope())
            model.setMembers(listOf(Person(id = "p1", name = "Jerry")))

            harness.enqueueError(503, "Unavailable", "Household settings are down for maintenance.")
            harness.enqueueError(503, "Unavailable", "Household settings are down for maintenance.")
            assertTrue(!model.refresh(api))

            assertTrue(model.loadError.value.orEmpty().contains("down for maintenance"), model.loadError.value)
            assertEquals(listOf("p1"), model.members.value.map { it.id })

            harness.enqueueJson("""{"household":{"id":"h1","name":"X","timezone":"UTC"},"members":[]}""")
            harness.enqueueJson("""{"household":{"settings":{}}}""")
            assertTrue(model.refresh(api))
            assertNull(model.loadError.value)
        } finally {
            harness.stop()
        }
    }

    @Test
    fun aMondayHouseholdsMonthGridOpensOnMonday() {
        // June 2026 starts on a Monday, so a Monday-cut grid has no lead-in cells at all.
        val cells = CalendarModel.monthCells(LocalDate.of(2026, 6, 15), HouseholdWeekStart.Monday)
        assertEquals(42, cells.size)
        assertEquals(LocalDate.of(2026, 6, 1), cells.first().date)
        assertEquals(java.time.DayOfWeek.MONDAY, cells.first().date.dayOfWeek)
        assertEquals(
            HouseholdWeekStart.Monday.monthLeadCells(LocalDate.of(2026, 6, 1)),
            cells.indexOfFirst { it.inMonth },
        )
    }

    @Test
    fun theWeekdayHeaderRotatesWithTheGrid() {
        assertEquals(listOf("M", "T", "W", "T", "F", "S", "S"), CalendarModel.weekdayInitials(HouseholdWeekStart.Monday))
        assertEquals(listOf("S", "M", "T", "W", "T", "F", "S"), CalendarModel.weekdayInitials(HouseholdWeekStart.Sunday))
    }

    @Test
    fun theWeekStartFollowsTheSyncedHouseholdRow() {
        val synced = MutableStateFlow<String?>(null)
        val model = CalendarModel(eventsByDay = MutableStateFlow(emptyMap()), scope = scope(), syncedWeekStart = synced)
        assertEquals(HouseholdWeekStart.Sunday, model.weekStart.value)
        synced.value = "monday"
        assertEquals(HouseholdWeekStart.Monday, model.weekStart.value)
    }

    @Test
    fun theRestWeekStartStandsInUntilTheHouseholdRowSyncs() {
        val synced = MutableStateFlow<String?>(null)
        val model = CalendarModel(eventsByDay = MutableStateFlow(emptyMap()), scope = scope(), syncedWeekStart = synced)
        model.setRestWeekStart(HouseholdWeekStart.Monday)
        assertEquals(HouseholdWeekStart.Monday, model.weekStart.value)
        synced.value = "sunday"
        assertEquals(HouseholdWeekStart.Sunday, model.weekStart.value)
    }

    @Test
    fun theMonthGridIsSixSundayLedWeeksCoveringTheAnchorsMonth() {
        val cells = CalendarModel.monthCells(LocalDate.of(2026, 6, 15), HouseholdWeekStart.Sunday)

        assertEquals(42, cells.size)
        assertEquals(java.time.DayOfWeek.SUNDAY, cells.first().date.dayOfWeek)
        // June 2026 starts on a Monday, so the grid opens on Sunday 31 May — out of month.
        assertEquals(LocalDate.of(2026, 5, 31), cells.first().date)
        assertTrue(cells.first().inMonth.not())
        assertEquals(30, cells.count { it.inMonth })
    }

    @Test
    fun theMonthDotsShowOneColourPerDistinctEventColour() {
        // A whole-family event contributes the family colour, so a day everyone is on shows
        // one dot rather than three.
        val scope = scope()
        val events = MutableStateFlow(
            mapOf(june16 to listOf(event("a", owner = "p1"), event("b", owner = "p1"), event("c", owner = "p2"))),
        )
        val model = model(events, scope)
        model.setMembers(
            listOf(
                Person(id = "p1", name = "Jerry", colorHex = "#2F7FED"),
                Person(id = "p2", name = "Elaine", colorHex = "#E0548B"),
            ),
        )

        assertEquals(listOf("#2F7FED", "#E0548B"), model.dotColors(model.rowsByDay.value, june16))
    }

    @Test
    fun anEventOpenedFromOutsideResolvesToItsNextOccurrence() {
        // Today's event and countdown taps hand the calendar an id; a repeating event has a
        // row per day, so the one at or after today is the one the tap meant.
        val scope = scope()
        val june20 = LocalDate.of(2026, 6, 20)
        val events = MutableStateFlow(
            mapOf(
                LocalDate.of(2026, 6, 10) to listOf(event("rep", startsAt = "2026-06-10T17:00:00Z")),
                june16 to listOf(event("e1"), event("rep")),
                june20 to listOf(event("rep", startsAt = "2026-06-20T17:00:00Z")),
            ),
        )
        val model = model(events, scope)
        model.setZone(denver)

        assertEquals(june16, model.rowFor("rep", from = LocalDate.of(2026, 6, 12))?.day)
        assertEquals(june20, model.rowFor("rep", from = LocalDate.of(2026, 6, 17))?.day)
        // Only past occurrences left: the latest one, rather than nothing at all.
        assertEquals(june20, model.rowFor("rep", from = LocalDate.of(2026, 7, 1))?.day)
        assertEquals("e1", model.rowFor("e1", from = june16)?.id)
        assertNull(model.rowFor("missing", from = june16))
    }
}
