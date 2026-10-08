package app.waffled.feature.goals

import app.waffled.core.model.HouseholdWeekStart
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * The shared derived-stats layer for a goal's history — the Kotlin twin of
 * `apps/ios/.../Features/Goals/GoalStats.swift`, which mirrors
 * `apps/web/src/lib/goalStats.ts` 1:1. `GoalStatsTest` is the mirrored suite.
 *
 * Pure value types only, no networking: compute ONCE per goal (after the activity read
 * lands) and reuse. Date math in a render path is one of the two documented jank sources
 * inherited from iOS.
 *
 * Every day is keyed by a normalised LOCAL date string `yyyy-MM-dd`, never a timestamp —
 * see [GoalDateKey]. All arithmetic goes through `java.time.LocalDate`, which is
 * calendar-field arithmetic and therefore DST-safe; epoch-second arithmetic is not, and a
 * day would occasionally land on the wrong wall-clock date.
 */

/** One day's rolled-up log: the day's total plus who contributed what. */
data class DayEntry(
    val dateKey: String,
    val total: Double,
    /**
     * May hold a key at 0 — a `count_once` shared event's attendee is present but not
     * credited. Key on PRESENCE, never on `amount > 0`.
     */
    val perMember: Map<String, Double> = emptyMap(),
)

/**
 * Local-date key arithmetic.
 *
 * The keys the server sends are already bucketed in the HOUSEHOLD's timezone, so they are
 * manipulated as plain calendar dates here and never re-derived from a timestamp — a
 * re-parse would bucket by the device's zone instead and silently shift days.
 */
object GoalDateKey {

    fun today(zone: ZoneId = ZoneId.systemDefault()): String = toKey(LocalDate.now(zone))

    fun toKey(date: LocalDate): String = date.toString()

    /** Degrades to the device's today on a short or unparseable key — never throws. */
    fun parse(key: String): LocalDate = parseOrNull(key) ?: LocalDate.now()

    /** Strict: null for a short or unparseable key, for callers that must skip it. */
    fun parseOrNull(key: String): LocalDate? =
        runCatching { LocalDate.parse(key.trim().take(10)) }.getOrNull()

    fun addDays(key: String, n: Int): String = toKey(parse(key).plusDays(n.toLong()))

    /** Whole days from [b] to [a] — positive when [a] is later. */
    fun diffDays(a: String, b: String): Int =
        ChronoUnit.DAYS.between(parse(b), parse(a)).toInt()

    /**
     * The day that starts the household week containing [key] — a fixed calendar week, not
     * a rolling 7-day window. [firstDay] is required so every week boundary names its cut.
     */
    fun startOfWeek(key: String, firstDay: HouseholdWeekStart): String =
        toKey(firstDay.weekStart(parse(key)))
}

/** How much window a goal covers, which decides which views are worth offering. */
enum class GoalTimeframe { Short, Long, OpenEnded }

/** The eight goal visualisations, by key. Drawing them belongs to `feature:goalcharts`. */
enum class GoalViewKey(val key: String) {
    Week("week"),
    Month("month"),
    Pace("pace"),
    Year("year"),
    ByPerson("byPerson"),
    YearRing("yearRing"),
    Collection("collection"),
    Consistency("consistency"),
    ;

    companion object {
        fun fromKey(key: String?): GoalViewKey? = entries.firstOrNull { it.key == key }
    }
}

/** Target pace at a point in time, and how far ahead or behind the goal actually is. */
data class GoalPace(
    val paceValue: Double,
    val delta: Double,
    val endLabel: String,
)

/** Everything derived from one goal's day-bucketed log. */
data class GoalStatsResult(
    val today: String,
    val startDate: String,
    val endDate: String?,
    val byDay: Map<String, DayEntry>,
    /** 12 entries, index 0 = January, for [today]'s calendar year. */
    val byMonth: List<Double>,
    val byMonthPerMember: List<Map<String, Double>>,
    /** Lifetime total per person. */
    val byPerson: Map<String, Double>,
    val total: Double,
    val currentStreak: Int,
    val longestStreak: Int,
    val activeDays: Int,
    val bestDay: DayEntry?,
    val weekMax: Double,
    val monthMax: Double,
    val yearMax: Double,
    val pace: GoalPace?,
    val projectedFinish: String?,
) {
    /** Zero-filled — a missing day renders quiet, not empty. Never null at a call site. */
    fun dayEntry(dateKey: String): DayEntry =
        byDay[dateKey] ?: DayEntry(dateKey, 0.0, emptyMap())
}

