package app.waffled.feature.familynight

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

object FamilyNightFormat {
    private val display = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)

    /** "2026-06-08" → "Mon, Jun 8"; an unreadable value passes through. */
    fun dateLabel(ymd: String): String =
        runCatching { LocalDate.parse(ymd).format(display) }.getOrDefault(ymd)

    val weekdays = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

    fun weekday(dow: Int): String = weekdays[((dow % 7) + 7) % 7]

    /** "19:00" → "7:00 PM" in the device's locale. */
    fun timeLabel(hhmm: String): String {
        val parts = hhmm.split(":")
        val h = parts.getOrNull(0)?.toIntOrNull()
        val m = parts.getOrNull(1)?.toIntOrNull()
        if (parts.size != 2 || h == null || m == null || h !in 0..23 || m !in 0..59) return hhmm
        return LocalTime.of(h, m).format(DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()))
    }

    /** "HH:mm" → minutes since midnight, defaulting to 19:00 like iOS's `parseTime`. */
    fun minutes(hhmm: String): Int {
        val parts = hhmm.split(":")
        val h = parts.getOrNull(0)?.toIntOrNull() ?: return 19 * 60
        val m = parts.getOrNull(1)?.toIntOrNull() ?: 0
        return h * 60 + m
    }

    fun hhmm(minutes: Int): String = String.format(Locale.ROOT, "%02d:%02d", minutes / 60, minutes % 60)
}

@Immutable
data class FamilyNightCardState(
    val view: FamilyNightApi.View? = null,
    val loaded: Boolean = false,
)

/**
 * The Today card's state: the upcoming gathering and per-part assignment overrides.
 * Port of the iOS `FamilyNightModel`.
 *
 * Takes its two operations as functions so the Weekly Planning step (and tests) can
 * drive it without a server; the `api` constructor is what the app uses.
 */
class FamilyNightModel(
    private val fetchFamilyNight: suspend () -> FamilyNightApi.View,
    private val saveAssignment: suspend (date: String, partId: String, personId: String?) -> Unit,
) {
    constructor(api: FamilyNightApi) : this(
        fetchFamilyNight = { api.view() },
        saveAssignment = { date, partId, personId -> api.saveOccurrence(FamilyNightBodies.pin(date, partId, personId)) },
    )

    enum class MutationOutcome { Refreshed, SavedButRefreshFailed }

    private val _state = MutableStateFlow(FamilyNightCardState())
    val state: StateFlow<FamilyNightCardState> = _state.asStateFlow()

    /** A failed passive refresh keeps the last confirmed snapshot. */
    suspend fun load() {
        val fresh = fetchOrNull()
        _state.update { it.copy(view = fresh ?: it.view, loaded = true) }
    }

    /**
     * Assign (or clear, null) one part for the upcoming gathering — a per-week override
     * of the rotation. Throws when the save itself fails, leaving the snapshot alone.
     */
    suspend fun assign(partId: String, personId: String?): MutationOutcome {
        val date = _state.value.view?.next?.date ?: return MutationOutcome.Refreshed
        saveAssignment(date, partId, personId)
        val fresh = fetchOrNull()
        _state.update { it.copy(view = fresh ?: it.view, loaded = true) }
        return if (fresh != null) MutationOutcome.Refreshed else MutationOutcome.SavedButRefreshFailed
    }

    private suspend fun fetchOrNull(): FamilyNightApi.View? = try {
        fetchFamilyNight()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}
