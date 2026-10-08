package app.waffled.feature.calendar

import app.waffled.core.model.HouseholdWeekStart
import app.waffled.feature.calendar.PhoneCalendar.Mode
import app.waffled.core.sync.EventBucketing
import app.waffled.core.sync.SyncedEvent
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Port of apps/ios/Tests/PhoneCalendarLayoutTests.swift: the phone calendar's Month → Week →
// Day layout rules, month-row span bars and overlap lanes.

private val ny: ZoneId = ZoneId.of("America/New_York")

private fun day(key: String): LocalDate = LocalDate.parse(key)

private fun rowsOf(vararg events: SyncedEvent): Map<LocalDate, List<EventRow>> =
    Agenda.buildRows(EventBucketing.byDay(events.toList(), ny), ny)

private fun row(event: SyncedEvent): EventRow = rowsOf(event).values.first().first { it.id == event.id }

private fun timedEvent(id: String, start: String, minutes: Long? = 60, origin: String? = null): SyncedEvent {
    val s = LocalDateTime.parse(start.replace(' ', 'T'))
    return SyncedEvent(
        id = id,
        householdId = "h",
        title = id,
        startsAt = s.atZone(ny).toInstant().toString(),
        endsAt = minutes?.let { s.plusMinutes(it).atZone(ny).toInstant().toString() },
        origin = origin,
    )
}

private fun timed(id: String, start: String, minutes: Long? = 60): EventRow = row(timedEvent(id, start, minutes))

private fun trip(id: String, first: String, throughExclusive: String): SyncedEvent =
    SyncedEvent(id = id, householdId = "h", title = id, startsAt = first, endsAt = throughExclusive, allDay = true)

class PhoneCalendarModeTest {
    @Test
    fun aDaySavedByAnOlderBuildReopensOnMonth() {
        assertEquals(Mode.Month, Mode.restored(stored = Mode.Day, override = null))
        assertEquals(Mode.Week, Mode.restored(stored = Mode.Week, override = null))
        assertEquals(Mode.Agenda, Mode.restored(stored = Mode.Agenda, override = null))
    }

    @Test
    fun aLaunchOverrideCanStillOpenDay() {
        assertEquals(Mode.Day, Mode.restored(stored = Mode.Month, override = Mode.Day))
    }

    @Test
    fun spreadingZoomsInAndPinchingZoomsOut() {
        assertEquals(Mode.Week, Mode.Month.zoomed(zoomIn = true))
        assertEquals(Mode.Day, Mode.Week.zoomed(zoomIn = true))
        assertEquals(Mode.Day, Mode.Day.zoomed(zoomIn = true))
        assertEquals(Mode.Week, Mode.Day.zoomed(zoomIn = false))
        assertEquals(Mode.Month, Mode.Week.zoomed(zoomIn = false))
        assertEquals(Mode.Month, Mode.Month.zoomed(zoomIn = false))
    }

    @Test
    fun aStoredModeFromAnOlderBuildStillDecodes() {
        assertEquals(Mode.Agenda, Mode.fromWire("agenda"))
        assertNull(Mode.fromWire("people"))
    }
}

class PhoneCalendarMonthRowsTest {
    @Test
    fun aFiveWeekMonthOnAMondayHouseholdHasFiveRowsLedByMonday() {
        val rows = PhoneCalendar.monthRows(day("2026-09-15"), HouseholdWeekStart.Monday)
        assertEquals(5, rows.size)
        assertEquals(day("2026-08-31"), rows.first().days.first().date)
        assertEquals(day("2026-10-04"), rows.last().days.last().date)
        assertEquals(listOf(36, 37, 38, 39, 40), rows.map { it.weekNumber })
    }

    @Test
    fun aSundayHouseholdNumbersEachRowByTheMondayInsideIt() {
        val rows = PhoneCalendar.monthRows(day("2026-09-15"), HouseholdWeekStart.Sunday)
        assertEquals(5, rows.size)
        assertEquals(day("2026-08-30"), rows.first().days.first().date)
        assertEquals(listOf(36, 37, 38, 39, 40), rows.map { it.weekNumber })
    }

    @Test
    fun aMonthThatNeedsSixWeeksGetsSixRows() {
        val rows = PhoneCalendar.monthRows(day("2026-08-10"), HouseholdWeekStart.Sunday)
        assertEquals(6, rows.size)
        assertEquals(day("2026-07-26"), rows.first().days.first().date)
        assertEquals(31, rows.first().weekNumber)
    }

