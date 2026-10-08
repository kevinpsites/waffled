package app.waffled.feature.rhythms

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Translated from the "Rhythm editor" suite of `RhythmsTests.swift`. */
class RhythmFormTest {

    private val today = day("2026-08-26")

    private fun scheduling(title: String, count: Int, unit: RhythmForm.Unit, startsOn: String) =
        RhythmForm(shape = RhythmShape.Scheduling, title = title, count = count, unit = unit, startsOn = day(startsOn))

    @Test
    fun `a completion rhythm sends a first due date and no period anchor`() {
        val form = RhythmForm(
            shape = RhythmShape.Completion, title = "  Air filter  ", count = 3,
            unit = RhythmForm.Unit.Months, leadDays = 14, nextDue = day("2026-09-01"),
        )
        val body = form.createBody(today, UTC)
        assertEquals(JsonPrimitive("Air filter"), body["title"])
        assertEquals(JsonPrimitive("completion"), body["satisfiedBy"])
        assertEquals(JsonPrimitive("3 months"), body["every"])
        assertEquals(JsonPrimitive("14 days"), body["leadTime"])
        assertEquals(JsonPrimitive("2026-09-01T09:00:00Z"), body["nextDueAt"])
        assertFalse(body.containsKey("startsOn"))
        assertFalse(body.containsKey("rrule"))
    }

    @Test
    fun `a booking rhythm sends the period anchor and, only when automatic, a rule`() {
        var form = scheduling("Temple visit", 1, RhythmForm.Unit.Months, "2026-01-01")
        var body = form.createBody(today, UTC)
        assertEquals(JsonPrimitive("scheduling"), body["satisfiedBy"])
        assertEquals(JsonPrimitive("2026-01-01"), body["startsOn"])
        assertEquals(JsonPrimitive(false), body["autoSchedule"])
        assertFalse(body.containsKey("nextDueAt"))
        assertEquals(JsonNull, body["rrule"])

        form = form.copy(autoSchedule = true)
        body = form.createBody(today, UTC)
        assertEquals(JsonPrimitive("FREQ=MONTHLY"), body["rrule"])
    }

    @Test
    fun `a weekly rhythm can pick its day, rather than inheriting the anchor's`() {
        val form = scheduling("Temple visit", 1, RhythmForm.Unit.Weeks, "2026-01-01").copy(autoSchedule = true)
        assertEquals(JsonPrimitive("FREQ=WEEKLY;BYDAY=TH"), form.createBody(today, UTC)["rrule"])
        assertEquals(JsonPrimitive("FREQ=WEEKLY;BYDAY=WE"), form.copy(byday = listOf("WE")).createBody(today, UTC)["rrule"])
    }

    @Test
    fun `a monthly rhythm can say the last weekday instead of a day number`() {
        val form = scheduling("Deep clean", 1, RhythmForm.Unit.Months, "2026-01-03").copy(autoSchedule = true)
        assertEquals(JsonPrimitive("FREQ=MONTHLY"), form.createBody(today, UTC)["rrule"])
        val last = form.copy(monthlyMode = RhythmMonthlyMode.NthWeekday, monthlyOrdinal = -1)
        assertEquals(JsonPrimitive("FREQ=MONTHLY;BYDAY=-1SA"), last.createBody(today, UTC)["rrule"])
    }

    @Test
    fun `a monthly nth-weekday rhythm anchors its periods on the first of the month`() {
        val form = scheduling("Family outing", 1, RhythmForm.Unit.Months, "2026-09-19").copy(
            autoSchedule = true, monthlyMode = RhythmMonthlyMode.NthWeekday, monthlyOrdinal = 3,
        )
        val body = form.createBody(today, UTC)
        assertEquals(JsonPrimitive("2026-09-01"), body["startsOn"])
        assertEquals(JsonPrimitive("FREQ=MONTHLY;BYDAY=3SA"), body["rrule"])
    }

    @Test
    fun `the same date each month keeps the anchor it was given`() {
        val form = scheduling("Rent", 1, RhythmForm.Unit.Months, "2026-09-19").copy(autoSchedule = true)
        assertEquals(JsonPrimitive("2026-09-19"), form.createBody(today, UTC)["startsOn"])
    }

