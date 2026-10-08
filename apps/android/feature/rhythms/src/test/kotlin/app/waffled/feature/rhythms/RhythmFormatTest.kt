package app.waffled.feature.rhythms

import app.waffled.feature.rhythms.RhythmFormat.Countdown.Tone
import app.waffled.feature.rhythms.RhythmFormat.Urgency
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Translated from the pure-logic suites of `RhythmsTests.swift`. */
class RhythmFormatTest {

    // ---- interval rendering ----

    @Test
    fun `Postgres interval shorthand becomes plain English`() {
        assertEquals("3 months", RhythmFormat.formatInterval("3 mons"))
        assertEquals("1 month", RhythmFormat.formatInterval("1 mon"))
        assertEquals("1 year", RhythmFormat.formatInterval("1 year"))
        assertEquals("1 week", RhythmFormat.formatInterval("7 days"))
        assertEquals("2 weeks", RhythmFormat.formatInterval("14 days"))
        assertEquals("10 days", RhythmFormat.formatInterval("10 days"))
        assertEquals("", RhythmFormat.formatInterval(""))
    }

    @Test
    fun `the HH-MM-SS tail Postgres appends for a clamped runway is rendered too`() {
        assertEquals("3 days 12 hours", RhythmFormat.formatInterval("3 days 12:00:00"))
        assertEquals("12 hours", RhythmFormat.formatInterval("12:00:00"))
    }

    @Test
    fun `a single unit reads as every week, not every 1 week`() {
        assertEquals("every week", RhythmFormat.cadenceLabel("7 days"))
        assertEquals("every 3 months", RhythmFormat.cadenceLabel("3 mons"))
        assertEquals("every month", RhythmFormat.cadenceLabel("1 mon"))
        assertEquals("", RhythmFormat.cadenceLabel(""))
    }

    // ---- status lines ----

    private val statusNow = at("2026-08-18T12:00:00")

    @Test
    fun `the completion shape states its due date plainly`() {
        assertEquals("due today", RhythmFormat.dueLabel("2026-08-18T09:00:00Z", false, statusNow, UTC))
        assertEquals("due tomorrow", RhythmFormat.dueLabel("2026-08-19T09:00:00Z", false, statusNow, UTC))
        assertEquals("in 5 days", RhythmFormat.dueLabel("2026-08-23T09:00:00Z", false, statusNow, UTC))
        assertEquals("3 days late", RhythmFormat.dueLabel("2026-08-15T09:00:00Z", true, statusNow, UTC))
        assertEquals("1 day late", RhythmFormat.dueLabel("2026-08-18T09:00:00Z", true, statusNow, UTC))
    }

    @Test
    fun `the scheduling shape talks about the booking window, never follow-through`() {
        assertEquals("7 days left to book it", RhythmFormat.periodLabel("2026-08-25", statusNow, UTC))
        assertEquals("this period ends today", RhythmFormat.periodLabel("2026-08-18", statusNow, UTC))
        assertEquals("this period has ended", RhythmFormat.periodLabel("2026-08-10", statusNow, UTC))
        val banned = listOf("streak", "completed", "on track", "missed", "failed")
        for (end in listOf("2026-08-25", "2026-08-18", "2026-08-10")) {
            val text = RhythmFormat.periodLabel(end, statusNow, UTC).lowercase()
            for (word in banned) assertFalse(text.contains(word))
        }
    }

    @Test
    fun `the last bookable day is the day before periodEnd`() {
        assertEquals("2026-08-31", RhythmFormat.lastDayOfPeriod("2026-09-01"))
        assertEquals("2025-12-31", RhythmFormat.lastDayOfPeriod("2026-01-01"))
    }

    // ---- attention ordering ----

