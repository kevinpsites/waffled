package app.waffled.feature.calendar

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Calendar countdowns — "N days until X" from three sources (a flagged event, a standalone
 * item, or a member's next birthday), merged + sorted server-side by `GET /api/countdowns`.
 *
 * A core Calendar feature, never gated by a module toggle. Surfaced as a Today card, as
 * month-grid badges, and as an "is countdown" toggle in the event editor. Only STANDALONE
 * items are editable here; events and birthdays are managed at their source.
 *
 * Ported from `apps/ios/.../Calendar/Countdowns.swift`.
 */
object CountdownFormat {

    /** The card wording (honours the household "sleeps" setting). */
    fun label(daysLeft: Int, sleeps: Boolean): String = when {
        daysLeft <= 0 -> "Today!"
        daysLeft == 1 -> if (sleeps) "1 sleep" else "Tomorrow"
        else -> "$daysLeft ${if (sleeps) "sleeps" else "days"}"
    }

    /** The compact month-badge form ("Today!" / "5d"), which ignores the sleeps setting. */
    fun short(daysLeft: Int): String = if (daysLeft <= 0) "Today!" else "${daysLeft}d"

    // Fixed locale: these parse/print a wire format, not a user-facing date, so the pattern
    // must not shift with the device language.
    private val display = DateTimeFormatter.ofPattern("MMM d", Locale.US)

    /** "2026-08-03" → "Aug 3"; empty for anything unparseable. */
    fun dateLabel(ymd: String): String =
        parse(ymd)?.format(display).orEmpty()

    fun ymd(date: LocalDate): String = date.toString()

    fun parse(ymd: String): LocalDate? = runCatching { LocalDate.parse(ymd.trim()) }.getOrNull()
}

/**
 * REST-backed state for the countdown surfaces.
 *
 * Dependencies are function seams rather than a client instance so the whole state machine
 * is drivable from a JVM test, and so the card can be dropped onto any screen without
 * re-wiring. Methods are plain `suspend` functions — no `viewModelScope.launch` — for the
 * same reason.
 */
class CountdownsModel(
    private val fetchCountdowns: suspend () -> Fetched,
    private val createCountdown: suspend (title: String, date: String, emoji: String?) -> Unit,
    private val updateCountdown: suspend (id: String, title: String, date: String, emoji: String?) -> Unit,
    private val deleteCountdown: suspend (id: String) -> Unit,
) {

    data class Fetched(val items: List<CalendarApi.Countdown>, val sleeps: Boolean)

    private val _items = MutableStateFlow<List<CalendarApi.Countdown>>(emptyList())
    val itemsState: StateFlow<List<CalendarApi.Countdown>> = _items.asStateFlow()

    /**
     * Countdowns grouped by their `YYYY-MM-DD` date, for the month-grid badges. STORED
     * (rebuilt when the items change) so 42 month cells don't each regroup the list per
     * render — the documented precompute rule.
     */
    private val _byDate = MutableStateFlow<Map<String, List<CalendarApi.Countdown>>>(emptyMap())
    val byDateState: StateFlow<Map<String, List<CalendarApi.Countdown>>> = _byDate.asStateFlow()

    private val _sleeps = MutableStateFlow(false)
    val sleepsState: StateFlow<Boolean> = _sleeps.asStateFlow()

    private val _loaded = MutableStateFlow(false)
    val loadedState: StateFlow<Boolean> = _loaded.asStateFlow()

    val items: List<CalendarApi.Countdown> get() = _items.value
    val byDate: Map<String, List<CalendarApi.Countdown>> get() = _byDate.value
    val sleeps: Boolean get() = _sleeps.value
    val loaded: Boolean get() = _loaded.value

    /** In-flight deletes, so a double-tap on the ✕ can't fire two requests. */
    private val deleting = mutableSetOf<String>()

    suspend fun load() {
        runCatching { fetchCountdowns() }.getOrNull()?.let { response ->
            setItems(response.items)
            _sleeps.value = response.sleeps
        }
        // Marked loaded even on failure, or the card sits on "Loading…" for ever.
        _loaded.value = true
    }

    suspend fun add(title: String, date: String, emoji: String?) {
        createCountdown(title, date, emoji)
        // Re-read rather than patching locally: daysLeft, the ordering and the birthday /
        // event rows are all computed server-side.
        load()
    }

    /** Only standalone items can be removed (events/birthdays are managed at their source). */
    suspend fun remove(countdown: CalendarApi.Countdown) {
        if (!countdown.isStandalone) return
        if (!deleting.add(countdown.id)) return
        try {
            deleteCountdown(countdown.id)
            setItems(items.filterNot { it.id == countdown.id })
        } finally {
            deleting.remove(countdown.id)
        }
    }

    /** Rename / move a standalone countdown. */
    suspend fun update(countdown: CalendarApi.Countdown, title: String, date: String, emoji: String?) {
        if (!countdown.isStandalone) return
        updateCountdown(countdown.id, title, date, emoji)
        load()
    }

    private fun setItems(value: List<CalendarApi.Countdown>) {
        _items.value = value
        _byDate.value = value.groupBy { it.date }
    }

    companion object {
        /** The model wired to a real [CalendarApi]. */
        fun backedBy(api: CalendarApi) = CountdownsModel(
            fetchCountdowns = {
                val response = api.countdowns()
                Fetched(response.countdowns, response.sleeps)
            },
            createCountdown = { title, date, emoji -> api.createCountdown(title, date, emoji) },
            updateCountdown = { id, title, date, emoji -> api.updateCountdown(id, title, date, emoji) },
            deleteCountdown = { id -> api.deleteCountdown(id) },
        )
    }
}