    @Test
    fun `a weekly cadence keeps its anchor`() {
        val form = scheduling("Every third weekend", 3, RhythmForm.Unit.Weeks, "2026-09-05").copy(autoSchedule = true)
        assertEquals(JsonPrimitive("2026-09-05"), form.createBody(today, UTC)["startsOn"])
    }

    @Test
    fun `a rhythm booked by hand keeps its anchor whatever the monthly mode says`() {
        val form = scheduling("Booked by hand", 1, RhythmForm.Unit.Months, "2026-09-19").copy(
            monthlyMode = RhythmMonthlyMode.NthWeekday, monthlyOrdinal = 3,
        )
        assertEquals(JsonPrimitive("2026-09-19"), form.createBody(today, UTC)["startsOn"])
    }

    @Test
    fun `asking for the whole cycle sends the cadence, not a day count`() {
        val form = scheduling("Family outing", 1, RhythmForm.Unit.Months, "2026-09-01").copy(leadDays = 30)
        assertEquals(JsonPrimitive("1 months"), form.createBody(today, UTC)["leadTime"])
    }

    @Test
    fun `a runway that is genuinely a tail still travels as days`() {
        val form = scheduling("Temple visit", 1, RhythmForm.Unit.Months, "2026-09-01").copy(leadDays = 5)
        assertEquals(JsonPrimitive("5 days"), form.createBody(today, UTC)["leadTime"])
    }

    @Test
    fun `a booking window is sent alongside the cadence it sits inside`() {
        val form = scheduling("Date night", 1, RhythmForm.Unit.Months, "2026-09-01").copy(windowDays = 7)
        assertEquals(JsonPrimitive("7 days"), form.createBody(today, UTC)["bookWithin"])
    }

    @Test
    fun `no window means the whole period counts`() {
        val form = scheduling("Temple visit", 3, RhythmForm.Unit.Months, "2026-09-01")
        assertEquals(JsonNull, form.createBody(today, UTC)["bookWithin"])
    }

    @Test
    fun `a rhythm that books itself sends no window`() {
        val form = scheduling("Both", 1, RhythmForm.Unit.Months, "2026-09-01").copy(autoSchedule = true, windowDays = 7)
        assertEquals(JsonNull, form.createBody(today, UTC)["bookWithin"])
    }

    @Test
    fun `the window is the one part of WHEN that can be edited in place`() {
        val form = RhythmForm.editing(
            rhythm(id = "a", title = "Date night", satisfiedBy = RhythmShape.Scheduling, every = "1 mon", startsOn = "2026-09-01"),
            UTC,
        ).copy(windowDays = 10)
        val body = form.patchBody()
        assertEquals(JsonPrimitive("10 days"), body["bookWithin"])
        assertFalse(body.containsKey("startsOn"))
        assertFalse(body.containsKey("autoSchedule"))
    }

    @Test
    fun `clearing the window says so, rather than leaving it out`() {
        val form = RhythmForm.editing(
            rhythm(id = "a", title = "Date night", satisfiedBy = RhythmShape.Scheduling, every = "1 mon", startsOn = "2026-09-01"),
            UTC,
        ).copy(windowDays = null)
        assertEquals(JsonNull, form.patchBody()["bookWithin"])
    }

    @Test
    fun `a raw rule overrides the builder entirely`() {
        val form = scheduling("Odd one", 1, RhythmForm.Unit.Months, "2026-01-01")
            .copy(autoSchedule = true, customRule = "FREQ=MONTHLY;BYDAY=2FR")
        assertEquals(JsonPrimitive("FREQ=MONTHLY;BYDAY=2FR"), form.createBody(today, UTC)["rrule"])
    }

    @Test
    fun `editing covers only the fields the server allows to change in place`() {
        val form = RhythmForm.editing(
            rhythm(id = "a", title = "Air filter", every = "3 mons", nextDueAt = "2026-08-20T09:00:00Z"),
            UTC,
        ).copy(title = "Furnace filter", count = 6, unit = RhythmForm.Unit.Months)
        val body = form.patchBody()
        assertEquals(JsonPrimitive("Furnace filter"), body["title"])
        assertEquals(JsonPrimitive("6 months"), body["every"])
        for (key in listOf("satisfiedBy", "startsOn", "autoSchedule", "rrule")) assertFalse(body.containsKey(key))
    }

