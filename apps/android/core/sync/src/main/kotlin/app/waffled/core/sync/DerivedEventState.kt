package app.waffled.core.sync

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.LocalDate
import java.time.ZoneId

/**
 * The event state every calendar surface reads, derived from three inputs that **all**
 * change at runtime:
 *
 *  1. the events themselves, as PowerSync streams them,
 *  2. the **viewer**, which changes when someone claims a shared kiosk,
 *  3. the household **timezone**, which arrives from the server after load.
 *
 * Every one of them retriggers the derivation. Recomputing only when the event list
 * changes is a subtle trap: a person claim would silently fail to refilter, leaving
 * someone else's personal event on screen — exactly what the visibility rule exists to
 * prevent.
 *
 * Derived **once per change**, never recomputed while rendering: date math in a sort or
 * filter hot path is one of the two documented jank sources inherited from iOS.
 *
 * Extracted from [SyncManager] so this wiring is testable without an Android runtime or
 * a live database.
 */
class DerivedEventState {

    private var events: List<SyncedEvent> = emptyList()
    private var viewer: String? = null
    private var zone: ZoneId = ZoneId.systemDefault()

    private val _visible = MutableStateFlow<List<SyncedEvent>>(emptyList())

    /** Events this viewer may see. */
    val visible: StateFlow<List<SyncedEvent>> = _visible.asStateFlow()

    private val _byDay = MutableStateFlow<Map<LocalDate, List<SyncedEvent>>>(emptyMap())

    /** Visible events bucketed by local day in the household's zone. */
    val byDay: StateFlow<Map<LocalDate, List<SyncedEvent>>> = _byDay.asStateFlow()

    fun setEvents(value: List<SyncedEvent>) {
        events = value
        recompute()
    }

    /** The person using this device — null on an unclaimed shared kiosk. */
    fun setViewer(personId: String?) {
        viewer = personId
        recompute()
    }

    fun setZone(value: ZoneId) {
        zone = value
        recompute()
    }

    val currentViewer: String? get() = viewer
    val currentZone: ZoneId get() = zone

    private fun recompute() {
        val shown = EventVisibility.visible(events, viewer)
        _visible.value = shown
        _byDay.value = EventBucketing.byDay(shown, zone)
    }
}
