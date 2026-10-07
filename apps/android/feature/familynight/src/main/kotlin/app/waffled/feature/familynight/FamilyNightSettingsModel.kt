package app.waffled.feature.familynight

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import java.util.UUID

@Immutable
data class FamilyNightSettingsState(
    val parts: List<FamilyNightApi.Part> = emptyList(),
    val dayOfWeek: Int = 1,
    val time: String = "19:00",
    val onCalendar: Boolean = false,
    val loading: Boolean = true,
    val loaded: Boolean = false,
    val savingAgenda: Boolean = false,
    val busySchedule: Boolean = false,
    val busyCalendar: Boolean = false,
    val errorMessage: String? = null,
)

/**
 * Settings → Family Night: day/time and the calendar toggle save on change; the agenda
 * saves with an explicit button. Port of the iOS `FamilyNightSettingsModel`.
 */
class FamilyNightSettingsModel(
    private val fetch: suspend () -> FamilyNightApi.View,
    private val setConfig: suspend (JsonObject) -> FamilyNightApi.Config,
    private val schedule: suspend () -> String,
    private val unschedule: suspend () -> Unit,
) {
    constructor(api: FamilyNightApi) : this(
        fetch = { api.view() },
        setConfig = { api.setConfig(it) },
        schedule = { api.schedule() },
        unschedule = { api.unschedule() },
    )

    private val _state = MutableStateFlow(FamilyNightSettingsState())
    val state: StateFlow<FamilyNightSettingsState> = _state.asStateFlow()

    private var confirmedDay = 1
    private var confirmedTime = "19:00"
    private var pendingSchedule: Pair<Int, String>? = null

    suspend fun load() {
        _state.update { it.copy(loading = true) }
        try {
            adopt(fetch().config)
            _state.update { it.copy(loaded = true, errorMessage = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update {
                it.copy(errorMessage = "Couldn’t load Family Night settings. Check your connection and try again.")
            }
        }
        _state.update { it.copy(loading = false) }
    }

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    suspend fun setDay(day: Int) {
        if (day == _state.value.dayOfWeek) return
        _state.update { it.copy(dayOfWeek = day) }
        pendingSchedule = day to _state.value.time
        persistPendingSchedule()
    }

    suspend fun setTime(time: String) {
        if (time == _state.value.time) return
        _state.update { it.copy(time = time) }
        pendingSchedule = _state.value.dayOfWeek to time
        persistPendingSchedule()
    }

    /**
     * A time picker can emit several values while the first write is suspended. Keep only
     * the newest pending pair and serialise complete day+time writes, so the final value
     * can't be dropped or overwritten by an older response.
     */
    private suspend fun persistPendingSchedule() {
        if (_state.value.busySchedule) return
        _state.update { it.copy(busySchedule = true) }
        try {
            while (true) {
                val (day, time) = pendingSchedule ?: break
                pendingSchedule = null
                _state.update { it.copy(errorMessage = null) }
                val confirmed = try {
                    setConfig(FamilyNightBodies.schedule(day, time))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // A newer value is queued: let it retry before reporting failure.
                    if (pendingSchedule != null) continue
                    _state.update {
                        it.copy(
                            dayOfWeek = confirmedDay,
                            time = confirmedTime,
                            errorMessage = "The Family Night schedule wasn’t saved. Your previous schedule is still in place.",
                        )
                    }
                    continue
                }
                confirmedDay = confirmed.dayOfWeek
                confirmedTime = confirmed.time
                // An older response must not move a control that already queued a newer value.
                if (pendingSchedule != null) continue
                _state.update { it.copy(dayOfWeek = confirmed.dayOfWeek, time = confirmed.time) }

                // The schedule write and the calendar refresh are separate operations; if
                // only the refresh fails, the confirmed schedule stands.
                if (_state.value.onCalendar) {
                    try {
                        schedule()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        if (pendingSchedule != null) continue
                        _state.update {
                            it.copy(
                                errorMessage = "The Family Night schedule was saved, but its calendar event couldn’t be updated. Try again.",
                            )
                        }
                    }
                }
            }
        } finally {
            _state.update { it.copy(busySchedule = false) }
        }
    }

    suspend fun setCalendar(enabled: Boolean) {
        val s = _state.value
        if (s.busyCalendar || enabled == s.onCalendar) return
        val previous = s.onCalendar
        _state.update { it.copy(onCalendar = enabled, busyCalendar = true, errorMessage = null) }
        try {
            if (enabled) schedule() else unschedule()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update {
                it.copy(
                    onCalendar = previous,
                    errorMessage = "The calendar setting wasn’t changed. Check your connection and try again.",
                )
            }
        } finally {
            _state.update { it.copy(busyCalendar = false) }
        }
    }

    // ---- agenda draft --------------------------------------------------------------

    fun updatePart(id: String, transform: (FamilyNightApi.Part) -> FamilyNightApi.Part) =
        _state.update { s -> s.copy(parts = s.parts.map { if (it.id == id) transform(it) else it }) }

    fun addPart() = _state.update { s ->
        s.copy(parts = s.parts + FamilyNightApi.Part(UUID.randomUUID().toString(), "New part", "⭐", rotates = true))
    }

    fun removePart(id: String) = _state.update { s -> s.copy(parts = s.parts.filterNot { it.id == id }) }

    suspend fun saveAgenda() {
        val s = _state.value
        if (s.savingAgenda || s.parts.isEmpty()) return
        _state.update { it.copy(savingAgenda = true, errorMessage = null) }
        try {
            // Adopt only the confirmed agenda: day/time/calendar have their own controls.
            val confirmed = setConfig(FamilyNightBodies.agenda(s.parts))
            _state.update { it.copy(parts = confirmed.parts) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Keep the edited parts so Save is an in-place retry.
            _state.update {
                it.copy(errorMessage = "The agenda wasn’t saved. Your edits are still here so you can try again.")
            }
        } finally {
            _state.update { it.copy(savingAgenda = false) }
        }
    }

    private fun adopt(config: FamilyNightApi.Config) {
        confirmedDay = config.dayOfWeek
        confirmedTime = config.time
        pendingSchedule = null
        _state.update {
            it.copy(
                parts = config.parts,
                dayOfWeek = config.dayOfWeek,
                time = config.time,
                onCalendar = config.eventId != null,
            )
        }
    }
}
