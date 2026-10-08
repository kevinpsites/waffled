package app.waffled.feature.planning

import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.WeeklyPlanningView
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * One act of the agenda and its steps. Consecutive runs only, so two separated runs can
 * share an act name — hence [id] includes the first step's key.
 */
data class PlanningActGroup(val act: String, val steps: List<PlanningStep>) {
    val id: String get() = act + "\u0001" + (steps.firstOrNull()?.key ?: "")
}

/**
 * Weekly Planning's pure functions — no view, no network, no clock. Port of iOS
 * `PlanningFormat.swift` (itself from the web's `weeklyPlanning.ts`): two platforms each
 * deciding "which step is on screen" is how a resumed session lands somewhere else.
 *
 * `weekStart` is a household-local `YYYY-MM-DD` and is never turned into an instant: it is
 * handled as a calendar date, so no zone or DST shift can move it.
 */
object PlanningFormat {

    fun availableSteps(steps: List<PlanningStep>): List<PlanningStep> = steps.filter { it.available }

    fun stepsByAct(steps: List<PlanningStep>): List<PlanningActGroup> {
        val out = mutableListOf<PlanningActGroup>()
        for (s in availableSteps(steps)) {
            val last = out.lastOrNull()
            if (last != null && last.act == s.act) {
                out[out.lastIndex] = last.copy(steps = last.steps + s)
            } else {
                out += PlanningActGroup(s.act, listOf(s))
            }
        }
        return out
    }

    /**
     * The step asked for, then the session's own pointer (so another device resumes here),
     * then the first runnable step — every branch falls through so an unavailable key can
     * never strand the session on a blank screen.
     */
    fun resolveCurrent(view: WeeklyPlanningView?, asked: String? = null): PlanningStep? {
        if (view == null) return null
        val avail = availableSteps(view.steps)
        if (avail.isEmpty()) return null
        return avail.firstOrNull { it.key == asked }
            ?: avail.firstOrNull { it.key == view.session?.currentStep }
            ?: avail.first()
    }

    fun nextStepAfter(steps: List<PlanningStep>, key: String): PlanningStep? {
        val avail = availableSteps(steps)
        val i = avail.indexOfFirst { it.key == key }
        return if (i >= 0 && i + 1 < avail.size) avail[i + 1] else null
    }

    fun addWeeks(iso: String, n: Int): String =
        parseDay(iso)?.plusWeeks(n.toLong())?.toString() ?: iso

    private val dayNames = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

    fun planningDayName(dow: Int): String = dayNames[((dow % 7) + 7) % 7]

    /** "6 Sun – 12 Sat". */
    fun weekLabel(iso: String, locale: Locale = Locale.getDefault()): String {
        val start = parseDay(iso) ?: return iso
        val end = start.plusDays(6)
        val dow = DateTimeFormatter.ofPattern("EEE", locale)
        return "${start.dayOfMonth} ${start.format(dow)} – ${end.dayOfMonth} ${end.format(dow)}"
    }

    /**
     * 1-based position among the RUNNABLE steps, and their count — the "2 of 9" counter.
     * Never `step.number`: that is a catalog index and skips an unavailable step.
     */
    fun position(steps: List<PlanningStep>, currentKey: String?): Pair<Int, Int> {
        val avail = availableSteps(steps)
        val i = avail.indexOfFirst { it.key == currentKey }
        return (if (i >= 0) i + 1 else 0) to avail.size
    }

    /**
     * The 2dp progress hair, positional to match the web — deliberately not "how many are
     * settled", which diverges as soon as somebody jumps ahead.
     */
    fun hairFraction(steps: List<PlanningStep>, currentKey: String?): Double {
        val (pos, total) = position(steps, currentKey)
        return if (total > 0) pos.toDouble() / total else 0.0
    }

    /** How much of the session has been answered (a skip counts), for summaries. */
    fun settledFraction(steps: List<PlanningStep>): Double {
        val avail = availableSteps(steps)
        if (avail.isEmpty()) return 0.0
        return avail.count { it.isSettled }.toDouble() / avail.size
    }

    internal fun parseDay(iso: String): LocalDate? = runCatching { LocalDate.parse(iso) }.getOrNull()
}
