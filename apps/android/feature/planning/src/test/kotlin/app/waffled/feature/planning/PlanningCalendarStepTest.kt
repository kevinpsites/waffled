package app.waffled.feature.planning

import app.waffled.core.sync.EventBucketing
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.planning.steps.PlanningCalendarComposer
import app.waffled.feature.planning.steps.PlanningCalendarModel
import app.waffled.feature.planning.steps.PlanningWeekDays
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Weekly Planning · step 2 "Calendar". Port of iOS `PlanningCalendarStepTests.swift`: the
// seven days are the SERVER'S week plus 0…6, the line under the range names what is open,
// and the crumb is only ever a count.

class PlanningCalendarStepTest {

    @Test fun `the week is the server's week plus zero through six`() {
        val days = PlanningWeekDays.days("2026-09-06", "2026-09-09")
        assertEquals(
            listOf("2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"),
            days.map { it.key },
        )
        assertEquals("SUN", days.first().dow)
        assertEquals("Sunday", days.first().full)
        assertEquals("Sep 6", days.first().date)
        assertEquals("Saturday", days.last().full)
        assertEquals(listOf("2026-09-09"), days.filter { it.isToday }.map { it.key })
    }

    @Test fun `today outside the planned week marks no day`() {
        assertTrue(PlanningWeekDays.days("2026-09-06", "2026-09-05").none { it.isToday })
    }

    @Test fun `days step across dst and the year without slipping`() {
        assertEquals("2026-03-08", PlanningWeekDays.addDays("2026-03-07", 1))
        assertEquals("2026-03-09", PlanningWeekDays.addDays("2026-03-07", 2))
        assertEquals("2027-01-03", PlanningWeekDays.addDays("2026-12-28", 6))
        assertEquals(0, PlanningWeekDays.dayOfWeek("2026-09-06"))
        assertEquals(6, PlanningWeekDays.dayOfWeek("2026-09-12"))
    }

    @Test fun `garbage dates fall through rather than crashing`() {
        assertEquals("not-a-day", PlanningWeekDays.addDays("not-a-day", 3))
        assertEquals("nope", PlanningWeekDays.monthDay("nope"))
        assertEquals("", PlanningWeekDays.weekRangeLabel(""))
        assertTrue(PlanningWeekDays.days("nope", "2026-09-09").isEmpty())
    }

    @Test fun `the week range names the second month only when it straddles one`() {
        assertEquals("Sep 6 – 12", PlanningWeekDays.weekRangeLabel("2026-09-06"))
        assertEquals("Sep 27 – Oct 3", PlanningWeekDays.weekRangeLabel("2026-09-27"))
    }

    @Test fun `names reads like somebody saying them`() {
        assertEquals("", PlanningWeekDays.names(emptyList()))
        assertEquals("Sunday", PlanningWeekDays.names(listOf("Sunday")))
        assertEquals("Sunday and Thursday", PlanningWeekDays.names(listOf("Sunday", "Thursday")))
        assertEquals("Sunday, Thursday and Friday", PlanningWeekDays.names(listOf("Sunday", "Thursday", "Friday")))
    }

    @Test fun `the summary names what is still open`() {
        assertEquals("7 events · Sunday and Thursday are still open", PlanningWeekDays.summary(7, listOf("Sunday", "Thursday")))
        assertEquals("1 event · Friday is still open", PlanningWeekDays.summary(1, listOf("Friday")))
        assertEquals("28 events · every day has something", PlanningWeekDays.summary(28, emptyList()))
    }

    @Test fun `an empty week says so both ways`() {
        val all = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
        assertEquals("Nothing on the week yet · every day is still open", PlanningWeekDays.summary(0, all))
    }

    @Test fun `a trip counts once not once per day it covers`() {
        val days = PlanningWeekDays.days("2026-09-06", "2026-09-09")
        val denver = ZoneId.of("America/Denver")
        val trip = SyncedEvent(
            id = "trip", householdId = "h", title = "trip",
            startsAt = "2026-09-07T06:00:00Z", endsAt = "2026-09-12T06:00:00Z", allDay = true,
        )
        val dinner = SyncedEvent(id = "dinner", householdId = "h", title = "dinner", startsAt = "2026-09-08T01:00:00Z")
        val byDay = EventBucketing.byDay(listOf(trip, dinner), denver)
        assertTrue((byDay[LocalDate.parse("2026-09-08")]?.size ?: 0) >= 1)
        assertEquals(2, PlanningWeekDays.eventCount(days, byDay))
    }

    @Test fun `an edit opens on the event and is not counted as added`() {
        val event = SyncedEvent(id = "e1", householdId = "h", title = "Dentist", startsAt = null)
        val day = LocalDate.parse("2026-09-09")
        assertTrue(PlanningCalendarComposer(day, prefillTitle = null).countsAsAdded)
        val edit = PlanningCalendarComposer(day, prefillTitle = null, event = event)
        assertEquals("e1", edit.event?.id)
        assertFalse(edit.countsAsAdded)
    }

    @Test fun `adding an event is only ever a count`() {
        val model = PlanningCalendarModel()
        assertEquals<Map<String, Any>>(mapOf("added" to JsonPrimitive(0)), model.decisionData)
        model.recordEventAdded()
        model.recordEventAdded()
        assertEquals<Map<String, Any>>(mapOf("added" to JsonPrimitive(2)), model.decisionData)
        assertNull(model.decisionData["routes"])
    }
}
