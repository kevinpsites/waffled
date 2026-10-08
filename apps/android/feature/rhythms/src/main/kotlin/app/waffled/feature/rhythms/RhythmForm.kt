package app.waffled.feature.rhythms

import androidx.compose.runtime.Immutable
import app.waffled.core.model.WaffledDates
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * The state behind the new-rhythm sheet, as a plain value so its request bodies are
 * testable without a view. Port of iOS `RhythmForm`.
 *
 * Bodies are [JsonObject]s because `WaffledJson` omits nulls: a cleared emoji or booking
 * window has to reach the server as an explicit null, and an absent key means "leave it".
 */
@Immutable
data class RhythmForm(
    /** Null when creating; the rhythm's id when editing. */
    val editingId: String? = null,
    /** Fixed at creation — the server refuses to change a live rhythm's shape. */
    val shape: RhythmShape = RhythmShape.Completion,
    val title: String = "",
    val emoji: String = "",
    val notes: String = "",
    val personId: String? = null,
    val count: Int = 1,
    val unit: Unit = Unit.Weeks,
    /** Null means "follow the cadence" — see [effectiveLeadDays]. */
    val leadDays: Int? = null,
    /** Null means "one cadence out" — see [firstDue]. */
    val nextDue: LocalDate? = null,
    val startsOn: LocalDate = LocalDate.now(),
    val autoSchedule: Boolean = false,
    val monthlyMode: RhythmMonthlyMode = RhythmMonthlyMode.DayOfMonth,
    /** Which weekday a weekly rhythm lands on; empty follows the anchor. */
    val byday: List<String> = emptyList(),
    /** 1…5, or -1 for last; read only in [RhythmMonthlyMode.NthWeekday]. */
    val monthlyOrdinal: Int = 1,
    /** Days from each period's start a booking still counts, or null for the whole period. */
    val windowDays: Int? = null,
    val customRule: String = "",
) {
    enum class Unit(val wire: String) {
        Days("days"), Weeks("weeks"), Months("months"), Years("years");

        val label: String get() = wire
    }

    val trimmedTitle: String get() = title.trim()
    val isValid: Boolean get() = trimmedTitle.isNotEmpty()
    val every: String get() = "${maxOf(1, count)} ${unit.wire}"

    /**
     * The runway to send, in days. Follows the cadence (the server keeps
     * `least(leadTime, every / 2)`) until a number is typed, then sends that one as typed.
     */
    val effectiveLeadDays: Int
        get() = leadDays?.let { maxOf(0, it) } ?: minOf(14, RhythmFormat.days(every) / 2)

    /** One full cadence out, not today — otherwise every new rhythm arrives already late. */
    fun firstDue(today: LocalDate): LocalDate = nextDue ?: RhythmFormat.addCadence(today, every)

    /** Derived from the cadence so the generated event can't fall outside its period. */
    fun rrule(): String = RhythmRecurrence.buildRrule(
        interval = count, unit = unit, byday = byday, monthlyMode = monthlyMode,
        monthlyOrdinal = monthlyOrdinal, custom = customRule, start = startsOn,
    )

    /**
     * Where the PERIOD GRID is anchored. An auto-booked "nth weekday of the month" rhythm
     * snaps to the 1st: a calendar month holds exactly one nth weekday, while a grid
     * anchored on, say, the 19th would leave some periods holding none — unsatisfiable.
     */
    fun periodAnchor(): LocalDate {
        val snaps = shape == RhythmShape.Scheduling && autoSchedule &&
            unit == Unit.Months && monthlyMode == RhythmMonthlyMode.NthWeekday
        return if (snaps) startsOn.withDayOfMonth(1) else startsOn
    }

    /** Not offered with [autoSchedule] — the rule already picks the day, and the server refuses the pair. */
    val bookWithinInterval: String?
        get() {
            val d = windowDays ?: return null
            if (shape != RhythmShape.Scheduling || autoSchedule || d <= 0) return null
            return "$d days"
        }

    /**
     * A whole-cycle runway travels as the cadence itself, so Postgres does real calendar
     * arithmetic ("30 days" is a month only in a 30-day month).
     */
    val leadTimeToSend: String
        get() {
            val wholeCycle = shape == RhythmShape.Scheduling && bookWithinInterval == null &&
                effectiveLeadDays >= RhythmFormat.days(every)
            return if (wholeCycle) every else "$effectiveLeadDays days"
        }

    fun createBody(today: LocalDate, zone: ZoneId): JsonObject = buildJsonObject {
        common()
        put("satisfiedBy", JsonPrimitive(shape.wire))
        when (shape) {
            RhythmShape.Completion -> {
                // 09:00 on the day: a due date is a day, not the instant the sheet was open.
                val at = firstDue(today).atTime(LocalTime.of(9, 0)).atZone(zone).toInstant()
                put("nextDueAt", JsonPrimitive(RhythmFormat.isoInstant(at)))
            }
            RhythmShape.Scheduling -> {
                put("startsOn", JsonPrimitive(periodAnchor().toString()))
                put("autoSchedule", JsonPrimitive(autoSchedule))
                put("rrule", if (autoSchedule) JsonPrimitive(rrule()) else JsonNull)
                put("bookWithin", bookWithinInterval?.let(::JsonPrimitive) ?: JsonNull)
            }
            RhythmShape.Unknown -> {}
        }
    }

    /**
     * Only what the server lets change in place. Shape, anchor and rule are absent:
     * re-anchoring a live rhythm would re-read its skips and bookings. The window is
     * always sent, null included, because widening back has to be stated.
     */
    fun patchBody(): JsonObject = buildJsonObject {
        common()
        put("bookWithin", bookWithinInterval?.let(::JsonPrimitive) ?: JsonNull)
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.common() {
        put("title", JsonPrimitive(trimmedTitle))
        put("emoji", emoji.trim().ifEmpty { null }?.let(::JsonPrimitive) ?: JsonNull)
        put("notes", notes.trim().ifEmpty { null }?.let(::JsonPrimitive) ?: JsonNull)
        put("personId", personId?.let(::JsonPrimitive) ?: JsonNull)
        put("every", JsonPrimitive(every))
        put("leadTime", JsonPrimitive(leadTimeToSend))
    }

    companion object {
        /** Seed from an existing rhythm; the cadence round-trips through the interval parser. */
        fun editing(r: RhythmsApi.Rhythm, zone: ZoneId): RhythmForm {
            val (count, unit) = cadence(r.every)
            return RhythmForm(
                editingId = r.id,
                shape = r.shape,
                title = r.title,
                emoji = r.emoji.orEmpty(),
                notes = r.notes.orEmpty(),
                personId = r.personId,
                count = count,
                unit = unit,
                leadDays = RhythmFormat.days(r.leadTime),
                nextDue = WaffledDates.parseInstant(r.nextDueAt, zone)?.let { WaffledDates.localDay(it, zone) },
                startsOn = r.startsOn?.let(RhythmFormat::parseDay) ?: LocalDate.now(zone),
                autoSchedule = r.autoSchedule,
                customRule = r.rrule.orEmpty(),
                windowDays = r.bookWithin?.let(RhythmFormat::days),
            )
        }

        /** "7 days" → (1, Weeks); "3 mons" → (3, Months). */
        fun cadence(every: String): Pair<Int, Unit> {
            val p = RhythmFormat.parts(every)
            return when {
                p.year > 0 -> p.year to Unit.Years
                p.month > 0 -> p.month to Unit.Months
                p.week > 0 -> p.week to Unit.Weeks
                p.day > 0 -> if (p.day % 7 == 0) (p.day / 7) to Unit.Weeks else p.day to Unit.Days
                else -> 1 to Unit.Weeks
            }
        }
    }
}