    @Test
    fun daysOutsideTheMonthAreMarked() {
        val first = PhoneCalendar.monthRows(day("2026-09-15"), HouseholdWeekStart.Monday)[0].days
        assertFalse(first[0].inMonth)
        assertEquals(day("2026-09-01"), first[1].date)
        assertTrue(first[1].inMonth)
        assertEquals(1, first[1].day)
    }

    @Test
    fun theWeekNumberFollowsIsoAcrossTheYearBoundary() {
        val rows = PhoneCalendar.monthRows(day("2027-01-12"), HouseholdWeekStart.Monday)
        assertEquals(day("2026-12-28"), rows.first().days.first().date)
        assertEquals(53, rows.first().weekNumber)
        assertEquals(1, rows[1].weekNumber)
    }
}

/** A run of whole weeks from a given first day — Horizon's next four weeks. */
class PhoneCalendarWeekRowsTest {
    @Test
    fun drawsTheWeeksAskedForFromTheGivenDay() {
        val rows = PhoneCalendar.weekRows(day("2026-09-06"), 4, HouseholdWeekStart.Sunday)
        assertEquals(4, rows.size)
        assertEquals(day("2026-09-06"), rows.first().days.first().date)
        assertEquals(day("2026-10-03"), rows.last().days.last().date)
        assertEquals(listOf(37, 38, 39, 40), rows.map { it.weekNumber })
    }

    @Test
    fun nothingInAWindowIsOutsideIt() {
        val rows = PhoneCalendar.weekRows(day("2026-09-27"), 4, HouseholdWeekStart.Sunday)
        assertTrue(rows.all { r -> r.days.all { it.inMonth } })
        assertEquals(day("2026-10-01"), rows.first().days[4].date)
        assertEquals(1, rows.first().days[4].day)
    }

    @Test
    fun crossesTheYearBoundary() {
        val rows = PhoneCalendar.weekRows(day("2026-12-28"), 4, HouseholdWeekStart.Monday)
        assertEquals(53, rows.first().weekNumber)
        assertEquals(day("2027-01-04"), rows[1].days.first().date)
        assertEquals(day("2027-01-24"), rows.last().days.last().date)
    }

    @Test
    fun anUnreadableStartDrawsNothing() {
        assertTrue(PhoneCalendar.weekRows("not-a-date", 4, HouseholdWeekStart.Sunday).isEmpty())
    }
}

class PhoneCalendarCellChipsTest {
    @Test
    fun aTallCellShowsFourTitlesThenMore() {
        val c = PhoneCalendar.cellChips(eventCount = 7, countdownCount = 0, rowHeight = 128f)
        assertEquals(4, c.shown)
        assertEquals(3, c.more)
        assertFalse(c.showsCountdown)
    }

    @Test
    fun aCountdownCostsOneTitleSlot() {
        val c = PhoneCalendar.cellChips(eventCount = 7, countdownCount = 1, rowHeight = 128f)
        assertTrue(c.showsCountdown)
        assertEquals(3, c.shown)
        assertEquals(4, c.more)
    }

    @Test
    fun onlyOneCountdownShowsAndTheRestCountTowardMore() {
        val c = PhoneCalendar.cellChips(eventCount = 2, countdownCount = 3, rowHeight = 128f)
        assertTrue(c.showsCountdown)
        assertEquals(2, c.shown)
        assertEquals(2, c.more)
    }

    @Test
    fun aQuietDayShowsEverythingWithNoMoreLine() {
        val c = PhoneCalendar.cellChips(eventCount = 2, countdownCount = 0, rowHeight = 128f)
        assertEquals(2, c.shown)
        assertEquals(0, c.more)
    }

    @Test
    fun aShorterSixRowCellHoldsFewerTitles() {
        val c = PhoneCalendar.cellChips(eventCount = 7, countdownCount = 0, rowHeight = 100f)
        assertTrue(c.shown < 4)
        assertEquals(7, c.shown + c.more)
    }

    @Test
    fun aCellTooShortForAnyChipStillCountsEverything() {
        val c = PhoneCalendar.cellChips(eventCount = 3, countdownCount = 2, rowHeight = 30f)
        assertEquals(0, c.shown)
        assertFalse(c.showsCountdown)
        assertEquals(5, c.more)
    }
}

class PhoneCalendarDayHoursTest {
    @Test
    fun anOrdinaryDayRunsSevenToEight() {
        assertEquals(7..20, PhoneCalendar.dayHours(listOf(timed("a", "2026-09-14 09:00")), ny))
    }

