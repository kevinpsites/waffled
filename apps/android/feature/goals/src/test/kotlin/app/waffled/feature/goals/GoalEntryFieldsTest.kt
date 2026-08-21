package app.waffled.feature.goals

import java.util.Locale
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The log sheet's free-entry fields — ports of `AmountEntryTests`, `DurationEntryTests`
 * and `GoalLogChipsTests`.
 *
 * All three exist because the fields hold RAW TEXT while editing (so a cleared field can
 * stay empty rather than snapping back to the last value) and the logged number is
 * derived from that text. Get the derivation wrong and the sheet logs something the field
 * no longer shows.
 */
class GoalEntryFieldsTest {

    private val enUS = Locale.US
    private val deDE = Locale.GERMANY
    private val frFR = Locale.FRANCE

    // ---- AmountEntry -----------------------------------------------------------

    @Test
    fun dotDecimalsParse() {
        assertEquals(2.5, AmountEntry.value("2.5", enUS))
        assertEquals(2.0, AmountEntry.value("2", enUS))
        assertEquals(0.5, AmountEntry.value(".5", enUS))
    }

    @Test
    fun commaDecimalsParseUnderCommaLocales() {
        // The decimal pad types the LOCALE's separator; a naive parse would lock every
        // comma-decimal locale out of fractional amounts entirely.
        assertEquals(2.5, AmountEntry.value("2,5", deDE))
        assertEquals(0.25, AmountEntry.value("0,25", frFR))
        // A mid-edit trailing separator is a value, not garbage.
        assertEquals(2.0, AmountEntry.value("2,", deDE))
    }

    @Test
    fun dotStillParsesUnderACommaLocale() {
        // Hardware keyboards and pasted text can carry a dot on a comma locale.
        assertEquals(2.5, AmountEntry.value("2.5", deDE))
    }

    @Test
    fun emptyOrGarbageIsZeroRatherThanTheOldValue() {
        assertEquals(0.0, AmountEntry.value("", enUS))
        assertEquals(0.0, AmountEntry.value("  ", deDE))
        assertEquals(0.0, AmountEntry.value("abc", enUS))
    }

    @Test
    fun parseTellsNotANumberApartFromZero() {
        // `value` flattens both to 0, which suits the goal fields (either way the button
        // is disabled). `parse` is the rule underneath and keeps the two apart.
        assertNull(AmountEntry.parse("a pinch", enUS))
        assertNull(AmountEntry.parse("", enUS))
        assertNull(AmountEntry.parse("  ", deDE))
        assertEquals(0.0, AmountEntry.parse("0", enUS))
        assertEquals(0.5, AmountEntry.parse(".5", enUS))
        assertEquals(0.5, AmountEntry.parse("0,5", deDE))
        assertEquals(2.5, AmountEntry.parse("2.5", deDE))
    }

    // ---- DurationEntry ---------------------------------------------------------

    @Test
    fun emptyOrWhitespaceMeansZero() {
        assertEquals(0, DurationEntry.value(""))
        assertEquals(0, DurationEntry.value("   "))
    }

    @Test
    fun wholeNumbersParse() {
        assertEquals(5, DurationEntry.value("5"))
        assertEquals(7, DurationEntry.value("07"))
        assertEquals(12, DurationEntry.value(" 12 "))
        assertEquals(0, DurationEntry.value("0"))
    }

    @Test
    fun theCapClampsTheValue() {
        assertEquals(59, DurationEntry.value("75", cap = 59))
        assertEquals(59, DurationEntry.value("59", cap = 59))
        assertEquals(59, DurationEntry.value("60", cap = 59))
        assertEquals(8, DurationEntry.value("8", cap = 59))
    }

    @Test
    fun negativeAndUnparsableFallBackToZero() {
        assertEquals(0, DurationEntry.value("-3"))
        assertEquals(0, DurationEntry.value("abc"))
        assertEquals(0, DurationEntry.value("1.5"))
        assertEquals(0, DurationEntry.value("999999999999999999999999"), "an overflow is not a duration")
    }

    @Test
    fun normalisedTextIsTheCanonicalNumeral() {
        assertEquals("0", DurationEntry.normalized(""))
        assertEquals("7", DurationEntry.normalized("07"))
        assertEquals("59", DurationEntry.normalized("75", cap = 59))
        assertEquals("4", DurationEntry.normalized(" 4 "))
    }

    // ---- GoalLogChips ----------------------------------------------------------

    @Test
    fun timeGoalsOfferTheShortSessionChips() {
        assertEquals(
            listOf("20m", "30m", "1 hr", "1.5 hr"),
            GoalLogChips.chips(isHours = true, unit = "hours").map { it.label },
        )
    }

    @Test
    fun otherGoalsCountInTheirOwnUnit() {
        val chips = GoalLogChips.chips(isHours = false, unit = "books")
        assertEquals(listOf("1 books", "2 books", "3 books", "5 books"), chips.map { it.label })
        assertEquals(listOf(1.0, 2.0, 3.0, 5.0), chips.map { it.value })
        assertEquals(
            listOf("1", "2", "3", "5"),
            GoalLogChips.chips(isHours = false, unit = null).map { it.label },
        )
    }

    @Test
    fun twentyMinutesFillsInTwentyMinutes() {
        // The whole point: tapping 20m has to be the same as typing 0h 20m. Truncating
        // instead of rounding here is the classic way to end up logging 19.
        val chip = GoalLogChips.chips(isHours = true, unit = "hours").first()
        assertEquals(0 to 20, GoalLogChips.fields(chip.value))
    }

    @Test
    fun everyTimeChipRoundTripsThroughTheFields() {
        for (chip in GoalLogChips.chips(isHours = true, unit = "hours")) {
            val (hours, minutes) = GoalLogChips.fields(chip.value)
            assertTrue(
                GoalLogChips.isSelected(hours, minutes, chip.value),
                "${chip.label} does not read as selected after being tapped",
            )
        }
    }

    @Test
    fun aDifferentDurationDoesNotLightUpTheChip() {
        val twenty = GoalLogChips.chips(isHours = true, unit = "hours").first().value
        assertFalse(GoalLogChips.isSelected(0, 19, twenty))
        assertFalse(GoalLogChips.isSelected(0, 21, twenty))
        assertFalse(GoalLogChips.isSelected(1, 20, twenty))
    }

    @Test
    fun theChipValueMatchesTypedMinutesWithinTolerance() {
        // 20/60 is 0.3333… forever; the chip stores six decimals of it, and the gap
        // between the two is exactly what the tolerance has to absorb.
        assertEquals(0.333333, GoalLogChips.hoursForMinutes(20))
        assertTrue(abs(GoalLogChips.hoursForMinutes(20) - 20.0 / 60) < 1e-6)
        assertEquals(0.5, GoalLogChips.hoursForMinutes(30))
    }
}
