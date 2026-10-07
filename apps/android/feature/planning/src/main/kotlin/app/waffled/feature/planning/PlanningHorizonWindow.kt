package app.waffled.feature.planning

import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The Horizon scan's window: the next four weeks from the planned week, not its calendar
 * month — late in a month most of "this month" has already happened. Day arithmetic on
 * calendar labels, so no zone or DST shift can move a day.
 */
object PlanningHorizonWindow {
    const val WEEKS = 4

    /** The first day of the window [ahead] steps past the planned week. */
    fun start(weekStart: String, ahead: Int): String? =
        PlanningFormat.parseDay(weekStart)?.plusDays(ahead.toLong() * WEEKS * 7)?.toString()

    /** "Sep 6 – Oct 3" — the window's first and last day. */
    fun label(start: String, locale: Locale = Locale.getDefault()): String {
        val s = PlanningFormat.parseDay(start) ?: return ""
        val e = s.plusDays(WEEKS * 7L - 1)
        val f = DateTimeFormatter.ofPattern("MMM d", locale)
        return "${s.format(f)} – ${e.format(f)}"
    }
}