    @Test
    fun `overdue first, then merely due, then the things that need booking`() {
        val items = listOf(
            unscheduled(rhythm(id = "b", title = "Temple visit", satisfiedBy = RhythmShape.Scheduling), "2026-08-01", "2026-09-01"),
            due(rhythm(id = "c", title = "Smoke alarm"), "2026-08-22T09:00:00Z", overdue = false),
            due(rhythm(id = "a", title = "Air filter"), "2026-08-15T09:00:00Z", overdue = true),
            unscheduled(rhythm(id = "d", title = "A self-care day", satisfiedBy = RhythmShape.Scheduling), "2026-08-01", "2026-09-01"),
        )
        assertEquals(listOf("a", "c", "d", "b"), RhythmAttention.sorted(items).map { it.rhythm.id })
    }

    @Test
    fun `ties inside a rank break alphabetically`() {
        val items = listOf(
            due(rhythm(id = "z", title = "Zed"), "2026-08-22T09:00:00Z", overdue = false),
            due(rhythm(id = "a", title = "apple"), "2026-08-22T09:00:00Z", overdue = false),
        )
        assertEquals(listOf("a", "z"), RhythmAttention.sorted(items).map { it.rhythm.id })
    }

    // ---- the nudge runway ----

    @Test
    fun `a booking rhythm can be nudged from the first day of its period`() {
        val plan = RhythmFormat.nudgePlan("1 mon", 30, RhythmShape.Scheduling)
        assertEquals(30, plan.effectiveDays)
        assertFalse(plan.capped)
    }

    @Test
    fun `a runway longer than the cycle is still refused`() {
        val plan = RhythmFormat.nudgePlan("7 days", 30, RhythmShape.Scheduling)
        assertEquals(7, plan.effectiveDays)
        assertTrue(plan.capped)
    }

    @Test
    fun `a rhythm you mark done keeps the half-cadence ceiling`() {
        val plan = RhythmFormat.nudgePlan("7 days", 14, RhythmShape.Completion)
        assertEquals(3, plan.effectiveDays)
        assertTrue(plan.capped)
    }

    @Test
    fun `a booking window is the ceiling when there is one`() {
        val plan = RhythmFormat.nudgePlan("1 mon", 30, RhythmShape.Scheduling, bookWithin = "7 days")
        assertEquals(7, plan.effectiveDays)
        assertTrue(plan.capped)
    }

    @Test
    fun `the runway stands when the cadence has room for it`() {
        val plan = RhythmFormat.nudgePlan("3 mons", 14)
        assertEquals(14, plan.effectiveDays)
        assertFalse(plan.capped)
    }

    @Test
    fun `the clamp is admitted in the sentence's own terms, or not at all`() {
        val note = RhythmFormat.capNote("7 days", 14)
        assertNotNull(note)
        assertTrue(note.contains("14 days"))
        assertTrue(note.contains("a week"))
        assertTrue(note.contains("trimmed to 3"))
        assertNull(RhythmFormat.capNote("3 mons", 14))
        assertNull(RhythmFormat.capNote("7 days", 3))
    }

    @Test
    fun `the consequence block promises the dates the server will actually use`() {
        val booking = RhythmFormat.consequence(RhythmShape.Scheduling, "1 weeks", 14, anchor = day("2026-08-26"))
        assertEquals(day("2026-09-02"), booking.landsOn)
        assertEquals(day("2026-08-26"), booking.nudgeFrom)
        assertTrue(booking.capped)

        val doing = RhythmFormat.consequence(RhythmShape.Completion, "3 mons", 14, anchor = day("2026-11-26"))
        assertEquals(day("2026-11-26"), doing.landsOn)
        assertEquals(day("2026-11-12"), doing.nudgeFrom)
        assertFalse(doing.capped)
    }

