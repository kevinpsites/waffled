package app.waffled.feature.rhythms

import androidx.compose.runtime.Immutable
import app.waffled.core.model.WaffledDates
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Rhythms — the things that should keep happening. Port of iOS `Rhythms.swift`
 * (`RhythmFormat`, `RhythmAttention`, `RhythmBand`); see `docs/product/rhythms-plan.md`.
 *
 * Copy rule: a scheduling rhythm is satisfied by an event existing for the period, so
 * nothing here says "streak", "completed" or "on track" about it.
 *
 * Pure and zone-injected so the model precomputes every line once per load.
 */
object RhythmFormat {

    /** English month names: this copy is English, and a device locale must not mix them. */
    private val LOCALE: Locale = Locale.US

    data class Parts(
        val year: Int = 0,
        val month: Int = 0,
        val week: Int = 0,
        val day: Int = 0,
        val hour: Int = 0,
        val minute: Int = 0,
    )

    /** Tokenize Postgres interval text ("3 mons", "3 days 12:00:00"). */
    fun parts(text: String): Parts {
        var year = 0; var month = 0; var week = 0; var day = 0; var hour = 0; var minute = 0
        var pending: Int? = null
        for (token in text.split(' ', '\t').filter { it.isNotEmpty() }) {
            if (token.contains(':')) {
                val clock = token.split(':')
                val h = clock.getOrNull(0)?.toIntOrNull()
                val m = clock.getOrNull(1)?.toIntOrNull()
                if (clock.size >= 2 && h != null && m != null) {
                    hour += h
                    minute += m
                }
                continue
            }
            val number = token.toIntOrNull()
            if (number != null) {
                pending = number
                continue
            }
            val n = pending ?: continue
            val unit = token.lowercase()
            when {
                unit.startsWith("year") || unit.startsWith("yr") -> year += n
                unit.startsWith("mon") -> month += n
                unit.startsWith("week") -> week += n
                unit.startsWith("day") -> day += n
                unit.startsWith("hour") || unit.startsWith("hr") -> hour += n
                unit.startsWith("min") -> minute += n
            }
            pending = null
        }
        return Parts(year, month, week, day, hour, minute)
    }

    fun plural(n: Int, unit: String): String = "$n $unit${if (abs(n) == 1) "" else "s"}"

    /** "3 mons" → "3 months"; "7 days" → "1 week"; "3 days 12:00:00" → "3 days 12 hours". */
    fun formatInterval(text: String): String {
        val p = parts(text)
        val out = mutableListOf<String>()
        if (p.year != 0) out += plural(p.year, "year")
        if (p.month != 0) out += plural(p.month, "month")
        var weeks = p.week
        var days = p.day
        if (days != 0 && days % 7 == 0) {
            weeks += days / 7
            days = 0
        }
        if (weeks != 0) out += plural(weeks, "week")
        if (days != 0) out += plural(days, "day")
        if (p.hour != 0) out += plural(p.hour, "hour")
        if (p.minute != 0) out += plural(p.minute, "minute")
        return out.joinToString(" ")
    }

    /** "7 days" → "every week"; "3 mons" → "every 3 months". */
    fun cadenceLabel(every: String): String {
        val text = formatInterval(every)
        if (text.isEmpty()) return ""
        val words = text.split(' ')
        if (words.size == 2 && words[0] == "1") return "every ${words[1]}"
        return "every $text"
    }

    /** Whole calendar days from [now]'s day to [target]'s day, on the viewer's clock. */
    fun dayDiff(target: Instant, now: Instant, zone: ZoneId): Int =
        ChronoUnit.DAYS.between(WaffledDates.localDay(now, zone), WaffledDates.localDay(target, zone)).toInt()

    /** The completion shape's status line — "late", never "missed". */
    fun dueLabel(dueAt: String, overdue: Boolean, now: Instant, zone: ZoneId): String {
        val target = WaffledDates.parseInstant(dueAt, zone) ?: return if (overdue) "overdue" else "due"
        val days = dayDiff(target, now, zone)
        if (overdue || days < 0) return "${plural(maxOf(1, -days), "day")} late"
        if (days == 0) return "due today"
        if (days == 1) return "due tomorrow"
        return "in ${plural(days, "day")}"
    }

    /** The scheduling shape's status line — about the booking window, never follow-through. */
    fun periodLabel(periodEnd: String, now: Instant, zone: ZoneId): String {
        val target = parseDay(periodEnd) ?: return ""
        val days = ChronoUnit.DAYS.between(WaffledDates.localDay(now, zone), target).toInt()
        if (days < 0) return "this period has ended"
        if (days == 0) return "this period ends today"
        return "${plural(days, "day")} left to book it"
    }

