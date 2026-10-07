package app.waffled.feature.calendar

import androidx.compose.runtime.Immutable
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.WaffledDates
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.IsoFields
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/**
 * The phone calendar's layout rules — Month → Week → Day — kept out of the composables so
 * they can be tested. Twin of iOS `PhoneCalendar` (`PhoneCalendarLayout.swift`); rationale
 * for the numbers lives in `docs/product/ios-calendar-redesign.md`.
 *
 * Every function reads precomputed [EventRow] fields, never re-parses a timestamp.
 */
object PhoneCalendar {

    /**
     * Picked from the header's view menu. [Agenda] sits outside the pinch order; it stays
     * because it is the list view that carries the person filter row.
     */
    enum class Mode(val wire: String, val label: String) {
        Month("month", "Month"),
        Week("week", "Week"),
        Day("day", "Day"),
        Agenda("agenda", "Agenda"),
        ;

        /** Spread (`zoomIn`) moves Month → Week → Day; pinch moves back out. Stops at the ends. */
        fun zoomed(zoomIn: Boolean): Mode = when (this) {
            Month, Agenda -> if (zoomIn) Week else this
            Week -> if (zoomIn) Day else Month
            Day -> if (zoomIn) Day else Week
        }

        companion object {
            fun fromWire(raw: String?): Mode? = entries.firstOrNull { it.wire == raw }

            /**
             * The view to open on: a launch override as-is, else the saved view — except Day,
             * which is a drill-in, so a saved Day reopens on Month.
             */
            fun restored(stored: Mode, override: Mode?): Mode =
                override ?: if (stored == Day) Month else stored
        }
    }

    // ---- Month ------------------------------------------------------------------------

    @Immutable
    data class MonthDay(val date: LocalDate, val day: Int, val inMonth: Boolean)

    @Immutable
    data class MonthRow(val weekNumber: Int, val days: List<MonthDay>)

    /**
     * Only the rows the month needs (5 or 6), cut on the household's first day. The gutter
     * number is the ISO week of the row's Monday, so a Sunday-first row still reads as the
     * work week everyone calls "week 38".
     */
    fun monthRows(anchor: LocalDate, firstDay: HouseholdWeekStart): List<MonthRow> {
        val first = anchor.withDayOfMonth(1)
        val start = firstDay.weekStart(first)
        val rowCount = (firstDay.monthLeadCells(first) + first.lengthOfMonth() + 6) / 7
        return rows(start, rowCount, firstDay) { it.month == first.month && it.year == first.year }
    }

    /**
     * [count] whole weeks from [start], which the caller has already cut on the household's
     * first day (Horizon passes the server's week start). Every day is `inMonth`: a window
     * has no "other month" to dim. Numbered like [monthRows].
     */
    fun weekRows(start: LocalDate, count: Int, firstDay: HouseholdWeekStart): List<MonthRow> =
        rows(start, maxOf(0, count), firstDay) { true }

    /** [weekRows] from a `yyyy-MM-dd` key; an unreadable key draws nothing. */
    fun weekRows(startKey: String, count: Int, firstDay: HouseholdWeekStart): List<MonthRow> {
        val start = runCatching { LocalDate.parse(startKey.trim()) }.getOrNull() ?: return emptyList()
        return weekRows(start, count, firstDay)
    }

    private fun rows(
        start: LocalDate,
        count: Int,
        firstDay: HouseholdWeekStart,
        inMonth: (LocalDate) -> Boolean,
    ): List<MonthRow> {
        val mondayOffset = if (firstDay == HouseholdWeekStart.Monday) 0L else 1L
        return (0 until count).map { row ->
            val rowStart = start.plusDays(row * 7L)
            val days = (0 until 7).map { i ->
                val d = rowStart.plusDays(i.toLong())
                MonthDay(date = d, day = d.dayOfMonth, inMonth = inMonth(d))
            }
            MonthRow(rowStart.plusDays(mondayOffset).get(IsoFields.WEEK_OF_WEEK_BASED_YEAR), days)
        }
    }

    const val CHIP_HEIGHT: Float = 16f
    const val CHIP_GAP: Float = 2f
    const val DAY_NUMBER_HEIGHT: Float = 18f
    const val MORE_LINE_HEIGHT: Float = 12f
    const val CELL_TOP_PADDING: Float = 3f
    const val MAX_CELL_SLOTS: Int = 4

    @Immutable
    data class CellChips(val shown: Int, val more: Int, val showsCountdown: Boolean)

