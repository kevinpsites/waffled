package app.waffled.feature.goalcharts

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import app.waffled.core.model.GoalCadence
import app.waffled.core.model.GoalSeries
import app.waffled.core.model.HouseholdWeekStart
import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.ChronoUnit
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.min

/**
 * Everything the eight goal visualisations derive, as pure functions.
 *
 * The Kotlin twin of `apps/ios/Sources/Waffled/Features/Goals/GoalStats.swift` (itself a
 * mirror of `apps/web/src/lib/goalStats.ts`), adapted to the `GoalSeries` contract.
 *
 * Two rules shape this file:
 *
 * 1. **No date math while drawing.** A Compose draw scope runs on every frame; building a
 *    [LocalDate] inside one is one of the two documented jank sources inherited from iOS.
 *    Every grid is built once per [GoalSeries] change (see [computeGoalChartStats] and the
 *    grid builders) and indexed by position afterwards.
 * 2. **A `Canvas` cannot be unit-tested on the JVM.** So every number the drawing depends
 *    on lives here rather than inside a draw scope, and `GoalChartMathTest` covers it.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The eight visualisations, in their canonical menu order. */
enum class GoalViewKey(val label: String) {
    Week("Week"),
    Month("Month"),
    Pace("Pace"),
    Year("Year"),
    ByPerson("By person"),
    YearRing("Year ring"),
    Collection("Collection"),
    Consistency("Consistency"),
}

/** How much calendar a goal spans, which decides whether year-scale views make sense. */
enum class GoalTimeframe { Short, Long, OpenEnded }

/**
 * How one calendar day should be painted.
 *
 * [Empty] and [Blank] are the two halves of the distinction `GoalSeries` preserves by
 * omitting untouched days: inside the goal's own window "nothing logged" is a real,
 * visible state and gets a quiet cell, while outside it the goal was not tracking at all
 * and nothing is painted. `rangeStart`/`rangeEnd` are what separates them, which is why
 * the contract carries them.
 */
enum class DayPaint {
    /** Something was logged — paint the heat fill. */
    Heat,

    /** In the window, nothing logged — paint the quiet "nothing today" cell. */
    Empty,

    /** Outside the series' own range — reserve the slot, paint nothing. */
    Blank,

    /** Beyond today — the dashed "not yet" outline. */
    Future,
}

/**
 * One calendar day, fully resolved for drawing. Built ahead of the draw scope; a view
 * indexes these by grid position and does no date math of its own.
 */
@Immutable
data class DayCell(
    val day: LocalDate,
    /** The day's total. Zero when [hasEntry] is true means "logged nothing". */
    val value: Double,
    /** Whether the series actually carries a point for this day. */
    val hasEntry: Boolean,
    val paint: DayPaint,
    /** Everyone who logged on this day, in a stable order. Never a raw dictionary order. */
    val personIds: List<String>,
) {
    val future: Boolean get() = paint == DayPaint.Future
    val logged: Boolean get() = paint == DayPaint.Heat
}

/** A month's cells plus the number of empty leading slots before the 1st. */
@Immutable
data class MonthGrid(val month: YearMonth, val lead: Int, val cells: List<DayCell>)

/**
 * Target pace at a moment in a goal's life, and how far off it the goal actually is.
 *
 * Both numbers are `Double`s even though [GoalSeries.target] is an `Int`. [paceValue] is
 * an INTERPOLATION of a whole target across elapsed time — 100 pages over 365 days is 2.74
 * by day 10, not 3 — so it is fractional whether or not the target is, and [delta] is that
 * interpolation subtracted from a measured total. Rounding either made the standing jitter
 * by up to half a unit against a total that no longer rounds.
 */
@Immutable
data class GoalPace(val paceValue: Double, val delta: Double, val endLabel: LocalDate)

/** A day's total split by who logged it. */
@Immutable
data class DayTotals(val total: Double, val perPerson: Map<String, Double>)

// ---------------------------------------------------------------------------
// Derived stats — computed once per GoalSeries change
// ---------------------------------------------------------------------------