    /** `periodEnd` is the EXCLUSIVE next boundary, so the last bookable day is the one before. */
    fun lastDayOfPeriod(periodEnd: String): String =
        parseDay(periodEnd)?.minusDays(1)?.toString() ?: periodEnd

    /** Whether a completion rhythm was already done today — what lets a row acknowledge a tap. */
    fun wasCompletedToday(iso: String?, now: Instant, zone: ZoneId): Boolean {
        val done = WaffledDates.parseInstant(iso, zone) ?: return false
        return WaffledDates.localDay(done, zone) == WaffledDates.localDay(now, zone)
    }

    /** Three states, three labels — a shared label is what made the tap invisible. */
    fun completionAction(doneToday: Boolean, due: Boolean): String = when {
        doneToday -> "Done today ✓"
        due -> "I did it"
        else -> "I did it today"
    }

    data class NudgePlan(val effectiveDays: Int, val capped: Boolean)

    /**
     * What the nudge runway will actually be once the server clamps it. A scheduling
     * rhythm's ceiling is the whole cycle (or its booking window); a completion rhythm's
     * is half the cycle, because its feed keeps asking however late it is.
     */
    fun nudgePlan(
        every: String,
        leadDays: Int,
        satisfiedBy: RhythmShape = RhythmShape.Completion,
        bookWithin: String? = null,
    ): NudgePlan {
        val asked = maxOf(0, leadDays)
        val cycle = days(every)
        val cap = if (satisfiedBy == RhythmShape.Scheduling) bookWithin?.let(::days) ?: cycle else cycle / 2
        // An unreadable cadence gives no cap — echoing the request beats inventing a clamp.
        if (cap <= 0) return NudgePlan(asked, false)
        return NudgePlan(minOf(asked, cap), asked > cap)
    }

    /** One cadence on; `plusMonths` clamps Jan 31 + 1 month to Feb 28 rather than spilling. */
    fun addCadence(from: LocalDate, every: String): LocalDate {
        val p = parts(every)
        if (p.year == 0 && p.month == 0 && p.week == 0 && p.day == 0) return from
        return from.plusYears(p.year.toLong()).plusMonths(p.month.toLong())
            .plusDays((p.week * 7 + p.day).toLong())
    }

    data class Consequence(val landsOn: LocalDate, val nudgeFrom: LocalDate, val capped: Boolean)

    /**
     * The two dates a new rhythm promises, via [nudgePlan] rather than the typed runway.
     * A booking rhythm's anchor starts the period grid, so its first window closes one
     * cadence later; a completion rhythm's anchor IS the due date.
     */
    fun consequence(
        shape: RhythmShape,
        every: String,
        leadDays: Int,
        anchor: LocalDate,
        bookWithin: String? = null,
    ): Consequence {
        val plan = nudgePlan(every, leadDays, shape, bookWithin)
        val landsOn = if (shape == RhythmShape.Scheduling) addCadence(anchor, every) else anchor
        return Consequence(landsOn, landsOn.minusDays(plan.effectiveDays.toLong()), plan.capped)
    }

    const val PUSH_DAYS = 7L

    /**
     * "Push it out a week", counted from the later of today and the due date: a late
     * rhythm pushed from its own due date would come back almost at once, and an early
     * one should keep the shape of its schedule.
     */
    fun pushOut(nextDueAt: String?, now: Instant, zone: ZoneId): Instant? {
        val due = nextDueAt?.let { moment(it, zone) } ?: return null
        return maxOf(due, now).atZone(zone).plusDays(PUSH_DAYS).toInstant()
    }

    /** The clamp, stated next to the promise it modifies — or null when nothing was trimmed. */
    fun capNote(
        every: String,
        leadDays: Int,
        satisfiedBy: RhythmShape = RhythmShape.Completion,
        bookWithin: String? = null,
    ): String? {
        val plan = nudgePlan(every, leadDays, satisfiedBy, bookWithin)
        if (!plan.capped) return null
        val window = if (bookWithin != null) "that booking window" else cadenceLabel(every).replace("every ", "a ")
        return "${plural(maxOf(0, leadDays), "day")}’ notice won’t fit in $window, so it’s trimmed" +
            " to ${plan.effectiveDays} — a runway longer than the stretch it belongs to never goes quiet."
    }

