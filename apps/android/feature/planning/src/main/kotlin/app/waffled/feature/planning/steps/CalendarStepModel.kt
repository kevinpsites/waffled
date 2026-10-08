package app.waffled.feature.planning.steps

import androidx.compose.runtime.Immutable
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.planning.PlanningFormat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

// Weekly Planning · step 2 "Calendar" — the week's arithmetic and the count it keeps. Port
// of iOS `CalendarStepModel.swift`. No network: the week is the real calendar and adding is
// the calendar's own sheet. Every day is `weekStart` plus 0…6 on calendar labels, so no
// device zone or DST shift can move a day.

/** One day of the planned week, resolved once per week rather than per render. */
@Immutable
data class PlanningWeekDay(
    /** `YYYY-MM-DD`, household-local. */
    val key: String,
    val dow: String,
    val full: String,
    val date: String,
    val isToday: Boolean,
) {
    val day: LocalDate get() = LocalDate.parse(key)
}

object PlanningWeekDays {

    /** A day shows this many events before collapsing behind "+N more": busy weeks stay one screen. */
    const val ROW_MAX = 4

    private val monthOut = DateTimeFormatter.ofPattern("MMM", Locale.US)

    /** [todayKey] is passed in so nothing here reads a clock. */
    fun days(weekStart: String, todayKey: String): List<PlanningWeekDay> {
        val start = parse(weekStart) ?: return emptyList()
        return (0L until 7L).map { i ->
            val d = start.plusDays(i)
            val key = d.toString()
            val dow = d.dayOfWeek.value % 7
            PlanningWeekDay(
                key = key,
                dow = SHORT[dow].uppercase(Locale.US),
                full = PlanningFormat.planningDayName(dow),
                date = monthDay(d),
                isToday = key == todayKey,
            )
        }
    }

    /** "Sep 6 – 12", and "Sep 27 – Oct 3" when the week straddles a month. */
    fun weekRangeLabel(weekStart: String): String {
        val a = parse(weekStart) ?: return weekStart
        val b = a.plusDays(6)
        val right = if (a.month == b.month) "${b.dayOfMonth}" else monthDay(b)
        return "${monthDay(a)} – $right"
    }

    /** "Sunday, Thursday and Friday". */
    fun names(list: List<String>): String {
        if (list.size <= 1) return list.firstOrNull().orEmpty()
        return "${list.dropLast(1).joinToString(", ")} and ${list.last()}"
    }

    /** Each event counted once: the day index files a multi-day event under every day it covers. */
    fun eventCount(days: List<PlanningWeekDay>, byDay: Map<LocalDate, List<SyncedEvent>>): Int =
        days.flatMap { byDay[it.day].orEmpty() }.mapTo(HashSet()) { it.id }.size

    /** The open days are the point of the step, so they are named, not counted. */
    fun summary(total: Int, openDays: List<String>): String {
        val count = when (total) {
            0 -> "Nothing on the week yet"
            1 -> "1 event"
            else -> "$total events"
        }
        val open = when {
            openDays.isEmpty() -> "every day has something"
            openDays.size == 7 -> "every day is still open"
            else -> "${names(openDays)} ${if (openDays.size == 1) "is" else "are"} still open"
        }
        return "$count · $open"
    }

    fun addDays(iso: String, n: Int): String = parse(iso)?.plusDays(n.toLong())?.toString() ?: iso

    /** 0 = Sunday … 6 = Saturday. */
    fun dayOfWeek(iso: String): Int = parse(iso)?.let { it.dayOfWeek.value % 7 } ?: 0

    fun monthDay(iso: String): String = parse(iso)?.let(::monthDay) ?: iso

    private fun monthDay(d: LocalDate): String = "${d.format(monthOut)} ${d.dayOfMonth}"

    private fun parse(iso: String): LocalDate? = runCatching { LocalDate.parse(iso) }.getOrNull()

    private val SHORT = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
}

/** What the shared event sheet is opening on: a day to add to, or an event to edit. */
class PlanningCalendarComposer(
    val day: LocalDate,
    val prefillTitle: String?,
    val event: SyncedEvent? = null,
    /** The banner's completion when the "sent here" box opened this; null for the step's own ＋. */
    val done: ((Boolean) -> Unit)? = null,
) {
    /** The crumb counts additions; editing an event already on the week is not one. */
    val countsAsAdded: Boolean get() = event == null

    /** The title a NEW event opens with; an edit keeps its own. */
    val sheetTitle: String? get() = if (event == null) prefillTitle?.trim()?.takeIf { it.isNotEmpty() } else null
}

/** Only ever a COUNT: the recap reads through to the calendar, so a copied title could disagree with it. */
class PlanningCalendarModel {
    private val _added = MutableStateFlow(0)
    val added: StateFlow<Int> = _added.asStateFlow()

    val decisionData: JsonObject get() = JsonObject(mapOf("added" to JsonPrimitive(_added.value)))

    fun recordEventAdded() {
        _added.value += 1
    }
}