@Immutable
data class GoalChartStats(
    /** The household's "today". Passed in, never `LocalDate.now()` inside a view. */
    val today: LocalDate,
    val rangeStart: LocalDate?,
    val rangeEnd: LocalDate?,
    val target: Int?,
    val unit: String,
    val byDay: Map<LocalDate, DayTotals>,
    /** 12 entries, index 0 = January, for [today]'s calendar year. */
    val byMonth: List<Double>,
    /** 12 entries, matching [byMonth]. */
    val byMonthPerPerson: List<Map<String, Double>>,
    /** Lifetime total per person. */
    val byPerson: Map<String, Double>,
    val total: Double,
    val currentStreak: Int,
    val longestStreak: Int,
    val activeDays: Int,
    val bestDay: LocalDate?,
    /** Biggest single day in the last 7 days / this month / this calendar year. */
    val weekMax: Double,
    val monthMax: Double,
    val yearMax: Double,
    val pace: GoalPace?,
    val projectedFinish: LocalDate?,
    /** Stable person ordering: declared colours first, then anyone else lexically. */
    val personOrder: List<String>,
) {
    /**
     * Resolve one calendar day for drawing.
     *
     * [floor] is an extra lower bound a view can impose on top of the series' own range —
     * the year grid uses it so the leading days of the week containing Jan 1 stay blank.
     */
    fun cell(day: LocalDate, floor: LocalDate? = null): DayCell {
        val entry = byDay[day]
        val inRange = (rangeStart == null || !day.isBefore(rangeStart)) &&
            (rangeEnd == null || !day.isAfter(rangeEnd)) &&
            (floor == null || !day.isBefore(floor))
        val paint = when {
            day.isAfter(today) -> DayPaint.Future
            // Outside the window the goal was never tracking: paint nothing at all.
            !inRange -> DayPaint.Blank
            // Inside the window, an absent day and an explicit zero both mean "nothing
            // logged", and both earn the quiet cell — a month with three logged days must
            // still look like a month, not like three squares floating in a hole. The
            // finer absent-vs-zero difference is carried by [DayCell.hasEntry] and spoken
            // in the day sheet, which has room for a sentence a 13dp square does not.
            entry == null || entry.total <= 0.0 -> DayPaint.Empty
            else -> DayPaint.Heat
        }
        return DayCell(
            day = day,
            value = entry?.total ?: 0.0,
            hasEntry = entry != null,
            paint = paint,
            personIds = entry?.let { totals -> personOrder.filter { totals.perPerson.containsKey(it) } }
                ?: emptyList(),
        )
    }
}

/**
 * Fold a [GoalSeries] into everything the eight views need.
 *
 * [today] is a parameter, not `LocalDate.now()`: the tests need determinism, and the
 * caller knows the household's timezone while this module does not. Device-local "today"
 * is exactly the bug iOS avoids by bucketing server-side.
 */
