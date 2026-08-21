package app.waffled.feature.today

import app.waffled.core.sync.SyncedEvent
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Today's display strings.
 *
 * These live outside the composables on purpose: date math in a render path is one of the
 * two documented jank sources carried over from iOS, and a string rule with three branches
 * deserves a test rather than a screenshot.
 */
class TodayFormatTest {

    private val zone: ZoneId = ZoneId.of("America/Chicago")

    /** Pinned so the assertions below don't depend on the machine's locale. */
    private val us: Locale = Locale.US

    private fun at(hour: Int) = LocalDateTime.of(2026, 7, 16, hour, 30).atZone(zone).toInstant()

    // ---- greeting ---------------------------------------------------------------

    @Test
    fun theGreetingFollowsTheHouseholdClock() {
        assertEquals("Good morning", TodayFormat.greeting(at(5), zone))
        assertEquals("Good morning", TodayFormat.greeting(at(11), zone))
        assertEquals("Good afternoon", TodayFormat.greeting(at(12), zone))
        assertEquals("Good afternoon", TodayFormat.greeting(at(16), zone))
        assertEquals("Good evening", TodayFormat.greeting(at(17), zone))
        assertEquals("Good evening", TodayFormat.greeting(at(23), zone))
        assertEquals("Good evening", TodayFormat.greeting(at(4), zone))
    }

    /** The zone is the HOUSEHOLD's, not the device's — a travelling phone still reads home. */
    @Test
    fun theGreetingUsesTheHouseholdZoneNotTheDevice() {
        val instant = LocalDateTime.of(2026, 7, 16, 23, 0).atZone(ZoneId.of("America/Chicago")).toInstant()
        assertEquals("Good evening", TodayFormat.greeting(instant, ZoneId.of("America/Chicago")))
        // Same moment, six hours east: already tomorrow morning there.
        assertEquals("Good morning", TodayFormat.greeting(instant, ZoneId.of("Europe/Berlin")))
    }

    @Test
    fun theDateLineReadsAsWeekdayMonthDay() {
        assertEquals("Thursday, Jul 16", TodayFormat.dateLine(at(9), zone, us))
    }

    // ---- tonight's subtitle -----------------------------------------------------

    private fun meal(
        eatingOut: Boolean = false,
        dishCount: Int = 0,
        cookTimeMinutes: Int? = null,
        servings: Int? = null,
    ) = TonightMeal(
        title = "x", emoji = "🍽️", cookTimeMinutes = cookTimeMinutes, servings = servings,
        eatingOut = eatingOut, hasRecipe = false, recipeId = null, category = null,
        mealId = null, dishCount = dishCount,
    )

    @Test
    fun anEatingOutNightSaysSo() {
        assertEquals("No cooking tonight 🎉", TodayFormat.mealSubtitle(meal(eatingOut = true)))
    }

    /** A plate carries no single cook time, so without the dish count it reads as a bare name. */
    @Test
    fun aPlateCountsItsDishes() {
        assertEquals("3 dishes", TodayFormat.mealSubtitle(meal(dishCount = 3)))
        assertEquals("1 dish", TodayFormat.mealSubtitle(meal(dishCount = 1)))
    }

    @Test
    fun aRecipeNightJoinsTimeAndServings() {
        assertEquals(
            "🕐 30 min · serves 4",
            TodayFormat.mealSubtitle(meal(cookTimeMinutes = 30, servings = 4)),
        )
    }

    @Test
    fun aBareNightHasNoSubtitle() {
        assertNull(TodayFormat.mealSubtitle(meal()))
    }

    // ---- counts -----------------------------------------------------------------

    @Test
    fun countsPluralise() {
        assertEquals("1 event", TodayFormat.eventCount(1))
        assertEquals("0 events", TodayFormat.eventCount(0))
        assertEquals("4 events", TodayFormat.eventCount(4))
        assertEquals("item to buy", TodayFormat.groceryUnit(1))
        assertEquals("items to buy", TodayFormat.groceryUnit(0))
        assertEquals("items to buy", TodayFormat.groceryUnit(7))
    }

    // ---- agenda rows ------------------------------------------------------------

    private fun event(startsAt: String?, allDay: Boolean = false) = SyncedEvent(
        id = "e", householdId = "h", title = "Soccer", startsAt = startsAt, allDay = allDay,
    )

    @Test
    fun anAllDayEventSaysAllDay() {
        assertEquals("All day", TodayFormat.eventTime(event("2026-07-16T18:00:00Z", allDay = true), zone, us))
    }

    @Test
    fun aTimedEventShowsItsLocalStart() {
        // 18:00 UTC is 1 PM in Chicago (CDT).
        assertEquals("1:00 PM", TodayFormat.eventTime(event("2026-07-16T18:00:00Z"), zone, us))
    }

    /** A row with no parseable start must render blank, not crash or say "midnight". */
    @Test
    fun anUnparseableStartRendersBlank() {
        assertEquals("", TodayFormat.eventTime(event(null), zone, us))
        assertEquals("", TodayFormat.eventTime(event("not-a-date"), zone, us))
    }

    // ---- the agenda lookup ------------------------------------------------------

    /**
     * Today's rows are an O(1) read out of the map `SyncManager` already bucketed — the
     * screen must never re-filter or re-bucket in a render path.
     */
    @Test
    fun todaysEventsAreALookupNotAFilter() {
        val today = LocalDate.of(2026, 7, 16)
        val byDay = mapOf(
            today.minusDays(1) to listOf(event("2026-07-15T18:00:00Z")),
            today to listOf(event("2026-07-16T18:00:00Z"), event("2026-07-16T20:00:00Z")),
        )
        assertEquals(2, TodayFormat.eventsOn(byDay, today).size)
        assertEquals(0, TodayFormat.eventsOn(byDay, today.plusDays(1)).size)
    }
}
