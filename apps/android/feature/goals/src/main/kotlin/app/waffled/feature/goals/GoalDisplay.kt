package app.waffled.feature.goals

import kotlin.math.min

/**
 * A goal that can be rendered — the fields every goal surface needs to pick its number.
 * Both the list [GoalsApi.Goal] and the full [GoalsApi.GoalDetail] implement it, so one
 * helper serves both.
 */
interface GoalDisplayable {
    val goalType: String
    val unit: String?
    val target: Double?
    val totalProgress: Double
    val habitPeriod: String?
    val habitTargetPerPeriod: Int?
    val periodDone: Double?
    val stepTotal: Int?
    val stepDone: Int?
    val streakDays: Int
    val targetBasis: String?
    val participantCount: Int
    val loggedTodayBy: List<String>?
}

/**
 * Which number a goal shows, and what it is measured against — the Kotlin twin of the
 * iOS `GoalDisplay` and web `goalDisplayProgress` / `goalDisplayTarget` / `goalFraction`.
 *
 * A **habit** shows completions in the CURRENT period against its cadence, a **checklist**
 * shows steps, everything else the cumulative amount against its target. Every goal view
 * reads through here; inlining `totalProgress` in a view is what this exists to prevent.
 */
object GoalDisplay {

    /**
     * Never falls back to the lifetime total for a habit: on an older payload with no
     * `periodDone` that would be exactly the wrong number, and 0 makes the staleness visible.
     */
    fun progress(g: GoalDisplayable): Double = when (g.goalType) {
        "habit" -> g.periodDone ?: 0.0
        "checklist" -> (g.stepDone ?: 0).toDouble()
        else -> g.totalProgress
    }

    /** The cadence for a habit, the step count for a checklist, the target otherwise. */
    fun target(g: GoalDisplayable): Double? = when (g.goalType) {
        "habit" -> g.habitTargetPerPeriod?.toDouble() ?: g.target
        "checklist" -> (g.stepTotal ?: 0).takeIf { it > 0 }?.toDouble()
        else -> {
            // A per_person target is stated PER member ("12 books each"), so the pooled
            // progress is measured against it × the members.
            val t = g.target
            if (g.targetBasis == "per_person" && t != null) t * maxOf(1, g.participantCount) else t
        }
    }

    /**
     * An each-tracks spotlight's TOGETHER target: everyone's own targets summed, else the
     * goal's. Paired with the pooled lifetime total, never with a period count.
     */
    fun pooledTarget(g: GoalsApi.Goal): Double? {
        val summed = g.participants.sumOf { it.target ?: 0.0 }
        return if (summed > 0) summed else g.target
    }

    /** 0…1, clamped; 0 when there is no positive target so a ring never renders NaN. */
    fun fraction(g: GoalDisplayable): Double {
        val t = target(g)?.takeIf { it > 0 } ?: return 0.0
        return min(progress(g) / t, 1.0)
    }

    /** "today" / "this week" / "this month" for a habit; null for every other type. */
    fun periodLabel(g: GoalDisplayable): String? {
        if (g.goalType != "habit") return null
        return when (g.habitPeriod) {
            "day" -> "today"
            "month" -> "this month"
            else -> "this week"
        }
    }

    /**
     * The value a milestone threshold is measured against — the SAME axis the server used
     * to decide `reached`: streak days for a habit, percent complete for a checklist, the
     * cumulative total otherwise.
     */
    fun milestoneAxis(g: GoalDisplayable): Double = when (g.goalType) {
        "habit" -> g.streakDays.toDouble()
        "checklist" -> {
            val total = g.stepTotal ?: 0
            if (total > 0) (g.stepDone ?: 0).toDouble() / total * 100 else 0.0
        }
        else -> g.totalProgress
    }

    /** "4-day streak to go", "15% to go", "188 to go". Never negative. */
    fun milestoneToGo(g: GoalDisplayable, threshold: Double, fmt: (Double?) -> String): String {
        val toGo = maxOf(0.0, threshold - milestoneAxis(g))
        return when (g.goalType) {
            "habit" -> "${fmt(toGo)}-day streak to go"
            "checklist" -> "${kotlin.math.ceil(toGo).toInt()}% to go"
            else -> "${fmt(toGo)} to go"
        }
    }

    /**
     * Whether a habit is already marked done today for everyone in [who] (person ids plus
     * the `__family__` sentinel). The server silently skips a same-day duplicate, so the
     * Log sheet says so first. Nobody picked, a non-habit, or a response too old to carry
     * the field gates nothing. [loggedTodayBy] overrides the goal's possibly stale list.
     */
    fun doneToday(g: GoalDisplayable, who: Set<String>, loggedTodayBy: List<String>? = null): Boolean {
        if (g.goalType != "habit" || who.isEmpty()) return false
        val logged = (loggedTodayBy ?: g.loggedTodayBy)?.toSet() ?: return false
        return who.all { it in logged }
    }

    /** Who a log is credited to, in `loggedTodayBy` terms: no participants means the family row. */
    fun logWho(g: GoalDisplayable, picked: Set<String>): Set<String> =
        if (g.participantCount == 0 && picked.isEmpty()) setOf(FAMILY) else picked

    /** The Log sheet's habit gate: done today for the picks, AND the entry is dated today. */
    fun blockedToday(
        g: GoalDisplayable,
        picked: Set<String>,
        fresh: List<String>?,
        loggedOn: java.time.LocalDate,
        today: java.time.LocalDate,
    ): Boolean = loggedOn == today && doneToday(g, logWho(g, picked), fresh)

    fun habitConfirmLabel(doneToday: Boolean): String =
        if (doneToday) "Already submitted today ✓" else "Mark done for today"

    private const val FAMILY = "__family__"

    /** "of 5 this week" for a habit, "of 5 steps" for a checklist, "of 1,000 miles" otherwise. */
    fun targetCaption(g: GoalDisplayable, unit: String?, fmt: (Double?) -> String): String {
        val base = "of ${fmt(target(g))}"
        periodLabel(g)?.let { return "$base $it" }
        if (g.goalType == "checklist") return "$base steps"
        return base + unit?.let { " $it" }.orEmpty()
    }
}