    @Test
    fun anEmptyDayRunsSevenToEight() {
        assertEquals(7..20, PhoneCalendar.dayHours(emptyList(), ny))
    }

    @Test
    fun anEarlyEventPullsTheStartBack() {
        assertEquals(5..20, PhoneCalendar.dayHours(listOf(timed("a", "2026-09-14 05:30")), ny))
    }

    @Test
    fun aLateEventPushesTheEndOutToTheHourItFinishesIn() {
        assertEquals(7..23, PhoneCalendar.dayHours(listOf(timed("a", "2026-09-14 21:00", minutes = 75)), ny))
    }

    @Test
    fun theDayOpensAnHourBeforeTheFirstTimedEvent() {
        val events = listOf(timed("late", "2026-09-14 16:00"), timed("early", "2026-09-14 11:30"))
        assertEquals(10, PhoneCalendar.openingHour(events, 7..20, ny))
    }

    @Test
    fun anEmptyDayOpensAtTheTopOfTheGrid() {
        assertEquals(7, PhoneCalendar.openingHour(emptyList(), 7..20, ny))
    }

    @Test
    fun theOpeningHourStaysInsideTheGrid() {
        assertEquals(5, PhoneCalendar.openingHour(listOf(timed("dawn", "2026-09-14 05:00")), 5..20, ny))
        assertEquals(21, PhoneCalendar.openingHour(listOf(timed("night", "2026-09-14 22:00")), 7..23, ny))
    }

    @Test
    fun anEventRunningPastMidnightStopsTheGridAtMidnight() {
        assertEquals(7..24, PhoneCalendar.dayHours(listOf(timed("a", "2026-09-14 22:00", minutes = 240)), ny))
    }
}

class PhoneCalendarWeekTest {
    @Test
    fun theWeekIsCutOnTheHouseholdsFirstDay() {
        assertEquals(
            listOf("2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20")
                .map(::day),
            PhoneCalendar.weekDays(day("2026-09-16"), HouseholdWeekStart.Monday),
        )
        assertEquals(day("2026-09-13"), PhoneCalendar.weekDays(day("2026-09-16"), HouseholdWeekStart.Sunday).first())
    }

    @Test
    fun theWeekTitleNamesTheMonthOnceUnlessTheWeekCrossesIntoTheNext() {
        val us = Locale.US
        assertEquals(
            "Sep 14 – 20",
            PhoneCalendar.weekTitle(PhoneCalendar.weekDays(day("2026-09-16"), HouseholdWeekStart.Monday), us),
        )
        assertEquals(
            "Sep 28 – Oct 4",
            PhoneCalendar.weekTitle(PhoneCalendar.weekDays(day("2026-09-30"), HouseholdWeekStart.Monday), us),
        )
    }

    @Test
    fun cardTimesAreCompact() {
        fun at(s: String) = LocalDateTime.parse(s).atZone(ny).toInstant()
        assertEquals("9:30a", PhoneCalendar.shortTime(at("2026-09-14T09:30"), ny))
        assertEquals("12p", PhoneCalendar.shortTime(at("2026-09-14T12:00"), ny))
        assertEquals("12:05a", PhoneCalendar.shortTime(at("2026-09-14T00:05"), ny))
    }

    @Test
    fun allDayEventsLeadThenTimedOnesByStart() {
        val birthday = row(SyncedEvent(id = "bday", householdId = "h", title = "bday", startsAt = "2026-09-14", allDay = true))
        val ordered = PhoneCalendar.displayOrder(
            listOf(timed("late", "2026-09-14 15:00"), birthday, timed("early", "2026-09-14 08:00")),
        )
        assertEquals(listOf("bday", "early", "late"), ordered.map { it.id })
    }

    @Test
    fun steppingAWeekMovesTheSelectedDaySevenDays() {
        assertEquals(day("2026-10-07"), PhoneCalendar.shift(day("2026-09-30"), 7))
        assertEquals(day("2026-08-27"), PhoneCalendar.shift(day("2026-09-03"), -7))
    }
}

class PhoneCalendarWeekPagingTest {
    @Test
    fun theStripPagesThroughTheRailsWholeWeeks() {
        val days = PhoneCalendar.railDays(day("2026-09-16"), weeksEachSide = 1, firstDay = HouseholdWeekStart.Monday)
        assertEquals(listOf("2026-09-07", "2026-09-14", "2026-09-21").map(::day), PhoneCalendar.railWeeks(days))
    }