fun computeGoalChartStats(series: GoalSeries, today: LocalDate): GoalChartStats {
    // Stable person ordering, once. `personColors` is the caller's declared order (a
    // LinkedHashMap over the wire); anyone who logged without a declared colour is
    // appended lexically so the per-day dots never reorder between frames.
    val declared = series.personColors.keys.toList()
    val extras = series.points.mapNotNull { it.personId }.toSortedSet().filter { it !in declared }
    val personOrder = declared + extras

    val byDay = LinkedHashMap<LocalDate, DayTotals>()
    for (point in series.points) {
        val prior = byDay[point.day]
        val perPerson = LinkedHashMap(prior?.perPerson ?: emptyMap())
        point.personId?.let { perPerson[it] = (perPerson[it] ?: 0.0) + point.value }
        byDay[point.day] = DayTotals((prior?.total ?: 0.0) + point.value, perPerson)
    }

    var total = 0.0
    var bestDay: LocalDate? = null
    var bestValue = Double.NEGATIVE_INFINITY
    val byPerson = LinkedHashMap<String, Double>()
    for ((day, totals) in byDay) {
        total += totals.total
        if (totals.total > bestValue) {
            bestValue = totals.total
            bestDay = day
        }
        for ((person, amount) in totals.perPerson) {
            byPerson[person] = (byPerson[person] ?: 0.0) + amount
        }
    }

    // A day counts as "active" only when something was actually logged — a habit's daily
    // total is 1/0, so this doubles as hit/miss, and an explicit zero breaks a streak.
    // ANY positive amount qualifies, including a fractional one: a 20-minute log is a day
    // you showed up, and rounding it to zero used to break the streak that proves it.
    val activeDates = byDay.filterValues { it.total > 0.0 }.keys.sorted()

    // currentStreak: consecutive active days ending today or yesterday, matching the
    // server's goalStreak rule.
    var currentStreak = 0
    val latest = activeDates.lastOrNull()
    if (latest != null && ChronoUnit.DAYS.between(latest, today) <= 1) {
        var cursor = latest
        for (day in activeDates.asReversed()) {
            if (day == cursor) {
                currentStreak++
                cursor = cursor.minusDays(1)
            } else {
                break
            }
        }
    }

    var longestStreak = 0
    var run = 0
    var previous: LocalDate? = null
    for (day in activeDates) {
        run = if (previous != null && previous.plusDays(1) == day) run + 1 else 1
        if (run > longestStreak) longestStreak = run
        previous = day
    }

    val last7 = (0L..6L).map { today.minusDays(it) }.toSet()
    val weekMax = byDay.filterKeys { it in last7 }.values.maxOfOrNull { it.total } ?: 0.0
    val thisMonth = YearMonth.from(today)
    val monthMax = byDay.filterKeys { YearMonth.from(it) == thisMonth }.values.maxOfOrNull { it.total } ?: 0.0
    val yearMax = byDay.filterKeys { it.year == today.year }.values.maxOfOrNull { it.total } ?: 0.0

    val byMonth = MutableList(12) { 0.0 }
    val byMonthPerPerson = MutableList(12) { LinkedHashMap<String, Double>() }
    for ((day, totals) in byDay) {
        if (day.year != today.year) continue
        val index = day.monthValue - 1
        byMonth[index] += totals.total
        for ((person, amount) in totals.perPerson) {
            byMonthPerPerson[index][person] = (byMonthPerPerson[index][person] ?: 0.0) + amount
        }
    }

    // Pace: target * elapsed / the goal's OWN duration — never a hard-coded 365. Null for
    // an open-ended goal (nothing to pace against) or one with no numeric target.
    val start = series.rangeStart
    val end = series.rangeEnd
    val target = series.target
    val pace = if (start != null && end != null && target != null) {
        val duration = maxOf(1L, ChronoUnit.DAYS.between(start, end))
        val elapsed = ChronoUnit.DAYS.between(start, today).coerceIn(0L, duration)
        val paceValue = target.toDouble() * elapsed / duration
        GoalPace(paceValue = paceValue, delta = total - paceValue, endLabel = end)
    } else {
        null
    }

    // projectedFinish: extend the trailing-14-day rolling rate. Null when there is no
    // recent rate to extrapolate from.
    val projectedFinish = if (target == null) {
        null
    } else {
        val remaining = target - total
        if (remaining <= 0.0) {
            today
        } else {
            val windowStart = today.minusDays(13)
            val recent = byDay
                .filterKeys { !it.isBefore(windowStart) && !it.isAfter(today) }
                .values.sumOf { it.total }
            val spanDays = if (start == null) {
                14L
            } else {
                minOf(14L, ChronoUnit.DAYS.between(start, today) + 1).coerceAtLeast(1L)
            }
            val rate = recent / spanDays
            if (rate > 0.001) today.plusDays(ceil(remaining / rate).toLong()) else null
        }
    }

    return GoalChartStats(
        today = today,
        rangeStart = start,
        rangeEnd = end,
        target = target,
        unit = series.unit,
        byDay = byDay,
        byMonth = byMonth,
        byMonthPerPerson = byMonthPerPerson,
        byPerson = byPerson,
        total = total,
        currentStreak = currentStreak,
        longestStreak = longestStreak,
        activeDays = activeDates.size,
        bestDay = bestDay,
        weekMax = weekMax,
        monthMax = monthMax,
        yearMax = yearMax,
        pace = pace,
        projectedFinish = projectedFinish,
        personOrder = personOrder,
    )
}