    /**
     * Titles per day cell: as many chips as the row height (dp) holds, never more than four.
     * One countdown pill takes a slot; further countdowns, like events that don't fit, count
     * toward "+N more", and room for that line is always kept. [reservedSlots] are the row's
     * spanning-bar lanes, drawn over the cells by the grid.
     */
    fun cellChips(eventCount: Int, countdownCount: Int, rowHeight: Float, reservedSlots: Int = 0): CellChips {
        val room = rowHeight - CELL_TOP_PADDING - DAY_NUMBER_HEIGHT - MORE_LINE_HEIGHT - CHIP_GAP
        val fit = minOf(MAX_CELL_SLOTS, maxOf(0, floor(room / (CHIP_HEIGHT + CHIP_GAP)).toInt()))
        val slots = maxOf(0, fit - reservedSlots)
        val showsCountdown = countdownCount > 0 && slots > 0
        val shown = minOf(eventCount, slots - if (showsCountdown) 1 else 0)
        val hiddenCountdowns = countdownCount - if (showsCountdown) 1 else 0
        return CellChips(shown = shown, more = eventCount - shown + hiddenCountdowns, showsCountdown = showsCountdown)
    }

    @Immutable
    data class SpanBar(
        val row: EventRow,
        val startCol: Int,
        val endCol: Int,
        val lane: Int,
        /** The event started before this row / runs on past it, so that end is square. */
        val continuesBefore: Boolean,
        val continuesAfter: Boolean,
    )

    @Immutable
    data class WeekSpans(
        val bars: List<SpanBar>,
        val lanes: Int,
        /** Each day's events that still draw as chips: everything the bars didn't take. */
        val chipsByDay: Map<LocalDate, List<EventRow>>,
    ) {
        companion object {
            val Empty = WeekSpans(emptyList(), 0, emptyMap())
        }
    }

    const val MAX_SPAN_LANES: Int = 2

    @Immutable
    data class ChipCap(val shown: Int, val more: Int)

    /** A tablet month cell's chips: a fixed cap, less the row's bar lanes; the rest are "+N more". */
    fun cappedChips(eventCount: Int, cap: Int, reserved: Int): ChipCap {
        val shown = minOf(eventCount, maxOf(0, cap - reserved))
        return ChipCap(shown = shown, more = eventCount - shown)
    }

    data class BarX(val x: Float, val width: Float)

    /**
     * A bar's x and width in a row of seven equal cells [spacing] apart: its columns and the
     * gaps between them, [inset] in from both ends.
     */
    fun spanBarX(startCol: Int, endCol: Int, rowWidth: Float, spacing: Float, inset: Float): BarX {
        val col = (rowWidth - spacing * 6) / 7
        val cols = (endCol - startCol + 1).toFloat()
        return BarX(startCol * (col + spacing) + inset, maxOf(0f, cols * col + (cols - 1) * spacing - inset * 2))
    }

    /**
     * Multi-day all-day events in one month row, laid out as bars across their days like
     * Google's month view: earliest start first, longer first on a tie, each in the first lane
     * free by its start. Beyond [maxLanes] an event stays a chip in each of its days.
     */
    fun weekSpans(
        days: List<LocalDate>,
        byDay: Map<LocalDate, List<EventRow>>,
        maxLanes: Int = MAX_SPAN_LANES,
    ): WeekSpans {
        val firstDay = days.firstOrNull() ?: return WeekSpans.Empty
        val afterRow = days.last().plusDays(1)

        class Candidate(val row: EventRow, val start: Int, val end: Int, val before: Boolean, val after: Boolean)

        val seen = HashSet<String>()
        val candidates = mutableListOf<Candidate>()
        days.forEachIndexed { col, key ->
            for (e in byDay[key].orEmpty()) {
                if (!e.allDay || e.id in seen) continue
                // Null for a one-day all-day event: that stays a chip.
                val endExclusive = e.exclusiveEndDay ?: continue
                seen += e.id
                val end = maxOf(col, days.indexOfLast { it.isBefore(endExclusive) }.takeIf { it >= 0 } ?: col)
                val before = e.startDay?.isBefore(firstDay) == true
                val after = endExclusive.isAfter(afterRow)
                if (!(before || after || end > col)) continue
                candidates += Candidate(e, col, end, before, after)
            }
        }
        candidates.sortWith(compareBy<Candidate> { it.start }.thenByDescending { it.end }.thenBy { it.row.id })

        val laneEnds = mutableListOf<Int>()
        val bars = mutableListOf<SpanBar>()
        for (c in candidates) {
            val lane = laneEnds.indexOfFirst { it < c.start }.takeIf { it >= 0 } ?: laneEnds.size
            if (lane >= maxLanes) continue
            if (lane == laneEnds.size) laneEnds += c.end else laneEnds[lane] = c.end
            bars += SpanBar(c.row, c.start, c.end, lane, c.before, c.after)
        }
        val barIds = bars.mapTo(HashSet()) { it.row.id }
        val chips = days.associateWith { key -> byDay[key].orEmpty().filter { it.id !in barIds } }
        return WeekSpans(bars = bars, lanes = laneEnds.size, chipsByDay = chips)
    }