    @Test
    fun stripWeeksCrossMonthsAndYears() {
        val days = PhoneCalendar.railDays(day("2026-12-31"), weeksEachSide = 1, firstDay = HouseholdWeekStart.Sunday)
        assertEquals(listOf("2026-12-20", "2026-12-27", "2027-01-03").map(::day), PhoneCalendar.railWeeks(days))
    }

    @Test
    fun theRailRunsWholeWeeksEitherSideOfTheSelectedDay() {
        val days = PhoneCalendar.railDays(day("2026-09-16"), weeksEachSide = 2, firstDay = HouseholdWeekStart.Monday)
        assertEquals(35, days.size)
        assertEquals(day("2026-08-31"), days.first())
        assertEquals(day("2026-10-04"), days.last())
        assertTrue(day("2026-09-16") in days)
    }

    @Test
    fun theRailCrossesDaylightSavingWithoutSkippingOrRepeatingADay() {
        val days = PhoneCalendar.railDays(day("2026-11-01"), weeksEachSide = 1, firstDay = HouseholdWeekStart.Sunday)
        assertEquals(days.size, days.toSet().size)
        assertTrue(day("2026-11-01") in days && day("2026-11-02") in days)
    }

    @Test
    fun theRailRecentersOnlyNearItsEnds() {
        val days = PhoneCalendar.railDays(day("2026-09-16"), weeksEachSide = 4, firstDay = HouseholdWeekStart.Monday)
        assertFalse(PhoneCalendar.railNeedsRecenter(day("2026-09-16"), days))
        assertTrue(PhoneCalendar.railNeedsRecenter(days[3], days))
        assertTrue(PhoneCalendar.railNeedsRecenter(days[days.size - 2], days))
        assertTrue(PhoneCalendar.railNeedsRecenter(day("2027-06-01"), days))
    }
}

class PhoneCalendarMealEventTest {
    private fun event(title: String, origin: String?, at: String = "2026-09-14 18:00"): EventRow =
        row(timedEvent(title, at, origin = origin))

    @Test
    fun mealPlanAndThawEventsAreRecognisedByOrigin() {
        assertEquals(PhoneCalendar.EventKind.Meal, PhoneCalendar.EventKind.of("meal_plan"))
        assertEquals(PhoneCalendar.EventKind.Prep, PhoneCalendar.EventKind.of("meal_prep"))
        assertEquals(PhoneCalendar.EventKind.Regular, PhoneCalendar.EventKind.of(null))
        assertEquals(PhoneCalendar.EventKind.Regular, PhoneCalendar.EventKind.of("google"))
    }

    @Test
    fun theFooterNamesTonightsPlannedDinner() {
        val events = listOf(
            event("🧊 Thaw for Dinner · Salmon", "meal_prep", at = "2026-09-14 08:00"),
            event("🍽️ Dinner · Sheet-pan salmon", "meal_plan"),
        )
        assertEquals("Dinner · Sheet-pan salmon", PhoneCalendar.dinnerFooter(events))
    }

    @Test
    fun withOnlyAThawReminderTheFooterSaysWhatToThaw() {
        val events = listOf(event("🧊 Thaw for Dinner · Chicken thighs", "meal_prep", at = "2026-09-14 08:00"))
        assertEquals("Thaw · Chicken thighs", PhoneCalendar.dinnerFooter(events))
    }

    @Test
    fun lunchIsNotDinnerAndAManualDinnerIsNotAPlannedMeal() {
        val events = listOf(
            event("🍽️ Lunch · Tacos", "meal_plan", at = "2026-09-14 12:00"),
            event("Dinner at Monk's", null),
        )
        assertNull(PhoneCalendar.dinnerFooter(events))
    }
}

class PhoneCalendarDaySwipeTest {
    @Test
    fun aSidewaysFlickStepsTheDay() {
        assertEquals(1, PhoneCalendar.daySwipeStep(startX = 200f, dx = -80f, dy = 5f))
        assertEquals(-1, PhoneCalendar.daySwipeStep(startX = 200f, dx = 80f, dy = 5f))
    }

    @Test
    fun aShortOrMostlyVerticalDragDoesNothing() {
        assertNull(PhoneCalendar.daySwipeStep(startX = 200f, dx = 30f, dy = 0f))
        assertNull(PhoneCalendar.daySwipeStep(startX = 200f, dx = 80f, dy = 70f))
    }