    @Test
    fun `adding a cadence to a month-end date lands inside the next month`() {
        val jan31 = day("2026-01-31")
        assertEquals(day("2026-02-28"), RhythmFormat.addCadence(jan31, "1 months"))
        assertEquals(day("2026-02-14"), RhythmFormat.addCadence(jan31, "2 weeks"))
        assertEquals(day("2027-01-31"), RhythmFormat.addCadence(jan31, "1 years"))
        assertEquals(jan31, RhythmFormat.addCadence(jan31, "nonsense"))
    }

    @Test
    fun `pushing a rhythm out buys a week from the later of today and the due date`() {
        val now = at("2026-08-20T09:00:00")
        assertEquals("2026-08-27", RhythmFormat.ymd(RhythmFormat.pushOut("2026-08-14T09:00:00Z", now, UTC)!!, UTC))
        assertEquals("2026-08-30", RhythmFormat.ymd(RhythmFormat.pushOut("2026-08-23T09:00:00Z", now, UTC)!!, UTC))
        assertNull(RhythmFormat.pushOut(null, now, UTC))
    }

    // ---- nudge explainer copy ----

    @Test
    fun `the explainer names the cadence rather than the period`() {
        val text = RhythmFormat.nudgeExplainer("7 days", 1)
        assertTrue(text.contains("every week"))
        assertFalse(text.contains("the period ends"))
    }

    @Test
    fun `the explainer states what the clamp actually did`() {
        val text = RhythmFormat.nudgeExplainer("7 days", 14)
        assertTrue(text.contains("from its first day"))
        assertTrue(text.contains("trimmed to 7 days"))
    }

    @Test
    fun `the explainer says the last N days while the runway is a tail`() {
        assertTrue(RhythmFormat.nudgeExplainer("1 mon", 5).contains("last 5 days"))
    }

    @Test
    fun `the explainer clamps to the booking window when there is one`() {
        assertTrue(RhythmFormat.nudgeExplainer("1 mon", 30, bookWithin = "7 days").contains("trimmed to 7 days"))
    }

    @Test
    fun `a zero runway nudges only on the final day`() {
        assertTrue(RhythmFormat.nudgeExplainer("7 days", 0).contains("last day"))
    }

    @Test
    fun `the explanation never turns into follow-through talk`() {
        val text = RhythmFormat.nudgeExplainer("3 mons", 14).lowercase()
        for (word in listOf("streak", "on track", "missed", "completed")) assertFalse(text.contains(word))
    }

    // ---- completion acknowledgement ----

    private val ackNow = at("2026-08-19T15:00:00")

    @Test
    fun `a rhythm completed earlier today counts as done today, yesterday's does not`() {
        assertTrue(RhythmFormat.wasCompletedToday("2026-08-19T09:00:00Z", ackNow, UTC))
        assertFalse(RhythmFormat.wasCompletedToday("2026-08-18T23:30:00Z", ackNow, UTC))
        assertFalse(RhythmFormat.wasCompletedToday(null, ackNow, UTC))
    }

    @Test
    fun `the label states which of the three states the row is in`() {
        val fresh = RhythmFormat.completionAction(doneToday = false, due = false)
        val nagged = RhythmFormat.completionAction(doneToday = false, due = true)
        val settled = RhythmFormat.completionAction(doneToday = true, due = false)
        assertEquals("I did it today", fresh)
        assertEquals("I did it", nagged)
        assertEquals("Done today ✓", settled)
        assertEquals(3, setOf(fresh, nagged, settled).size)
        for (word in listOf("streak", "on track", "missed", "kept up", "complete rate")) {
            assertFalse(settled.lowercase().contains(word))
        }
    }

    // ---- banding ----

    private val bandNow = at("2026-08-20T12:00:00")

    @Test
    fun `a rhythm the server is nudging about is needs-you-now whatever its dates say`() {
        val r = rhythm(nextDueAt = "2026-11-01T09:00:00Z", satisfied = true)
        assertEquals(Urgency.Now, RhythmFormat.urgency(r, due(r, "2026-11-01T09:00:00Z", false), bandNow, UTC))
    }