object GoalStats {

    // ---- heat ramp -------------------------------------------------------------

    /**
     * Pale (233,245,236) → deep (18,99,61). `t = 0` (no activity at all) should use the
     * panel token at the call site rather than `heat(0)`.
     *
     * This is an identity ramp, not a theme colour: it must read the same in light and
     * dark, which is one of the two documented literal-colour exceptions.
     */
    fun heat(t: Double): Triple<Int, Int, Int> {
        val c = max(0.0, min(1.0, t))
        val lo = Triple(233.0, 245.0, 236.0)
        val hi = Triple(18.0, 99.0, 61.0)
        return Triple(
            (lo.first + (hi.first - lo.first) * c).roundToInt(),
            (lo.second + (hi.second - lo.second) * c).roundToInt(),
            (lo.third + (hi.third - lo.third) * c).roundToInt(),
        )
    }

    const val HEAT_DARK_THRESHOLD: Double = 0.55

    // ---- timeframe classification + goal-type -> view mapping ------------------

    /** "< ~1 month". Never hard-code 365 anywhere else — a goal owns its own window. */
    private const val SHORT_WINDOW_DAYS = 31

    fun classifyTimeframe(startDate: String, endDate: String?): GoalTimeframe {
        if (endDate == null) return GoalTimeframe.OpenEnded
        val totalDuration = GoalDateKey.diffDays(endDate, startDate)
        return if (totalDuration < SHORT_WINDOW_DAYS) GoalTimeframe.Short else GoalTimeframe.Long
    }

    private val typeViews: Map<String, List<GoalViewKey>> = mapOf(
        "total" to listOf(
            GoalViewKey.Week, GoalViewKey.Month, GoalViewKey.Year,
            GoalViewKey.Pace, GoalViewKey.YearRing, GoalViewKey.ByPerson,
        ),
        "count" to listOf(GoalViewKey.Month, GoalViewKey.Pace, GoalViewKey.Collection),
        "habit" to listOf(GoalViewKey.Consistency, GoalViewKey.Week),
        "checklist" to emptyList(),
    )

    /**
     * "total"'s signature is the rhythm view (Month, falling back to Week for goals too
     * short to have a meaningful month view), NOT Pace: a goal-detail page should open on
     * "what did we actually do", not a pace projection.
     */
    private val signatureView: Map<String, GoalViewKey> = mapOf(
        "total" to GoalViewKey.Month,
        "count" to GoalViewKey.Collection,
        "habit" to GoalViewKey.Consistency,
    )

    private val dropsForShortWindow = setOf(
        GoalViewKey.Year, GoalViewKey.Month, GoalViewKey.YearRing, GoalViewKey.Consistency,
    )

    fun availableViews(goalType: String, timeframe: GoalTimeframe): List<GoalViewKey> {
        val base = typeViews[goalType] ?: emptyList()
        if (timeframe != GoalTimeframe.Short) return base
        return base.filterNot { it in dropsForShortWindow }
    }

    private val fallbackOrder = listOf(
        GoalViewKey.Year, GoalViewKey.Month, GoalViewKey.Consistency, GoalViewKey.Week,
        GoalViewKey.ByPerson, GoalViewKey.Collection, GoalViewKey.Pace, GoalViewKey.YearRing,
    )

    fun defaultView(goalType: String, timeframe: GoalTimeframe): GoalViewKey? {
        val offered = availableViews(goalType, timeframe)
        if (offered.isEmpty()) return null
        signatureView[goalType]?.let { if (it in offered) return it }
        return fallbackOrder.firstOrNull { it in offered } ?: offered.first()
    }

    // ---- compute ---------------------------------------------------------------