    @Test
    fun `an existing rhythm seeds the form from its stored cadence`() {
        val form = RhythmForm.editing(
            rhythm(id = "a", title = "Trash", satisfiedBy = RhythmShape.Scheduling, every = "7 days",
                startsOn = "2026-01-01", leadTime = "3 days 12:00:00"),
            UTC,
        )
        assertEquals("Trash", form.title)
        assertEquals(1, form.count)
        assertEquals(RhythmForm.Unit.Weeks, form.unit)
        assertEquals(RhythmShape.Scheduling, form.shape)
        assertEquals(3, form.leadDays)
        assertEquals("a", form.editingId)
        assertEquals(day("2026-01-01"), form.startsOn)
    }

    @Test
    fun `an hours-only runway seeds as whole days, not zero`() {
        val form = RhythmForm.editing(
            rhythm(id = "a", title = "Trash", satisfiedBy = RhythmShape.Scheduling, every = "7 days",
                startsOn = "2026-01-01", leadTime = "36:00:00"),
            UTC,
        )
        assertEquals(1, form.leadDays)
    }

    @Test
    fun `a blank title can't be submitted`() {
        assertFalse(RhythmForm().isValid)
        assertFalse(RhythmForm(title = "   ").isValid)
        assertTrue(RhythmForm(title = "Trash").isValid)
    }

    @Test
    fun `an untouched form asks for a runway the cadence can actually hold`() {
        var form = RhythmForm(shape = RhythmShape.Scheduling, title = "Trash", count = 1, unit = RhythmForm.Unit.Weeks)
        assertEquals(3, form.effectiveLeadDays)
        assertEquals(JsonPrimitive("3 days"), form.createBody(today, UTC)["leadTime"])
        assertFalse(RhythmFormat.nudgePlan(form.every, form.effectiveLeadDays).capped)

        form = form.copy(count = 3, unit = RhythmForm.Unit.Months)
        assertEquals(14, form.effectiveLeadDays)

        form = form.copy(leadDays = 30)
        assertEquals(30, form.effectiveLeadDays)
    }

    @Test
    fun `a brand-new rhythm is due one cadence out, not today`() {
        var form = RhythmForm(shape = RhythmShape.Completion, title = "Air filter", count = 3, unit = RhythmForm.Unit.Months)
        assertEquals(day("2026-11-26"), form.firstDue(today))
        assertEquals(JsonPrimitive("2026-11-26T09:00:00Z"), form.createBody(today, UTC)["nextDueAt"])

        form = form.copy(nextDue = day("2026-09-01"))
        assertEquals(day("2026-09-01"), form.firstDue(today))
    }

    @Test
    fun `a blank sentence opens on the completion shape`() {
        assertEquals(RhythmShape.Completion, RhythmForm().shape)
    }

    @Test
    fun `the editor's empty fields go out as explicit nulls, and a person id as itself`() {
        val body = RhythmForm(title = "Trash", personId = "p1").createBody(today, UTC)
        assertEquals(JsonNull, body["emoji"])
        assertEquals(JsonNull, body["notes"])
        assertEquals(JsonPrimitive("p1"), body["personId"])
        val patch = RhythmForm(title = "Trash", emoji = " 🗑 ").patchBody()
        assertEquals(JsonPrimitive("🗑"), patch["emoji"])
        assertEquals(JsonNull, patch["personId"])
    }

    @Test
    fun `the recurrence copy describes the rule it built`() {
        val start = day("2026-01-01")
        assertEquals("Every month", RhythmRecurrence.describeRrule("FREQ=MONTHLY", start))
        assertEquals("Every 2 weeks on Wed", RhythmRecurrence.describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE", start))
        assertEquals("Every month on the third Saturday", RhythmRecurrence.describeRrule("FREQ=MONTHLY;BYDAY=3SA", start))
        assertNotNull(RhythmRecurrence.weekdays.firstOrNull { it == "SU" })
        assertNull(RhythmForm(shape = RhythmShape.Completion, title = "x").bookWithinInterval)
    }
}