    /** "November 19" — inside a sentence, where the year is noise. */
    fun dayMonth(date: LocalDate): String =
        java.time.format.DateTimeFormatter.ofPattern("MMMM d", LOCALE).format(date)

    /** The runway in a sentence, naming the window it counts back from. Booking rhythms only. */
    fun nudgeExplainer(every: String, leadDays: Int, bookWithin: String? = null): String {
        val plan = nudgePlan(every, leadDays, RhythmShape.Scheduling, bookWithin)
        val cadence = cadenceLabel(every)
        val window = cadence.ifEmpty { "every period" }
        val span = bookWithin?.let(::days) ?: days(every)
        val tail = when {
            plan.effectiveDays <= 0 -> "on its last day"
            span > 0 && plan.effectiveDays >= span -> "from its first day"
            else -> "for the last ${plural(plan.effectiveDays, "day")} of it"
        }
        var line = "A fresh window to book it opens $window. You’ll be nudged $tail, and only while nothing’s on the calendar for it"
        if (plan.capped) {
            val fits = if (bookWithin != null) "that window" else window.replace("every ", "a ")
            line += " (${plural(maxOf(0, leadDays), "day")} won’t fit in $fits, so it’s trimmed to " +
                "${plural(plan.effectiveDays, "day")} — a runway longer than the stretch it belongs to never goes quiet)"
        }
        return "$line."
    }

    // ---- banding by when, not by kind ----

    /** A flat fortnight: this band is a horizon for someone who opened the page on purpose. */
    const val COMING_UP_DAYS = 14

    enum class Urgency { Now, Soon, Steady, Paused }

    /** A calendar date (`yyyy-MM-dd`) reads as local midnight; an instant stands as it is. */
    fun moment(value: String, zone: ZoneId): Instant? =
        if (value.length == 10) parseDay(value)?.atStartOfDay(zone)?.toInstant() else WaffledDates.parseInstant(value, zone)

    /**
     * Whole days until what this rhythm counts towards — its due date, or the day its
     * booking WINDOW closes. Negative means already past.
     */
    fun daysToGo(r: RhythmsApi.Rhythm, now: Instant, zone: ZoneId): Int? {
        val target = if (r.shape == RhythmShape.Scheduling) r.windowEnd else r.nextDueAt
        val date = target?.let { moment(it, zone) } ?: return null
        return dayDiff(date, now, zone)
    }

    /**
     * "Needs you now" is the server's own `/attention` list, so this screen and the Today
     * card can't disagree; the one local addition is an overdue date.
     */
    fun urgency(r: RhythmsApi.Rhythm, attention: RhythmsApi.AttentionItem?, now: Instant, zone: ZoneId): Urgency {
        if (!r.isActive) return Urgency.Paused
        if (attention != null) return Urgency.Now
        if (r.shape == RhythmShape.Scheduling && r.satisfied == true) return Urgency.Steady
        val days = daysToGo(r, now, zone) ?: return Urgency.Steady
        if (days < 0) return Urgency.Now
        return if (days <= COMING_UP_DAYS) Urgency.Soon else Urgency.Steady
    }

    /** The row's anchor. [tone] is carried from the band, never re-read from the copy. */
    @Immutable
    data class Countdown(val number: String, val unit: String, val tone: Tone) {
        enum class Tone { Late, Near, Soft, Done }
    }

    /** When the booking is; an all-day booking stops at the date (it sits at local midnight). */
    fun bookedWhen(bookedAt: String, allDay: Boolean, zone: ZoneId): String {
        val d = WaffledDates.parseInstant(bookedAt, zone) ?: return "this period"
        val date = WaffledDates.format(d, "MMM d", zone, LOCALE)
        return if (allDay) date else "$date, ${WaffledDates.format(d, "h:mm a", zone, LOCALE)}"
    }

