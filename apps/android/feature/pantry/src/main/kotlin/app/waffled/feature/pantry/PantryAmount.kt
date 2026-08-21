package app.waffled.feature.pantry

import java.text.DecimalFormatSymbols
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Reading and writing a pantry amount.
 *
 * A pantry amount is **free text** ("2", "0.5", "a pinch") that the server ALSO parses
 * numerically, for the scan count-up and the cook decrement. Two rules fall out of that:
 *
 *  1. anything numeric must go out **dot-decimal** — a comma-decimal keyboard types
 *     "0,5", which reads as NaN on the far side and quietly becomes 1;
 *  2. anything that genuinely isn't a number must pass through exactly as typed.
 *
 * ⚠️ This duplicates the parse rule iOS keeps in `Features/Goals/AmountEntry.swift`,
 * which on Android belongs to the (parallel) Goals module. Cross-feature dependencies
 * aren't allowed and `core:model` is frozen, so it is reimplemented here — reported as a
 * `core:model` candidate for whoever unfreezes it.
 */
object PantryAmount {

    /**
     * Format a number back to a tidy string: "2", "1.5" — never "2.0", never a
     * locale's comma.
     */
    fun format(value: Double): String {
        // Tolerant whole-number test: stepping 0.1 six times leaves float noise that an
        // exact `==` would report as a fraction, printing "0.6000000000000001".
        if (abs(value - value.roundToLong()) < 1e-9) return value.roundToLong().toString()
        val rounded = (value * 100).roundToInt() / 100.0
        // `toString` on a Double is locale-independent in Kotlin/Java, which is exactly
        // what the wire needs; strip a trailing ".0" the rounding can reintroduce.
        val text = rounded.toString()
        return if (text.endsWith(".0")) text.dropLast(2) else text
    }

    /**
     * Parse a typed amount, or null when it isn't a number at all.
     *
     * Falls back to the device locale's decimal separator, because the decimal keypad
     * types that separator and a bare `toDouble()` rejects it.
     */
    fun parse(text: String, locale: Locale = Locale.getDefault()): Double? {
        val t = text.trim()
        if (t.isEmpty()) return null
        t.toDoubleOrNull()?.let { return it }
        val separator = DecimalFormatSymbols.getInstance(locale).decimalSeparator
        if (separator != '.') return t.replace(separator, '.').toDoubleOrNull()
        return null
    }

    /** Empty or free text reads as 0 — never as a stale previous amount. */
    fun value(text: String, locale: Locale = Locale.getDefault()): Double =
        parse(text, locale) ?: 0.0

    /**
     * What to put on the wire: a number normalised dot-decimal, or the text exactly as
     * typed when it isn't one.
     */
    fun canonical(text: String, locale: Locale = Locale.getDefault()): String {
        val t = text.trim()
        val n = parse(t, locale) ?: return t
        return format(n)
    }

    /**
     * Bump a typed amount by whole units without knocking a fraction off its grid
     * (0.5 + 1 = 1.5) or going negative.
     */
    fun stepped(text: String, delta: Double, locale: Locale = Locale.getDefault()): String =
        format(max(0.0, value(text, locale) + delta))

    /** True when [text] reads as a number at all — drives the ± stepper's usefulness. */
    fun isNumeric(text: String, locale: Locale = Locale.getDefault()): Boolean =
        parse(text, locale) != null
}