    @Test
    fun `overdue still reads as urgent when the attention call has not come back`() {
        val r = rhythm(nextDueAt = "2026-08-14T09:00:00Z", satisfied = false)
        assertEquals(Urgency.Now, RhythmFormat.urgency(r, null, bandNow, UTC))
    }

    @Test
    fun `a fortnight is the horizon for coming up`() {
        assertEquals(Urgency.Soon, RhythmFormat.urgency(rhythm(nextDueAt = "2026-08-30T09:00:00Z"), null, bandNow, UTC))
        assertEquals(Urgency.Steady, RhythmFormat.urgency(rhythm(nextDueAt = "2026-09-20T09:00:00Z"), null, bandNow, UTC))
    }

    @Test
    fun `a booked period is steady`() {
        val r = rhythm(
            satisfiedBy = RhythmShape.Scheduling, every = "7 days",
            currentPeriodStart = "2026-08-17", currentPeriodEnd = "2026-08-24", satisfied = true,
        )
        assertEquals(Urgency.Steady, RhythmFormat.urgency(r, null, bandNow, UTC))
    }

    @Test
    fun `an unbooked period whose runway has not opened is steady`() {
        val quiet = rhythm(
            id = "c", title = "Self-care day", satisfiedBy = RhythmShape.Scheduling,
            startsOn = "2026-07-01", currentPeriodStart = "2026-10-01",
            currentPeriodEnd = "2027-01-01", satisfied = false,
        )
        assertEquals(Urgency.Steady, RhythmFormat.urgency(quiet, null, at("2026-08-18T12:00:00"), UTC))
    }

    @Test
    fun `a paused rhythm is off, not merely quiet`() {
        val r = rhythm(nextDueAt = "2026-08-01T09:00:00Z", isActive = false)
        assertEquals(Urgency.Paused, RhythmFormat.urgency(r, null, bandNow, UTC))
    }

    // ---- countdown ----

    private val scheduledWeek = rhythm(
        satisfiedBy = RhythmShape.Scheduling, every = "7 days",
        currentPeriodStart = "2026-08-17", currentPeriodEnd = "2026-08-24",
    )

    @Test
    fun `days late count up`() {
        val cd = RhythmFormat.countdown(rhythm(nextDueAt = "2026-08-14T09:00:00Z"), Urgency.Now, bandNow, UTC)
        assertEquals("6", cd?.number)
        assertEquals("days late", cd?.unit)
    }

    @Test
    fun `distant dates collapse into weeks and then months`() {
        val weeks = RhythmFormat.countdown(rhythm(nextDueAt = "2026-09-20T09:00:00Z"), Urgency.Steady, bandNow, UTC)
        assertEquals("4", weeks?.number)
        assertEquals("weeks", weeks?.unit)
        val months = RhythmFormat.countdown(rhythm(nextDueAt = "2026-11-25T09:00:00Z"), Urgency.Steady, bandNow, UTC)
        assertEquals("months", months?.unit)
    }

    @Test
    fun `a settled booking reads Booked, with when`() {
        val cd = RhythmFormat.countdown(
            scheduledWeek.copy(satisfied = true, bookedAt = "2026-08-19T18:00:00Z"), Urgency.Steady, bandNow, UTC,
        )
        assertEquals("Booked", cd?.number)
        assertEquals("Aug 19, 6:00 PM", cd?.unit)
    }

    @Test
    fun `an all-day booking gives its date and no invented time`() {
        val cd = RhythmFormat.countdown(
            scheduledWeek.copy(satisfied = true, bookedAt = "2026-08-19T00:00:00Z", bookedAllDay = true),
            Urgency.Steady, bandNow, UTC,
        )
        assertEquals("Booked", cd?.number)
        assertEquals("Aug 19", cd?.unit)
    }

