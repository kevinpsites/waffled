package app.waffled.feature.pantry

import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Expiry + age derivation.
 *
 * "Today" is injected everywhere, so none of these are date-dependent flakes — a test
 * that silently changes meaning at midnight is worse than no test.
 */
class PantryExpiryTest {

    private val today = LocalDate.of(2026, 8, 21)

    // ---- parsing ------------------------------------------------------------------

    @Test
    fun `parses a yyyy-MM-dd date`() {
        assertEquals(LocalDate.of(2026, 7, 22), PantryExpiry.date("2026-07-22"))
    }

    @Test
    fun `null, blank and garbage parse to null rather than throwing`() {
        assertNull(PantryExpiry.date(null))
        assertNull(PantryExpiry.date("   "))
        assertNull(PantryExpiry.date("next Tuesday"))
        // A full ISO instant is NOT a best-by date; the column is date-only.
        assertNull(PantryExpiry.date("2026-07-22T10:00:00Z"))
    }

    @Test
    fun `string round-trips a date back to the wire format`() {
        assertEquals("2026-07-22", PantryExpiry.string(LocalDate.of(2026, 7, 22)))
    }

    @Test
    fun `shortLabel is the compact best-by form`() {
        assertEquals("Jul 22", PantryExpiry.shortLabel("2026-07-22"))
        assertNull(PantryExpiry.shortLabel(null))
    }

    // ---- days until / since --------------------------------------------------------

    @Test
    fun `daysUntil counts forward, is zero today and negative once past`() {
        assertEquals(3, PantryExpiry.daysUntil("2026-08-24", today))
        assertEquals(0, PantryExpiry.daysUntil("2026-08-21", today))
        assertEquals(-2, PantryExpiry.daysUntil("2026-08-19", today))
    }

    @Test
    fun `daysUntil of nothing is null, not zero — no date is not the same as due today`() {
        assertNull(PantryExpiry.daysUntil(null, today))
    }

    @Test
    fun `daysSince is the mirror of daysUntil`() {
        assertEquals(2, PantryExpiry.daysSince("2026-08-19", today))
        assertEquals(0, PantryExpiry.daysSince("2026-08-21", today))
        assertNull(PantryExpiry.daysSince(null, today))
    }

    // ---- the age label ---------------------------------------------------------------

    @Test
    fun `under a fortnight reads in days, and never as zero days`() {
        assertEquals("1d", PantryExpiry.ageLabel(0))
        assertEquals("1d", PantryExpiry.ageLabel(1))
        assertEquals("13d", PantryExpiry.ageLabel(13))
    }

    @Test
    fun `a negative day count clamps rather than reading as a future age`() {
        assertEquals("1d", PantryExpiry.ageLabel(-5))
    }

    @Test
    fun `a fortnight to about six weeks reads in weeks`() {
        assertEquals("2w", PantryExpiry.ageLabel(14))
        assertEquals("6w", PantryExpiry.ageLabel(45))
    }

    @Test
    fun `six weeks to a year reads in months`() {
        // 1.5 months (45.66 days) is the boundary; 46 days is over it.
        assertEquals("2 mo", PantryExpiry.ageLabel(46))
        assertEquals("6 mo", PantryExpiry.ageLabel(183))
        assertEquals("11 mo", PantryExpiry.ageLabel(334))
    }

    @Test
    fun `a year and over reads in years, with anything under about two as one`() {
        assertEquals("1 yr", PantryExpiry.ageLabel(366))
        assertEquals("1 yr", PantryExpiry.ageLabel(700))
        assertEquals("2 yr", PantryExpiry.ageLabel(730))
        assertEquals("3 yr", PantryExpiry.ageLabel(1096))
    }
}