// ---------------------------------------------------------------------------
// Grids — built once, indexed while drawing
// ---------------------------------------------------------------------------

/**
 * The day that starts the household week containing [day].
 *
 * Anchors the week strip to a fixed calendar week rather than a rolling 7-day window.
 * [firstDay] is required, not defaulted: every grid's week boundary has to agree with the
 * others, so each caller names it.
 */
fun startOfWeek(day: LocalDate, firstDay: HouseholdWeekStart): LocalDate = firstDay.weekStart(day)

/** A one-letter weekday header row opening on [firstDay]. */
fun weekdayHeads(firstDay: HouseholdWeekStart): List<String> = firstDay.rotated(SUNDAY_FIRST_HEADS)

private val SUNDAY_FIRST_HEADS = listOf("S", "M", "T", "W", "T", "F", "S")

/** The seven cells of the calendar week beginning [weekStart]. */
fun weekCells(stats: GoalChartStats, weekStart: LocalDate): List<DayCell> =
    (0L..6L).map { stats.cell(weekStart.plusDays(it)) }

/** One month's day cells, in order — no layout. */
fun monthCells(stats: GoalChartStats, month: YearMonth): List<DayCell> =
    (1..month.lengthOfMonth()).map { stats.cell(month.atDay(it)) }

/** One month's cells, plus the leading slots that align the 1st under its weekday. */
fun monthGrid(stats: GoalChartStats, month: YearMonth, firstDay: HouseholdWeekStart): MonthGrid =
    MonthGrid(
        month = month,
        lead = firstDay.monthLeadCells(month.atDay(1)),
        cells = monthCells(stats, month),
    )

/**
 * The contribution grid: one column per calendar week, from the week containing Jan 1 of
 * [today]'s year through the week containing [today].
 *
 * Days before Jan 1 are floored out rather than dropped, so every column stays 7 tall and
 * a view can index `columns[c][r]` without a bounds dance.
 */
