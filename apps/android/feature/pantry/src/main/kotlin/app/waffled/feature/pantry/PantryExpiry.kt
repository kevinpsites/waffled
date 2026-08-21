package app.waffled.feature.pantry

import app.waffled.core.model.WaffledDates
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Best-by and item-age derivation.
 *
 * ⚠️ **Nothing in here belongs in a render, sort or filter hot path.** On iOS, calling
 * `startOfDay` inside the expiring comparator janked hard on every search keystroke; the
 * fix — carried over here — is that `PantryModel` calls these ONCE per load and stores
 * the answers on `PantryRow`, so the list only ever reads an `Int?`.
 *
 * "Today" is a parameter rather than a call to the clock, so the derivation is testable
 * without the result changing meaning at midnight.
 */
object PantryExpiry {

    /** Average days per month, matching the web/iOS `ageLabel` arithmetic exactly. */
    private const val DAYS_PER_MONTH = 30.44

    /** The wire format for a best-by / added-on date. */
    private val WIRE: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd", Locale.US)

    /**
     * Parse a `yyyy-MM-dd` value, or null if there isn't one.
     *
     * Deliberately strict about the shape: these columns are date-only, and quietly
     * accepting a full instant would let a timezone shift slide a best-by onto the
     * adjacent day. Cached formatters come from [WaffledDates] where a *display* format
     * is needed — see [shortLabel].
     */
    fun date(value: String?): LocalDate? {
        val raw = value?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return runCatching { LocalDate.parse(raw, WIRE) }.getOrNull()
    }

    /** Format a date back to the wire form. */
    fun string(date: LocalDate): String = date.format(WIRE)

    /**
     * A "best by Jul 22" style short label.
     *
     * Formatting goes through [WaffledDates.formatter], whose cache is keyed on
     * pattern + zone + locale — building a `DateTimeFormatter` per row is the other half
     * of the documented performance trap.
     */
    fun shortLabel(value: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
        val day = date(value) ?: return null
        return WaffledDates.formatter("MMM d", zone).format(day)
    }

    /** The full "Jul 22, 2026" form, for a field showing a chosen day. */
    fun shortLabelFull(date: LocalDate, zone: ZoneId = ZoneId.systemDefault()): String =
        WaffledDates.formatter("MMM d, yyyy", zone).format(date)

    /** Days from [today] to a `yyyy-MM-dd` date (negative once past), or null. */
    fun daysUntil(value: String?, today: LocalDate): Int? {
        val day = date(value) ?: return null
        return ChronoUnit.DAYS.between(today, day).toInt()
    }

    /** Days since a `yyyy-MM-dd` date (positive for past dates), or null. */
    fun daysSince(value: String?, today: LocalDate): Int? = daysUntil(value, today)?.let { -it }

    /**
     * A compact "on hand for" label, mirroring the web `ageLabel`:
     * under a fortnight → `Nd`, under ~1.5 months → `Nw`, under a year → `N mo`,
     * otherwise years (anything under about two reads as "1 yr").
     */
    fun ageLabel(daysSince: Int): String {
        val d = max(0, daysSince).toDouble()
        val months = d / DAYS_PER_MONTH
        if (d < 14) return "${max(1, d.roundToInt())}d"
        if (months < 1.5) return "${(d / 7).roundToInt()}w"
        if (months < 12) return "${months.roundToInt()} mo"
        val years = months / 12
        return if (years < 1.95) "1 yr" else "${years.roundToInt()} yr"
    }
}