    fun compute(
        today: String,
        startDate: String,
        endDate: String?,
        target: Double?,
        days: List<DayEntry>,
    ): GoalStatsResult {
        val byDay = days.associateBy { it.dateKey }

        var total = 0.0
        val byPerson = mutableMapOf<String, Double>()
        var bestDay: DayEntry? = null
        for (d in days) {
            total += d.total
            if (bestDay == null || d.total > bestDay.total) bestDay = d
            for ((person, amount) in d.perMember) {
                byPerson[person] = (byPerson[person] ?: 0.0) + amount
            }
        }

        // A day is "active" if it has any logged total — a habit's daily total is 1/0, so
        // this doubles as hit/miss.
        val activeDates = days.filter { it.total > 0 }.map { it.dateKey }.toSet()

        // currentStreak: consecutive active days ending today, matching the server's
        // goalStreak rule — it only counts when the latest active day is today or
        // yesterday (both bucketed by the same household-timezone expression server-side).
        var currentStreak = 0
        val sortedDesc = activeDates.sortedDescending()
        val latest = sortedDesc.firstOrNull()
        if (latest != null && GoalDateKey.diffDays(today, latest) <= 1) {
            var cursor = latest
            for (dateKey in sortedDesc) {
                if (dateKey != cursor) break
                currentStreak += 1
                cursor = GoalDateKey.addDays(cursor, -1)
            }
        }

        // longestStreak: the longest run of consecutive active days anywhere in the log.
        var longestStreak = 0
        var run = 0
        var prev: String? = null
        for (dateKey in activeDates.sorted()) {
            run = if (prev != null && GoalDateKey.addDays(prev, 1) == dateKey) run + 1 else 1
            longestStreak = max(longestStreak, run)
            prev = dateKey
        }

        val last7 = (0 until 7).map { GoalDateKey.addDays(today, -it) }.toSet()
        val weekMax = days.filter { it.dateKey in last7 }.maxOfOrNull { it.total } ?: 0.0

        val todayDate = GoalDateKey.parse(today)
        val monthMax = days
            .filter {
                val d = GoalDateKey.parse(it.dateKey)
                d.year == todayDate.year && d.monthValue == todayDate.monthValue
            }
            .maxOfOrNull { it.total } ?: 0.0
        val yearMax = days
            .filter { GoalDateKey.parse(it.dateKey).year == todayDate.year }
            .maxOfOrNull { it.total } ?: 0.0

        val byMonth = MutableList(12) { 0.0 }
        val byMonthPerMember = MutableList(12) { mutableMapOf<String, Double>() }
        for (d in days) {
            val dt = GoalDateKey.parse(d.dateKey)
            if (dt.year != todayDate.year) continue
            val i = dt.monthValue - 1
            byMonth[i] = byMonth[i] + d.total
            for ((person, amount) in d.perMember) {
                byMonthPerMember[i][person] = (byMonthPerMember[i][person] ?: 0.0) + amount
            }
        }

        // Pace: target × elapsed/totalDuration, derived from the goal's OWN start/end —
        // never a hard-coded 365. Null for an open-ended goal (no deadline to pace
        // against) or a goal with no numeric target.
        var pace: GoalPace? = null
        if (endDate != null && target != null) {
            val totalDuration = max(1, GoalDateKey.diffDays(endDate, startDate))
            val elapsed = max(0, min(totalDuration, GoalDateKey.diffDays(today, startDate)))
            val paceValue = (target * elapsed / totalDuration).roundToLong().toDouble()
            pace = GoalPace(
                paceValue = paceValue,
                delta = round2(total - paceValue),
                endLabel = endDate,
            )
        }

        // projectedFinish: extend the trailing-14-day rolling rate from today. Null when
        // the rate is ~0 (nothing recent to extrapolate from); today when the target is
        // already met.
        var projectedFinish: String? = null
        if (target != null) {
            val remaining = target - total
            if (remaining <= 0) {
                projectedFinish = today
            } else {
                val windowStart = GoalDateKey.addDays(today, -13)
                val recent = days
                    .filter { it.dateKey >= windowStart && it.dateKey <= today }
                    .sumOf { it.total }
                val spanDays = max(1, min(14, GoalDateKey.diffDays(today, startDate) + 1))
                val rate = recent / spanDays
                if (rate > 0.001) {
                    projectedFinish = GoalDateKey.addDays(today, ceil(remaining / rate).toInt())
                }
            }
        }

        return GoalStatsResult(
            today = today,
            startDate = startDate,
            endDate = endDate,
            byDay = byDay,
            byMonth = byMonth,
            byMonthPerMember = byMonthPerMember,
            byPerson = byPerson,
            total = round2(total),
            currentStreak = currentStreak,
            longestStreak = longestStreak,
            activeDays = activeDates.size,
            bestDay = bestDay,
            weekMax = weekMax,
            monthMax = monthMax,
            yearMax = yearMax,
            pace = pace,
            projectedFinish = projectedFinish,
        )
    }

    /** Two decimals, matching the iOS/web rounding so the three totals agree exactly. */
    private fun round2(v: Double): Double = (v * 100).roundToLong() / 100.0

    /** Whether two amounts read as the same number at display precision. */
    internal fun sameAmount(a: Double, b: Double): Boolean = abs(a - b) < 0.001
}