fun yearColumns(stats: GoalChartStats, today: LocalDate, firstDay: HouseholdWeekStart): List<List<DayCell>> {
    val jan1 = LocalDate.of(today.year, 1, 1)
    val columns = mutableListOf<List<DayCell>>()
    var cursor = startOfWeek(jan1, firstDay)
    while (!cursor.isAfter(today)) {
        val start = cursor
        columns += (0L..6L).map { stats.cell(start.plusDays(it), floor = jan1) }
        cursor = cursor.plusDays(7)
    }
    return columns
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/**
 * The denominator a heat ramp divides by: the biggest logged day among [cells], ignoring
 * the future, floored at 1 so an all-quiet page can never divide by zero.
 */
fun scaleMax(cells: List<DayCell>): Double =
    scaleDenominator(cells.filter { !it.future }.maxOfOrNull { it.value })

/**
 * A safe denominator for a heat ramp or a bar track: the biggest value actually present,
 * falling back to 1 only when there is nothing positive to scale against.
 *
 * Deliberately NOT `maxOf(1.0, max)`. That was harmless while amounts were whole numbers —
 * the smallest real value was 1, so the floor only ever fired on an empty page — but it
 * silently clamps fractional data. An hours goal whose week is 0.33, 0.5 and 0.25 has a
 * true max of 0.5; floored to 1.0, every cell paints at half intensity or less and the
 * darkest day never reaches the top of the ramp, so a week of real work renders as
 * barely-there. The floor's job is divide-by-zero protection, nothing more, and
 * [heatIntensity] already returns 0 for a non-positive value — an all-quiet page paints
 * nothing whatever the denominator is.
 */
fun scaleDenominator(max: Double?): Double = max?.takeIf { it > 0.0 } ?: 1.0

/** A day's position on the ramp, clamped to `0..1`. A zero max reads as no heat at all. */
fun heatIntensity(value: Double, max: Double): Float =
    if (max <= 0.0 || value <= 0.0) 0f else min(1f, (value / max).toFloat())

/**
 * The heat ramp, as a component-wise lerp between two theme tokens.
 *
 * iOS lerps a literal pale green (233,245,236) to a literal deep green (18,99,61). On
 * Android the endpoints are tokens instead — call sites pass `WF.colors.panel` (the same
 * quiet surface an unlogged day gets) and `WF.colors.success` (0x25A368, the token the iOS
 * ramp's hue was drawn from), so the ramp follows the theme into dark mode instead of
 * staying a fixed light-mode green.
 *
 * Deliberately NOT `androidx.compose.ui.graphics.lerp`, which interpolates through Oklab
 * and would not match the iOS ramp's straight sRGB mix.
 */
fun heatColor(t: Float, base: Color, peak: Color): Color {
    val c = t.coerceIn(0f, 1f)
    return Color(
        red = base.red + (peak.red - base.red) * c,
        green = base.green + (peak.green - base.green) * c,
        blue = base.blue + (peak.blue - base.blue) * c,
        alpha = 1f,
    )
}

/** Above this the fill is dark enough that its label must flip to white. Ported from iOS. */
const val HEAT_DARK_THRESHOLD: Float = 0.55f

fun isHeatDark(intensity: Float): Boolean = intensity > HEAT_DARK_THRESHOLD

// ---------------------------------------------------------------------------
// Ring geometry
// ---------------------------------------------------------------------------

/** A wedge of the year ring, in the angle convention `Canvas.drawArc` expects. */
@Immutable
data class RingSector(val startAngle: Float, val sweepAngle: Float)

const val RING_GAP_DEGREES: Float = 3f
const val RING_INNER_RADIUS: Float = 56f
const val RING_OUTER_RADIUS: Float = 116f

/**
 * The wedge for [month] (0 = January).
 *
 * Twelve 30-degree slots with a [RING_GAP_DEGREES] gap between them, shifted by -90 so
 * January starts at twelve o'clock — `drawArc` measures from three o'clock, clockwise.
 */
fun ringSector(month: Int, gapDegrees: Float = RING_GAP_DEGREES): RingSector {
    val a0 = month * 30f + gapDegrees / 2f
    val a1 = (month + 1) * 30f - gapDegrees / 2f
    return RingSector(startAngle = a0 - 90f, sweepAngle = a1 - a0)
}

/** How far out from [r0] a month's wedge is filled — a longer arc means more logged. */
fun ringFillRadius(value: Double, max: Double, r0: Float, r1: Float): Float =
    r0 + heatIntensity(value, max) * (r1 - r0)

/** Which month a tap at ([dx], [dy]) from the ring's centre lands on. */
fun ringMonthAt(dx: Float, dy: Float): Int {
    var degrees = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())) + 90.0
    if (degrees < 0) degrees += 360.0
    if (degrees >= 360.0) degrees -= 360.0
    return min(11, (degrees / 30.0).toInt())
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

/**
 * How many slots the collection shelf draws.
 *
 * Never fewer than [done]: over-achieving past the target must add shelf, not silently
 * hide the extras. Floored at 1 so a target-less goal still renders one slot.
 *
 * [done] stays an `Int` — a shelf slot is a discrete thing you either collected or did
 * not, so the caller TRUNCATES a fractional total on the way in (see [CollectionGridView]).
 * That is the same "not quite there is not there" rule `progressPercent` is built on.
 */
fun collectionSlots(target: Int?, done: Int): Int = maxOf(1, maxOf(target ?: 0, done))

/** Truncated percentage, tolerating a zero denominator. */
fun percentOf(part: Int, whole: Int): Int = if (whole <= 0) 0 else part * 100 / whole

/**
 * Which of the eight views this series can meaningfully offer.
 *
 * iOS keys this off `goal.goalType` ("total" / "count" / "habit" / "checklist"), which
 * `GoalSeries` does not carry — see the module's reported contract gap. These predicates
 * derive the same answers from what the series DOES carry, and [goalType] narrows the set
 * further when a caller happens to know it. An archetype this module doesn't recognise is
 * ignored rather than blanking the switcher.
 */
