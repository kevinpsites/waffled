package app.waffled.feature.calendar

import androidx.compose.runtime.Immutable
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.Person
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import java.time.LocalDate
import java.time.ZoneId

/**
 * The calendar's derived state.
 *
 * Events arrive over PowerSync, already visibility-filtered and day-bucketed by
 * `SyncManager` — this NEVER re-filters or re-buckets them. What it adds is everything the
 * synced row can't carry on its own: the owner's colour, the household's chip style, the
 * agenda order, and the per-row labels.
 *
 * ⚠️ Those additions come from FOUR inputs that all change at runtime, and three of them
 * (display settings, members, zone) arrive over REST *after* the events have. Rebuilding
 * only when the event list changes is the trap `DerivedEventState` documents in `core:sync`:
 * the colours would resolve once against the defaults and never correct themselves — which
 * compiles, passes an id-only test, and is wrong on screen. So all four are combined.
 *
 * Derived once per change, never per render.
 */
class CalendarModel(
    eventsByDay: StateFlow<Map<LocalDate, List<SyncedEvent>>>,
    scope: CoroutineScope,
    /** `SyncManager.householdWeekStart` — the raw synced `households.week_start`. */
    syncedWeekStart: StateFlow<String?> = MutableStateFlow(null),
) {

    private val _restWeekStart = MutableStateFlow<HouseholdWeekStart?>(null)

    /**
     * The household's week start, which cuts the month grid. The synced row wins; the REST
     * settings stand in until it arrives, and Sunday (the server default) before either.
     */
    val weekStart: StateFlow<HouseholdWeekStart> =
        combine(syncedWeekStart, _restWeekStart) { synced, rest ->
            synced?.let(HouseholdWeekStart::parse) ?: rest ?: HouseholdWeekStart.Sunday
        }.stateIn(scope, SharingStarted.Eagerly, HouseholdWeekStart.parse(syncedWeekStart.value))

    fun setRestWeekStart(value: HouseholdWeekStart?) {
        _restWeekStart.value = value
    }

    private val _display = MutableStateFlow(CalendarApi.HouseholdDisplay())
    val display: StateFlow<CalendarApi.HouseholdDisplay> = _display.asStateFlow()

    private val _members = MutableStateFlow<List<Person>>(emptyList())
    val members: StateFlow<List<Person>> = _members.asStateFlow()

    private val _zone = MutableStateFlow<ZoneId>(ZoneId.systemDefault())
    val zone: StateFlow<ZoneId> = _zone.asStateFlow()

    /** The colouring rules, rebuilt whenever the household changes. */
    val palette: StateFlow<EventPalette> = combine(_members, _display) { members, display ->
        EventPalette(
            memberIds = members.mapTo(mutableSetOf()) { it.id },
            familyHex = display.familyHex,
            style = display.style,
        )
    }.stateIn(scope, SharingStarted.Eagerly, EventPalette())

    /** Agenda-ordered rows per household-local day. The single source every surface reads. */
    val rowsByDay: StateFlow<Map<LocalDate, List<EventRow>>> =
        combine(eventsByDay, palette, _members, _zone) { byDay, palette, members, zone ->
            val byPerson = members.associateBy { it.id }
            Agenda.buildRows(byDay, zone, palette) { event ->
                val owner = event.personId?.let(byPerson::get)
                EventPeople(
                    ownerPersonId = event.personId,
                    ownerColorHex = owner?.colorHex,
                    ownerAvatarEmoji = owner?.avatarEmoji,
                    // ⚠️ Always empty today: nothing exposes the synced `event_participants`
                    // table. The editor prefills participants from `CalendarApi.eventDetail`
                    // instead, so a save can't strip them — see the port report.
                    participantIds = emptySet(),
                )
            }
        }.stateIn(scope, SharingStarted.Eagerly, emptyMap())

    fun setDisplay(value: CalendarApi.HouseholdDisplay) {
        _display.value = value
    }

    fun setMembers(value: List<Person>) {
        _members.value = value
    }

    fun setZone(value: ZoneId) {
        _zone.value = value
    }

    /** Load everything REST owns. Safe to call again on resume. */
    suspend fun refresh(api: CalendarApi) {
        runCatching { api.householdSettings() }.getOrNull()?.let {
            setZone(it.zone)
            setMembers(it.members)
            setRestWeekStart(it.weekStart)
        }
        runCatching { api.householdDisplay() }.getOrNull()?.let(::setDisplay)
    }

    /** Today, in the household's zone — the agenda's cutoff and the grid's highlight. */
    fun today(): LocalDate = LocalDate.now(_zone.value)

    /** Upcoming days, ascending, from [from]. */
    fun upcoming(from: LocalDate): List<DayGroup> = Agenda.upcoming(rowsByDay.value, from)

    /**
     * Rows for one person — as owner or participant — or every row when [personId] is null.
     *
     * A view filter over already-precomputed membership, NOT a re-run of the per-viewer
     * visibility rule (that belongs to `core:sync`, and doing it twice is how the two drift).
     * Days left with nothing are dropped so the agenda shows no empty headings.
     */
    fun filtered(
        personId: String?,
        rows: Map<LocalDate, List<EventRow>> = rowsByDay.value,
    ): Map<LocalDate, List<EventRow>> {
        if (personId == null) return rows
        return rows.mapValues { (_, day) -> day.filter { PeopleColumns.belongsTo(it.people, personId) } }
            .filterValues { it.isNotEmpty() }
    }

    /**
     * Distinct event colours on a day, for the month-grid dots. Whole-family events
     * contribute the family colour, so a day everyone is on shows one dot, not three.
     */
    fun dotColors(rows: Map<LocalDate, List<EventRow>>, day: LocalDate): List<String> =
        rows[day].orEmpty().mapNotNull { it.colorHex }.distinct()

    /** One cell in the month grid. */
    @Immutable
    data class MonthCell(val date: LocalDate, val inMonth: Boolean) {
        val dayOfMonth: Int get() = date.dayOfMonth
    }

    companion object {
        /** How many cells a month grid draws: six weeks, always. */
        const val MONTH_CELL_COUNT: Int = 42

        private val SUNDAY_FIRST_INITIALS = listOf("S", "M", "T", "W", "T", "F", "S")

        /** The grid's weekday header, opening on the same day as [monthCells]. */
        fun weekdayInitials(weekStart: HouseholdWeekStart): List<String> = weekStart.rotated(SUNDAY_FIRST_INITIALS)

        /**
         * Six weeks covering [anchor]'s month, cut on the household's week start like the
         * web and iOS grids. Fixed at six rows so the grid's height never jumps as you page.
         */
        fun monthCells(anchor: LocalDate, weekStart: HouseholdWeekStart): List<MonthCell> {
            val first = anchor.withDayOfMonth(1)
            val start = weekStart.weekStart(first)
            return (0 until MONTH_CELL_COUNT).map { offset ->
                val date = start.plusDays(offset.toLong())
                MonthCell(date = date, inMonth = date.month == first.month && date.year == first.year)
            }
        }
    }
}
