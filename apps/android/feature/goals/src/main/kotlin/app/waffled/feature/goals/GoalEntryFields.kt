package app.waffled.feature.goals

import java.text.DecimalFormatSymbols
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * The parse rules behind the goal-log free-entry fields.
 *
 * All three types here exist for the same reason: the fields hold RAW TEXT while editing,
 * so a cleared field can stay empty instead of snapping back to the last value, and the
 * number actually logged is DERIVED from that text. Keeping the derivation pure is what
 * stops the sheet logging something the field no longer shows.
 */

/**
 * Locale-aware parsing for the *amount* field.
 *
 * The decimal keyboard types the locale's own separator — "2,5" on a German keyboard —
 * which a bare `toDouble()` rejects. Since an unparsable amount is 0, and 0 disables
 * Log/Save, a naive parse would hard-lock every comma-decimal locale out of fractional
 * amounts. Empty or garbage is 0, never the stale previous amount.
 */
object AmountEntry {

    /**
     * The single rule for reading a typed amount. Null means "not a number at all",
     * which the goal fields don't care about but a free-text amount elsewhere would.
     */
    fun parse(text: String, locale: Locale = Locale.getDefault()): Double? {
        val t = text.trim()
        if (t.isEmpty()) return null
        t.toDoubleOrNull()?.let { return it } // "2.5", "2", ".5"

        // Fall back to the locale's decimal separator ("2,5" -> "2.5", "2," -> "2.").
        val separator = DecimalFormatSymbols.getInstance(locale).decimalSeparator
        if (separator != '.') {
            return t.replace(separator, '.').toDoubleOrNull()
        }
        return null
    }

    /** Empty or garbage is 0, which disables Log/Save. See the type comment. */
    fun value(text: String, locale: Locale = Locale.getDefault()): Double = parse(text, locale) ?: 0.0
}

/**
 * The whole-number rule for the hours / minutes fields.
 *
 * Maps the transient text to the value actually logged (empty or unparsable = 0, floored
 * at 0, clamped to an optional cap — minutes use 59) and produces the canonical numeral
 * the field is rewritten to once editing ends.
 */
object DurationEntry {

    /** Empty or garbage → 0, negatives floored to 0, capped at [cap] when given. */
    fun value(text: String, cap: Int? = null): Int {
        val raw = text.trim().toIntOrNull() ?: 0
        val floored = maxOf(0, raw)
        return if (cap == null) floored else minOf(cap, floored)
    }

    /** The canonical text after editing ends: "" → "0", "07" → "7", over-cap → the cap. */
    fun normalized(text: String, cap: Int? = null): String = value(text, cap).toString()
}

/**
 * The quick-amount chips under a goal's log field.
 *
 * Pulled out of the sheet so the one non-obvious value in it can be tested: the 20m chip
 * is 1/3 rounded to SIX decimals specifically to match what the hours+minutes fields
 * compute for the same duration. Get that rounding wrong on either side and the chip
 * quietly stops reading as selected, or logs 19 minutes instead of 20.
 */
object GoalLogChips {

    data class Chip(val label: String, val value: Double)

    /**
     * [isHours] marks a time goal (hours/minutes entry); otherwise the chips are plain
     * counts in the goal's own unit.
     */
    fun chips(isHours: Boolean, unit: String?): List<Chip> {
        if (isHours) {
            // Short sessions are the ones people log by tapping; a two-hour block is rare
            // enough to type, and 20 minutes is the one that kept needing the keypad.
            return listOf(
                Chip("20m", hoursForMinutes(20)),
                Chip("30m", 0.5),
                Chip("1 hr", 1.0),
                Chip("1.5 hr", 1.5),
            )
        }
        val suffix = unit?.let { " $it" }.orEmpty()
        return listOf(1, 2, 3, 5).map { Chip("$it$suffix", it.toDouble()) }
    }

    /**
     * Minutes as a fraction of an hour, at the same six decimals the hours+minutes fields
     * round to — so a chip's value and a typed duration compare equal.
     */
    fun hoursForMinutes(minutes: Int): Double = ((minutes / 60.0) * 1e6).roundToLong() / 1e6

    /**
     * The hours + minutes a chip fills in when tapped. ROUNDS rather than truncates: 20m
     * arrives as 0.333333, and truncating `0.333333 * 60` gives 19.
     */
    fun fields(value: Double): Pair<Int, Int> {
        val hours = value.toInt()
        return hours to ((value - hours) * 60).roundToInt()
    }

    /**
     * Whether what's typed reads as this chip. The tolerance has to be looser than the
     * gap the chip's own six-decimal rounding leaves behind (20/60 vs 0.333333).
     */
    fun isSelected(hours: Int, minutes: Int, chip: Double): Boolean =
        abs((hours + minutes / 60.0) - chip) < 1e-6
}