    @Test
    fun aDragFromTheLeadingEdgeIsTheBackSwipeNotAPreviousDay() {
        assertNull(PhoneCalendar.daySwipeStep(startX = 12f, dx = 150f, dy = 0f))
    }
}

class PhoneCalendarFocusDayTest {
    @Test
    fun aSelectedDayInsideTheMonthIsKept() {
        assertEquals(
            day("2026-11-20"),
            PhoneCalendar.focusDay(selected = day("2026-11-20"), inMonthOf = day("2026-11-03"), today = day("2026-09-14")),
        )
    }

    @Test
    fun todayWinsWhenTheMonthHoldsItButNotTheSelection() {
        assertEquals(
            day("2026-09-14"),
            PhoneCalendar.focusDay(selected = day("2026-10-05"), inMonthOf = day("2026-09-01"), today = day("2026-09-14")),
        )
    }

    @Test
    fun otherwiseTheMonthOpensOnItsFirstDay() {
        assertEquals(
            day("2026-11-01"),
            PhoneCalendar.focusDay(selected = day("2026-09-14"), inMonthOf = day("2026-11-17"), today = day("2026-09-14")),
        )
    }
}

class TimeLanesTest {
    @Test
    fun overlappingEventsSplitIntoLanesAndReuseAFreedOne() {
        val placed = TimeLanes.place(
            listOf(
                timed("a", "2026-09-14 09:00"),
                timed("b", "2026-09-14 09:30"),
                timed("c", "2026-09-14 10:00"),
                timed("d", "2026-09-14 13:00"),
            ),
        )
        val byId = placed.associateBy { it.row.id }
        assertEquals(0, byId["a"]?.lane)
        assertEquals(1, byId["b"]?.lane)
        assertEquals(0, byId["c"]?.lane)
        assertEquals(2, byId["a"]?.lanes)
        assertEquals(2, byId["c"]?.lanes)
        assertEquals(0, byId["d"]?.lane)
        assertEquals(1, byId["d"]?.lanes)
    }

    @Test
    fun anEventWithNoEndOrAShortOneStillTakesUpSpace() {
        val placed = TimeLanes.place(
            listOf(
                timed("quick", "2026-09-14 09:00", minutes = 5),
                timed("afterQuick", "2026-09-14 09:10"),
                timed("open", "2026-09-14 11:00", minutes = null),
                timed("afterOpen", "2026-09-14 11:45"),
            ),
        )
        val byId = placed.associateBy { it.row.id }
        assertEquals(1, byId["afterQuick"]?.lane)
        assertEquals(1, byId["afterOpen"]?.lane)
    }

    @Test
    fun eventsArriveInAnyOrder() {
        val placed = TimeLanes.place(listOf(timed("late", "2026-09-14 11:00"), timed("early", "2026-09-14 08:00")))
        assertEquals(listOf("early", "late"), placed.map { it.row.id })
    }
}

// Multi-day all-day events draw as one bar across a month row (like Google's month view)
// instead of a separate chip in every day they cover.
class PhoneMonthSpanTest {
    private val week = listOf(
        "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19",
    ).map(::day)

    @Test
    fun aTripDrawsOneBarAcrossItsDaysAndLeavesTheirChips() {
        val t = trip("hamptons", "2026-09-15", throughExclusive = "2026-09-18")
        val dinner = timedEvent("dinner", "2026-09-16 18:00")
        val spans = PhoneCalendar.weekSpans(week, rowsOf(t, dinner), maxLanes = 3)
        assertEquals(listOf("hamptons"), spans.bars.map { it.row.id })
        assertEquals(2, spans.bars.first().startCol)
        assertEquals(4, spans.bars.first().endCol)
        assertEquals(0, spans.bars.first().lane)
        assertEquals(1, spans.lanes)
        assertEquals(listOf("dinner"), spans.chipsByDay[day("2026-09-16")]?.map { it.id })
        assertTrue(spans.chipsByDay[day("2026-09-15")].orEmpty().isEmpty())
    }

    @Test
    fun aTripCrossingTheRowEdgeIsCutThereAndSaysSo() {
        val t = trip("camping", "2026-09-18", throughExclusive = "2026-09-23")
        val bar = PhoneCalendar.weekSpans(week, rowsOf(t), maxLanes = 3).bars.first()
        assertEquals(5, bar.startCol)
        assertEquals(6, bar.endCol)
        assertFalse(bar.continuesBefore)
        assertTrue(bar.continuesAfter)
    }