    // ---- Week -------------------------------------------------------------------------

    fun weekDays(containing: LocalDate, firstDay: HouseholdWeekStart): List<LocalDate> {
        val start = firstDay.weekStart(containing)
        return (0 until 7).map { start.plusDays(it.toLong()) }
    }

    /** "Sep 14 – 20", or "Sep 28 – Oct 4" when the week crosses a month. */
    fun weekTitle(days: List<LocalDate>, locale: Locale = Locale.getDefault()): String {
        val first = days.firstOrNull() ?: return ""
        val last = days.last()
        val sameMonth = first.year == last.year && first.month == last.month
        val utc = ZoneId.of("UTC")
        fun fmt(d: LocalDate, pattern: String) =
            WaffledDates.format(d.atStartOfDay(utc).toInstant(), pattern, utc, locale)
        return "${fmt(first, "MMM d")} – ${fmt(last, if (sameMonth) "d" else "MMM d")}"
    }

    /** "9:30a" / "12p" — the week card's narrow time column. */
    fun shortTime(instant: Instant, zone: ZoneId): String {
        val t = instant.atZone(zone)
        val hour = t.hour
        val minute = t.minute
        val h12 = if (hour % 12 == 0) 12 else hour % 12
        val mm = if (minute == 0) "" else ":%02d".format(minute)
        return "$h12$mm${if (hour < 12) "a" else "p"}"
    }

    /**
     * All-day first (birthdays, trips), then timed by start — the order a day cell and a week
     * card read in. [Agenda.order] is the opposite, for lists that lead with the clock.
     */
    fun displayOrder(rows: List<EventRow>): List<EventRow> =
        rows.filter { it.allDay } + rows.filter { !it.allDay }.sortedBy { it.startsAt ?: Instant.MAX }

    /**
     * The day Week should show when you arrive from a month: your selection if it's in that
     * month, else today if it is, else the 1st.
     */
    fun focusDay(selected: LocalDate, inMonthOf: LocalDate, today: LocalDate): LocalDate {
        fun sameMonth(d: LocalDate) = d.year == inMonthOf.year && d.month == inMonthOf.month
        return when {
            sameMonth(selected) -> selected
            sameMonth(today) -> today
            else -> inMonthOf.withDayOfMonth(1)
        }
    }

    /** Width (dp) of the leading strip the system back gesture owns. */
    const val BACK_SWIPE_EDGE: Float = 30f

    /**
     * Day paging: the shared flick thresholds, minus drags that start at the leading edge —
     * those are the back gesture, and paging too would shift the day on the way out.
     */
    fun daySwipeStep(startX: Float, dx: Float, dy: Float): Int? {
        if (startX < BACK_SWIPE_EDGE) return null
        return HorizontalSwipe.step(dx, dy)
    }

    /** The first day of each of the rail's weeks — the day strip's pages. */
    fun railWeeks(days: List<LocalDate>): List<LocalDate> = days.indices.step(7).map { days[it] }

    /**
     * The week rail's days: whole weeks either side of [around]'s week, so swiping on from the
     * last day of a week simply scrolls into the next one.
     */
    fun railDays(around: LocalDate, weeksEachSide: Int, firstDay: HouseholdWeekStart): List<LocalDate> {
        val start = firstDay.weekStart(around.minusWeeks(weeksEachSide.toLong()))
        return (0 until (2 * weeksEachSide + 1) * 7).map { start.plusDays(it.toLong()) }
    }

    /** Re-centre the rail once the selection is within a week of either end, or off it entirely. */
    fun railNeedsRecenter(selected: LocalDate, days: List<LocalDate>): Boolean {
        val i = days.indexOf(selected)
        return i < 7 || i >= days.size - 7
    }

    fun shift(day: LocalDate, days: Int): LocalDate = day.plusDays(days.toLong())

    // ---- Meals ------------------------------------------------------------------------

    /**
     * The Meals module mirrors each planned meal (`meal_plan`) and its thaw reminder
     * (`meal_prep`) into ordinary events; see apps/api/src/modules/meals/meal-events.ts.
     */
    enum class EventKind {
        Regular, Meal, Prep;

        companion object {
            fun of(origin: String?): EventKind = when (origin) {
                "meal_plan" -> Meal
                "meal_prep" -> Prep
                else -> Regular
            }
        }
    }