    /** Days collapse into weeks and then months past a fortnight — the size of the wait matters, not its length. */
    fun countdown(r: RhythmsApi.Rhythm, urgency: Urgency, now: Instant, zone: ZoneId): Countdown? {
        if (r.shape == RhythmShape.Scheduling && r.satisfied == true) {
            // A skip settles a period without a time, so it must not claim "Booked".
            val at = r.bookedAt ?: return Countdown("Handled", "this period", Countdown.Tone.Done)
            return Countdown("Booked", bookedWhen(at, r.bookedAllDay ?: false, zone), Countdown.Tone.Done)
        }
        val days = daysToGo(r, now, zone) ?: return null
        val tone = when (urgency) {
            Urgency.Now -> Countdown.Tone.Late
            Urgency.Soon -> Countdown.Tone.Near
            else -> Countdown.Tone.Soft
        }
        if (r.shape == RhythmShape.Scheduling) {
            if (days <= 0) return Countdown("Today", "last day", tone)
            return Countdown("$days", if (days == 1) "day left" else "days left", tone)
        }
        if (days < 0) {
            val late = -days
            return Countdown("$late", if (late == 1) "day late" else "days late", tone)
        }
        if (days == 0) return Countdown("Today", "due", tone)
        if (days <= 13) return Countdown("$days", if (days == 1) "day" else "days", tone)
        if (days < 60) {
            val weeks = (days / 7.0).roundToInt()
            return Countdown("$weeks", if (weeks == 1) "week" else "weeks", tone)
        }
        val months = (days / 30.0).roundToInt()
        return Countdown("$months", if (months == 1) "month" else "months", tone)
    }

    /**
     * How much of the current cycle is spent, 0–100, or null when there is no window to
     * measure (no due date, or a backdated completion that inverts the window).
     */
    fun periodProgress(r: RhythmsApi.Rhythm, now: Instant, zone: ZoneId): Int? {
        val start: Instant
        val end: Instant
        if (r.shape == RhythmShape.Scheduling) {
            // Fills toward where bookings stop counting, not the next boundary.
            start = r.currentPeriodStart?.let { moment(it, zone) } ?: return null
            end = r.windowEnd?.let { moment(it, zone) } ?: return null
        } else {
            end = r.nextDueAt?.let { moment(it, zone) } ?: return null
            start = r.lastCompletedAt?.let { moment(it, zone) }
                ?: end.minusSeconds(days(r.every) * 86_400L)
        }
        val total = (end.toEpochMilli() - start.toEpochMilli()).toDouble()
        if (total <= 0) return null
        val spent = (now.toEpochMilli() - start.toEpochMilli()) / total * 100
        return spent.roundToInt().coerceIn(0, 100)
    }

    /** Whole days in a Postgres interval, carrying a 24h+ clock tail into days. */
    fun days(text: String): Int {
        val p = parts(text)
        return p.year * 365 + p.month * 30 + p.week * 7 + p.day + p.hour / 24
    }

    /** "May 20, 2026" for a stored instant or date, "—" when there isn't one. */
    fun shortDate(iso: String?, zone: ZoneId): String {
        if (iso.isNullOrEmpty()) return "—"
        val instant = moment(iso, zone) ?: return "—"
        return WaffledDates.format(instant, "MMM d, yyyy", zone, LOCALE)
    }

    fun shortDate(date: LocalDate): String =
        java.time.format.DateTimeFormatter.ofPattern("MMM d, yyyy", LOCALE).format(date)

    fun ymd(instant: Instant, zone: ZoneId): String = WaffledDates.localDay(instant, zone).toString()

    /** "every 3 months" → "Every 3 months". */
    fun sentence(text: String): String =
        if (text.isEmpty()) text else text.substring(0, 1).uppercase() + text.substring(1)

    /** Every write sends an explicit instant, never a wall-clock string. */
    fun isoInstant(instant: Instant): String = instant.truncatedTo(ChronoUnit.SECONDS).toString()

    internal fun parseDay(value: String): LocalDate? = runCatching { LocalDate.parse(value.trim()) }.getOrNull()
}

/** Overdue first, then due, then needs-booking; ties by title so the order is stable. */
object RhythmAttention {
    fun rank(item: RhythmsApi.AttentionItem): Int = when (item.kind) {
        AttentionKind.Due -> if (item.overdue == true) 0 else 1
        AttentionKind.Unscheduled -> 2
        AttentionKind.Unknown -> 3
    }

    fun sorted(items: List<RhythmsApi.AttentionItem>): List<RhythmsApi.AttentionItem> =
        items.sortedWith(compareBy<RhythmsApi.AttentionItem> { rank(it) }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.rhythm.title })
}

/** One band of the register. */
@Immutable
data class RhythmBand(
    val urgency: RhythmFormat.Urgency,
    val title: String,
    val hint: String,
    val rhythms: List<RhythmsApi.Rhythm>,
) {
    companion object {
        val ORDER: List<Triple<RhythmFormat.Urgency, String, String>> = listOf(
            Triple(RhythmFormat.Urgency.Now, "Needs you now", "late, or the window is closing"),
            Triple(RhythmFormat.Urgency.Soon, "Coming up", "the next two weeks"),
            Triple(RhythmFormat.Urgency.Steady, "Steady", "nothing to do yet"),
        )
    }
}
