package app.waffled.feature.today

import app.waffled.core.model.WaffledDates
import app.waffled.core.network.RestState
import app.waffled.core.sync.SyncedEvent
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/**
 * Today's display strings, kept out of the composables.
 *
 * Two reasons, both inherited from iOS: date math in a render path is one of the two
 * documented jank sources, and a string rule with three branches deserves a test rather
 * than a screenshot. Every entry point takes the **household's** zone — a phone that has
 * travelled still reads home.
 */
object TodayFormat {

    /** "Good morning" / "Good afternoon" / "Good evening", on the household's clock. */
    fun greeting(now: Instant, zone: ZoneId): String =
        when (now.atZone(zone).hour) {
            in 5..11 -> "Good morning"
            in 12..16 -> "Good afternoon"
            else -> "Good evening"
        }

    /** "Thursday, Jul 16" — the small line above the greeting. */
    fun dateLine(now: Instant, zone: ZoneId, locale: Locale = Locale.getDefault()): String =
        WaffledDates.format(now, "EEEE, MMM d", zone, locale)

    /** The temperature chip beside the date, or null when the household has no location. */
    fun weatherChip(weather: TodayApi.Weather?): String? {
        val w = weather?.takeIf { it.configured } ?: return null
        val temp = w.tempF ?: return null
        return "${w.emoji.orEmpty()} ${Math.round(temp)}°".trim()
    }

    /**
     * Tonight's supporting line: dish count, cook time, servings — or the eating-out note.
     *
     * The dish count matters: a plate carries no single cook time, so without it the card
     * reads as a bare name.
     */
    fun mealSubtitle(meal: TonightMeal): String? {
        if (meal.eatingOut) return "No cooking tonight 🎉"
        val parts = buildList {
            if (meal.dishCount > 0) add("${meal.dishCount} ${if (meal.dishCount == 1) "dish" else "dishes"}")
            meal.cookTimeMinutes?.let { add("🕐 $it min") }
            meal.servings?.let { add("serves $it") }
        }
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    fun eventCount(count: Int): String = "$count event${if (count == 1) "" else "s"}"

    fun groceryUnit(count: Int): String = if (count == 1) "item to buy" else "items to buy"

    /** An agenda row's time: "All day", a local start time, or blank when unparseable. */
    fun eventTime(
        event: SyncedEvent,
        zone: ZoneId,
        locale: Locale = Locale.getDefault(),
    ): String {
        if (event.allDay) return "All day"
        val at = WaffledDates.parseInstant(event.startsAt, zone) ?: return ""
        return WaffledDates.format(at, "h:mm a", zone, locale)
    }

    /**
     * Today's agenda rows.
     *
     * An O(1) read out of the map `SyncManager` already filtered (per viewer) and bucketed
     * (in the household's zone). The screen must never re-filter or re-bucket — that work
     * is precomputed once per data change precisely so a render pass doesn't repeat it.
     */
    fun eventsOn(
        byDay: Map<LocalDate, List<SyncedEvent>>,
        day: LocalDate,
    ): List<SyncedEvent> = byDay[day].orEmpty()

    /**
     * A card's copy when it has nothing to show. Domain empty copy ("No chores today") is
     * only true on an authoritative answer; a failure must never read as empty.
     */
    fun unavailableCopy(state: RestState, empty: String): String = when {
        state.isAuthoritative -> empty
        state == RestState.Loading -> "Loading…"
        else -> "Unavailable"
    }
}
