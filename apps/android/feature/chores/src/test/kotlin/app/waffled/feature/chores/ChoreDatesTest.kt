package app.waffled.feature.chores

import org.junit.Test
import java.time.LocalDate
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertNull

/**
 * The day stepper's pure date helpers — the twin of iOS `ChoreDates`.
 *
 * Every function takes "today" explicitly so the tests are not clock-dependent (the iOS
 * original reads `Date()` inside, which is only testable by luck).
 */
class ChoreDatesTest {

    private val today = LocalDate.of(2026, 8, 21) // a Friday

    /**
     * Pin the locale in the assertions. Month/weekday names and the AM/PM marker are
     * locale-dependent, so a test that leaned on the JVM default would pass here and
     * fail on a French CI box.
     */
    private val us = Locale.US

    @Test
    fun `shift moves the day and keeps the wire format`() {
        assertEquals("2026-08-22", ChoreDates.shift("2026-08-21", 1))
        assertEquals("2026-08-20", ChoreDates.shift("2026-08-21", -1))
        assertEquals("2026-09-01", ChoreDates.shift("2026-08-31", 1))
    }

    @Test
    fun `shift returns the input unchanged when it cannot be parsed`() {
        assertEquals("nonsense", ChoreDates.shift("nonsense", 1))
    }

    @Test
    fun `meta names today tomorrow and yesterday`() {
        assertEquals("Today", ChoreDates.meta("2026-08-21", today, us).relative)
        assertEquals("Tomorrow", ChoreDates.meta("2026-08-22", today, us).relative)
        assertEquals("Yesterday", ChoreDates.meta("2026-08-20", today, us).relative)
    }

    @Test
    fun `meta counts days for anything further out`() {
        assertEquals("In 3 days", ChoreDates.meta("2026-08-24", today, us).relative)
        assertEquals("4 days ago", ChoreDates.meta("2026-08-17", today, us).relative)
    }

    @Test
    fun `meta flags only the current day as today`() {
        assertEquals(true, ChoreDates.meta("2026-08-21", today, us).isToday)
        assertEquals(false, ChoreDates.meta("2026-08-22", today, us).isToday)
    }

    @Test
    fun `meta full label spells the weekday and date`() {
        // "EEEE, MMM d" — 2026-08-21 is a Friday.
        assertEquals("Friday, Aug 21", ChoreDates.meta("2026-08-21", today, us).full)
    }

    @Test
    fun `overdue label only fires when the due day is before the day being viewed`() {
        assertNull(ChoreDates.overdueLabel(dueOn = "2026-08-21", viewing = "2026-08-21", locale = us))
        assertNull(ChoreDates.overdueLabel(dueOn = "2026-08-22", viewing = "2026-08-21", locale = us))
        assertNull(ChoreDates.overdueLabel(dueOn = null, viewing = "2026-08-21", locale = us))
    }

    @Test
    fun `overdue label says yesterday then a weekday then a date`() {
        assertEquals("since yesterday", ChoreDates.overdueLabel("2026-08-20", "2026-08-21", us))
        // 2026-08-18 is a Tuesday, three days back — inside the one-week window.
        assertEquals("since Tue", ChoreDates.overdueLabel("2026-08-18", "2026-08-21", us))
        // Eight days back falls outside the week window and gets a calendar date.
        assertEquals("since Aug 13", ChoreDates.overdueLabel("2026-08-13", "2026-08-21", us))
    }

    @Test
    fun `upcoming label only fires for a future due day`() {
        assertNull(ChoreDates.upcomingLabel(dueOn = "2026-08-21", viewing = "2026-08-21", locale = us))
        assertNull(ChoreDates.upcomingLabel(dueOn = "2026-08-20", viewing = "2026-08-21", locale = us))
        assertNull(ChoreDates.upcomingLabel(dueOn = null, viewing = "2026-08-21", locale = us))
    }

    @Test
    fun `upcoming label says tomorrow then a weekday then a date`() {
        assertEquals("due tomorrow", ChoreDates.upcomingLabel("2026-08-22", "2026-08-21", us))
        // 2026-08-25 is a Tuesday, four days ahead.
        assertEquals("due Tue", ChoreDates.upcomingLabel("2026-08-25", "2026-08-21", us))
        assertEquals("due Aug 30", ChoreDates.upcomingLabel("2026-08-30", "2026-08-21", us))
    }

    @Test
    fun `time label renders a stored 24h time in friendly form`() {
        // Asserted by parts: recent JDKs render the en_US AM/PM separator as a narrow
        // no-break space, so an exact-string match would be a JDK-version trap.
        val afternoon = ChoreDates.timeLabel("16:30", us).orEmpty()
        assertTrue(afternoon.startsWith("4:30"), afternoon)
        assertTrue(afternoon.endsWith("PM"), afternoon)

        val morning = ChoreDates.timeLabel("07:05", us).orEmpty()
        assertTrue(morning.startsWith("7:05"), morning)
        assertTrue(morning.endsWith("AM"), morning)
    }

    @Test
    fun `time label is null for an absent or unparseable time`() {
        assertNull(ChoreDates.timeLabel(null, us))
        assertNull(ChoreDates.timeLabel("", us))
        assertNull(ChoreDates.timeLabel("not a time", us))
    }
}