    @Test
    fun `a skipped period says Handled and nothing about time`() {
        val cd = RhythmFormat.countdown(scheduledWeek.copy(satisfied = true, bookedAt = null), Urgency.Steady, bandNow, UTC)
        assertEquals("Handled", cd?.number)
        assertEquals("this period", cd?.unit)
    }

    @Test
    fun `an unbooked period counts down to the day the window closes`() {
        val cd = RhythmFormat.countdown(scheduledWeek.copy(satisfied = false), Urgency.Soon, bandNow, UTC)
        assertEquals("4", cd?.number)
        assertEquals("days left", cd?.unit)
    }

    @Test
    fun `the countdown's tone comes from the band, not from the word late`() {
        val now = at("2026-08-26T12:00:00")
        val closing = rhythm(
            id = "t", title = "Trash", satisfiedBy = RhythmShape.Scheduling, every = "7 days",
            currentPeriodStart = "2026-08-21", currentPeriodEnd = "2026-08-27", satisfied = false,
        )
        val cd = RhythmFormat.countdown(closing, Urgency.Now, now, UTC)
        assertEquals("day left", cd?.unit)
        assertEquals(Tone.Late, cd?.tone)
        assertEquals(Tone.Near, RhythmFormat.countdown(rhythm(id = "a", nextDueAt = "2026-09-02T09:00:00Z"), Urgency.Soon, now, UTC)?.tone)
        assertEquals(Tone.Soft, RhythmFormat.countdown(rhythm(id = "b", nextDueAt = "2026-11-25T09:00:00Z"), Urgency.Steady, now, UTC)?.tone)
        val booked = closing.copy(id = "c", satisfied = true)
        assertEquals(Tone.Done, RhythmFormat.countdown(booked, Urgency.Steady, now, UTC)?.tone)
    }

    // ---- period progress ----

    @Test
    fun `the bar measures the real period for a booking rhythm`() {
        val r = rhythm(
            satisfiedBy = RhythmShape.Scheduling, every = "7 days",
            currentPeriodStart = "2026-08-18", currentPeriodEnd = "2026-08-22", satisfied = false,
        )
        assertEquals(63, RhythmFormat.periodProgress(r, bandNow, UTC))
    }

    @Test
    fun `it stops at full instead of overflowing its track when overdue`() {
        val r = rhythm(every = "7 days", lastCompletedAt = "2026-08-01T09:00:00Z", nextDueAt = "2026-08-08T09:00:00Z")
        assertEquals(100, RhythmFormat.periodProgress(r, bandNow, UTC))
    }

    @Test
    fun `it declines to draw a bar it cannot measure`() {
        assertNull(RhythmFormat.periodProgress(rhythm(nextDueAt = null), bandNow, UTC))
        assertNull(
            RhythmFormat.periodProgress(
                rhythm(lastCompletedAt = "2026-09-01T09:00:00Z", nextDueAt = "2026-08-25T09:00:00Z"), bandNow, UTC,
            ),
        )
    }

    // ---- small helpers ----

    @Test
    fun `whole days in an interval carry an hours tail of a day or more`() {
        assertEquals(3, RhythmFormat.days("3 days 12:00:00"))
        assertEquals(1, RhythmFormat.days("36:00:00"))
        assertEquals(90, RhythmFormat.days("3 mons"))
    }

    @Test
    fun `instants go out as whole-second ISO strings`() {
        assertEquals("2026-11-26T09:00:00Z", RhythmFormat.isoInstant(at("2026-11-26T09:00:00").plusMillis(345)))
    }

    @Test
    fun `short dates and sentence case`() {
        assertEquals("Mar 1, 2027", RhythmFormat.shortDate("2027-03-01", UTC))
        assertEquals("May 24, 2026", RhythmFormat.shortDate("2026-05-24T09:00:00Z", UTC))
        assertEquals("—", RhythmFormat.shortDate(null, UTC))
        assertEquals("Every 3 months", RhythmFormat.sentence("every 3 months"))
    }
}