    /**
     * The week card's closing line: tonight's planned dinner, else what to thaw for it.
     * Reads the server-written titles ("🍽️ Dinner · Salmon", "🧊 Thaw for Dinner · Salmon").
     */
    fun dinnerFooter(rows: List<EventRow>): String? {
        fun words(title: String) = title.dropWhile { !it.isLetter() }
        rows.firstOrNull { EventKind.of(it.event.origin) == EventKind.Meal && words(it.title).startsWith("Dinner") }
            ?.let { return words(it.title) }
        val prep = rows.firstOrNull {
            EventKind.of(it.event.origin) == EventKind.Prep && words(it.title).startsWith("Thaw for Dinner")
        } ?: return null
        val parts = words(prep.title).split(" · ")
        return if (parts.size > 1) "Thaw · " + parts.drop(1).joinToString(" · ") else "Thaw for dinner"
    }

    // ---- Day --------------------------------------------------------------------------

    val DEFAULT_DAY_HOURS: IntRange = 7..20

    /**
     * 7 AM–8 PM, widened to take in any timed event outside it — a fixed range would hide a
     * 6 AM flight.
     */
    fun dayHours(rows: List<EventRow>, zone: ZoneId): IntRange {
        var lo = DEFAULT_DAY_HOURS.first
        var hi = DEFAULT_DAY_HOURS.last
        for (e in rows) {
            if (e.allDay) continue
            val start = e.startsAt ?: continue
            val s = start.atZone(zone)
            lo = minOf(lo, s.hour)
            val end = TimeLanes.end(e).atZone(zone)
            hi = if (end.toLocalDate() != s.toLocalDate()) {
                24
            } else {
                maxOf(hi, end.hour + if (end.minute > 0) 1 else 0)
            }
        }
        return lo..hi
    }

    /**
     * An hour before the first timed event, so its lead-in shows above it; the top of the
     * grid when nothing is timed.
     */
    fun openingHour(rows: List<EventRow>, hours: IntRange, zone: ZoneId): Int {
        val first = rows.filter { !it.allDay }.mapNotNull { it.startsAt }.minOrNull() ?: return hours.first
        val hour = first.atZone(zone).hour
        return maxOf(hours.first, minOf(hours.last - 1, hour - 1))
    }
}

/**
 * Side-by-side lanes for overlapping timed events (interval partitioning: cluster
 * transitively-overlapping events, then give each the first free lane).
 */
object TimeLanes {
    @Immutable
    data class Placed(val row: EventRow, val lane: Int, val lanes: Int)

    private val HOUR: Duration = Duration.ofHours(1)
    private val MIN_BLOCK: Duration = Duration.ofMinutes(30)

    fun start(row: EventRow): Instant = row.startsAt ?: Instant.MIN

    /**
     * Open-ended events take an hour; anything shorter than 30 minutes still takes 30, so its
     * block is tall enough to read and to tap.
     */
    fun end(row: EventRow): Instant {
        val s = start(row)
        val duration = row.endsAt?.let { maxOf(MIN_BLOCK, Duration.between(s, it)) } ?: HOUR
        return s.plus(duration)
    }

    fun place(rows: List<EventRow>): List<Placed> {
        val sorted = rows.sortedBy(::start)
        val result = mutableListOf<Placed>()
        var i = 0
        while (i < sorted.size) {
            var clusterEnd = end(sorted[i])
            var j = i + 1
            while (j < sorted.size && start(sorted[j]).isBefore(clusterEnd)) {
                clusterEnd = maxOf(clusterEnd, end(sorted[j]))
                j++
            }
            val laneEnds = mutableListOf<Instant>()
            val assigned = mutableListOf<Pair<EventRow, Int>>()
            for (e in sorted.subList(i, j)) {
                val li = laneEnds.indexOfFirst { !start(e).isBefore(it) }
                if (li >= 0) {
                    laneEnds[li] = end(e)
                    assigned += e to li
                } else {
                    laneEnds += end(e)
                    assigned += e to laneEnds.size - 1
                }
            }
            assigned.mapTo(result) { (e, lane) -> Placed(e, lane, laneEnds.size) }
            i = j
        }
        return result
    }
}

/**
 * Shared horizontal-flick → step direction for the date steppers. Thresholds are in dp —
 * convert pointer pixels before calling, or a dense screen pages on a twitch.
 */
object HorizontalSwipe {
    /** `+1` for a forward flick (swipe left = next), `-1` for back, null when too small or too vertical. */
    fun step(dx: Float, dy: Float): Int? {
        if (abs(dx) <= 50f || abs(dx) <= abs(dy) * 1.5f) return null
        return if (dx < 0) 1 else -1
    }
}