fun offeredViews(series: GoalSeries, today: LocalDate, goalType: String? = null): List<GoalViewKey> {
    val hasTarget = (series.target ?: 0) > 0
    val hasPeople = series.personColors.isNotEmpty() || series.points.any { it.personId != null }
    val daily = series.cadence == GoalCadence.Daily
    val wholeGoalTarget = hasTarget && series.cadence == GoalCadence.Total
    val timeframe = classifyTimeframe(series.rangeStart, series.rangeEnd)

    var derived = GoalViewKey.entries.filter { key ->
        when (key) {
            // The week strip and the consistency dot-calendar both ask "did you show up
            // today", which only means something for a per-day cadence.
            GoalViewKey.Week, GoalViewKey.Consistency -> daily
            GoalViewKey.Pace -> hasTarget
            // A shelf of `target` slots is a whole-goal count, not a per-period one.
            GoalViewKey.Collection -> wholeGoalTarget
            GoalViewKey.ByPerson -> hasPeople
            GoalViewKey.Month, GoalViewKey.Year, GoalViewKey.YearRing -> true
        }
    }
    if (timeframe == GoalTimeframe.Short) derived = derived.filter { it !in DROPS_FOR_SHORT_WINDOW }

    val byType = goalType?.let { TYPE_VIEWS[it] } ?: return derived
    return derived.filter { it in byType }
}

/** Which view the switcher opens on, or null when this goal has nothing to show. */
fun defaultView(series: GoalSeries, today: LocalDate, goalType: String? = null): GoalViewKey? {
    val offered = offeredViews(series, today, goalType)
    if (offered.isEmpty()) return null
    // The signature views: each is only offered when its archetype's own condition holds,
    // so "offered at all" is the same signal iOS gets from `signatureView[goalType]`.
    SIGNATURE_ORDER.firstOrNull { it in offered }?.let { return it }
    return FALLBACK_ORDER.firstOrNull { it in offered } ?: offered.first()
}

/** Short / long / open-ended, on the same 31-day boundary iOS uses. */
fun classifyTimeframe(start: LocalDate?, end: LocalDate?): GoalTimeframe {
    if (start == null || end == null) return GoalTimeframe.OpenEnded
    return if (ChronoUnit.DAYS.between(start, end) < SHORT_WINDOW_DAYS) {
        GoalTimeframe.Short
    } else {
        GoalTimeframe.Long
    }
}

private const val SHORT_WINDOW_DAYS = 31L

private val DROPS_FOR_SHORT_WINDOW = setOf(
    GoalViewKey.Year,
    GoalViewKey.Month,
    GoalViewKey.YearRing,
    GoalViewKey.Consistency,
)

private val SIGNATURE_ORDER = listOf(GoalViewKey.Collection, GoalViewKey.Consistency)

/**
 * Mirrors the EFFECTIVE iOS default rather than its `fallbackOrder` list: for a "total"
 * goal iOS's signature is Month (open on "what did we actually do", never on a pace
 * projection), falling back to Week when the window is too short for a month view.
 */
private val FALLBACK_ORDER = listOf(
    GoalViewKey.Month,
    GoalViewKey.Week,
    GoalViewKey.Year,
    GoalViewKey.ByPerson,
    GoalViewKey.Pace,
    GoalViewKey.YearRing,
)

/** The iOS goalType -> views table, used only when a caller supplies an archetype. */
private val TYPE_VIEWS: Map<String, Set<GoalViewKey>> = mapOf(
    "total" to setOf(
        GoalViewKey.Week, GoalViewKey.Month, GoalViewKey.Year,
        GoalViewKey.Pace, GoalViewKey.YearRing, GoalViewKey.ByPerson,
    ),
    "count" to setOf(GoalViewKey.Month, GoalViewKey.Pace, GoalViewKey.Collection),
    "habit" to setOf(GoalViewKey.Consistency, GoalViewKey.Week),
    "checklist" to emptySet(),
)