    @Test
    fun aTripThatStartedInAnEarlierRowSaysSo() {
        val t = trip("camping", "2026-09-10", throughExclusive = "2026-09-15")
        val bar = PhoneCalendar.weekSpans(week, rowsOf(t), maxLanes = 3).bars.first()
        assertEquals(0, bar.startCol)
        assertEquals(1, bar.endCol)
        assertTrue(bar.continuesBefore)
        assertFalse(bar.continuesAfter)
    }

    @Test
    fun overlappingTripsTakeSeparateLanesAndLaterOnesReuseAFreeLane() {
        val a = trip("a", "2026-09-14", throughExclusive = "2026-09-17")
        val b = trip("b", "2026-09-15", throughExclusive = "2026-09-19")
        val c = trip("c", "2026-09-17", throughExclusive = "2026-09-20")
        val spans = PhoneCalendar.weekSpans(week, rowsOf(a, b, c), maxLanes = 3)
        assertEquals(mapOf("a" to 0, "b" to 1, "c" to 0), spans.bars.associate { it.row.id to it.lane })
        assertEquals(2, spans.lanes)
    }

    @Test
    fun oneDayEventsStayChips() {
        val birthday = trip("birthday", "2026-09-16", throughExclusive = "2026-09-17")
        val spans = PhoneCalendar.weekSpans(week, rowsOf(birthday), maxLanes = 3)
        assertTrue(spans.bars.isEmpty())
        assertEquals(0, spans.lanes)
        assertEquals(listOf("birthday"), spans.chipsByDay[day("2026-09-16")]?.map { it.id })
    }

    @Test
    fun tripsPastTheLaneCapFallBackToChips() {
        val a = trip("a", "2026-09-14", throughExclusive = "2026-09-17")
        val b = trip("b", "2026-09-15", throughExclusive = "2026-09-17")
        val spans = PhoneCalendar.weekSpans(week, rowsOf(a, b), maxLanes = 1)
        assertEquals(listOf("a"), spans.bars.map { it.row.id })
        assertEquals(listOf("b"), spans.chipsByDay[day("2026-09-15")]?.map { it.id })
    }

    @Test
    fun aDayCellLeavesRoomForTheRowsBarLanes() {
        val c = PhoneCalendar.cellChips(eventCount = 3, countdownCount = 0, rowHeight = 200f, reservedSlots = 2)
        assertEquals(2, c.shown)
        assertEquals(1, c.more)
    }
}

// Bars over a month row: phone cells touch, tablet cells have a gap. A bar covers its columns
// and the gaps between them, inset from both ends.
class MonthSpanGeometryTest {
    @Test
    fun aPhoneBarCoversItsColumnsInsetFromBothEnds() {
        val g = PhoneCalendar.spanBarX(startCol = 2, endCol = 4, rowWidth = 350f, spacing = 0f, inset = 2f)
        assertEquals(102f, g.x)
        assertEquals(146f, g.width)
    }

    @Test
    fun aTabletBarAlsoCoversTheGapsBetweenItsCells() {
        val g = PhoneCalendar.spanBarX(startCol = 1, endCol = 3, rowWidth = 736f, spacing = 6f, inset = 2f)
        assertEquals(108f, g.x)
        assertEquals(308f, g.width)
    }

    @Test
    fun aCellWithBarsShowsFewerChipsAndCountsTheRest() {
        assertEquals(PhoneCalendar.ChipCap(3, 2), PhoneCalendar.cappedChips(eventCount = 5, cap = 3, reserved = 0))
        assertEquals(PhoneCalendar.ChipCap(1, 4), PhoneCalendar.cappedChips(eventCount = 5, cap = 3, reserved = 2))
        assertEquals(PhoneCalendar.ChipCap(1, 0), PhoneCalendar.cappedChips(eventCount = 1, cap = 3, reserved = 2))
        assertEquals(PhoneCalendar.ChipCap(0, 2), PhoneCalendar.cappedChips(eventCount = 2, cap = 3, reserved = 3))
    }
}

class HorizontalSwipeTest {
    @Test
    fun aLongMostlySidewaysFlickSteps() {
        assertEquals(1, HorizontalSwipe.step(dx = -60f, dy = 10f))
        assertEquals(-1, HorizontalSwipe.step(dx = 60f, dy = 10f))
        assertNull(HorizontalSwipe.step(dx = 40f, dy = 0f))
        assertNull(HorizontalSwipe.step(dx = 60f, dy = 50f))
    }
}
