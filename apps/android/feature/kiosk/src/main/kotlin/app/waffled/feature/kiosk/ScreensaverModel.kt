package app.waffled.feature.kiosk

import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.photos.PhotosApi
import app.waffled.feature.settingshousehold.SettingsHouseholdApi
import app.waffled.feature.settingshousehold.SettingsHouseholdApi.DisplayConfig
import app.waffled.feature.today.TodayApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlin.random.Random

data class ScreensaverState(
    val config: DisplayConfig? = null,
    val photos: List<PhotosApi.Photo> = emptyList(),
    val weather: TodayApi.Weather? = null,
    val showing: Boolean = false,
    val dimmed: Boolean = false,
)

/**
 * The idle family-display screensaver: once the household's "Screensaver after N min"
 * passes with no touches it shows; any touch wakes it. Honours the Display & Kiosk
 * config — idle delay, content (photos / clock / off) and the night-dim window.
 * Port of iOS `ScreensaverModel`.
 */
class ScreensaverModel(
    private val fetchConfig: suspend () -> DisplayConfig,
    private val fetchWeather: suspend () -> TodayApi.Weather?,
    private val fetchPhotos: suspend () -> List<PhotosApi.Photo>,
    private val clock: () -> Instant = Instant::now,
    private val random: Random = Random.Default,
) {
    private val _state = MutableStateFlow(ScreensaverState())
    val state: StateFlow<ScreensaverState> = _state.asStateFlow()

    private var lastActivity: Instant = clock()

    suspend fun load() {
        val cfg = attempt { fetchConfig() }
        val weather = attempt { fetchWeather() }
        // Only fetch the wall when the saver would actually show photos.
        val photos = if (cfg?.content == "photos") Screensaver.photos(attempt { fetchPhotos() }.orEmpty(), cfg, random) else emptyList()
        _state.update { it.copy(config = cfg, weather = weather, photos = photos) }
    }

    /** A touch somewhere. Ignored while showing, so a stray ping can't pre-empt the wake tap. */
    fun ping(now: Instant = clock()) {
        if (!_state.value.showing) lastActivity = now
    }

    fun wake(now: Instant = clock()) {
        lastActivity = now
        _state.update { it.copy(showing = false) }
    }

    /**
     * Decide whether to show and whether to night-dim. [hold] is true while a dialog,
     * sheet or the keyboard is up: the saver would draw under a dialog window, or drop
     * over someone mid-typing, so the idle clock restarts instead.
     */
    fun tick(now: Instant, zone: ZoneId, hold: Boolean = false) {
        val cfg = _state.value.config
        if (cfg == null || cfg.content == "off") {
            _state.update { it.copy(showing = false, dimmed = false) }
            return
        }
        val dimmed = Screensaver.inNightWindow(cfg.nightDim, now, zone)
        var showing = _state.value.showing
        if (!showing) {
            val idle = Duration.between(lastActivity, now).seconds
            if (idle >= maxOf(1, cfg.screensaverMinutes) * 60L) {
                if (hold) lastActivity = now else showing = true
            }
        }
        _state.update { it.copy(dimmed = dimmed, showing = showing) }
    }

    private suspend fun <T> attempt(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    companion object {
        fun backedBy(settings: SettingsHouseholdApi, today: TodayApi, photos: PhotosApi) = ScreensaverModel(
            fetchConfig = settings::displayConfig,
            fetchWeather = today::weather,
            fetchPhotos = { photos.list() },
        )
    }
}

/** Pure screensaver rules and copy, shared by the kiosk host and the Settings preview. */
object Screensaver {
    private val hhmm: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    /** "HH:mm" compared in the household zone; an overnight window (21:00 → 07:00) wraps. */
    fun inNightWindow(nd: DisplayConfig.NightDim, now: Instant, zone: ZoneId): Boolean {
        if (!nd.enabled) return false
        val cur = hhmm.format(now.atZone(zone))
        return if (nd.start <= nd.end) cur >= nd.start && cur < nd.end else cur >= nd.start || cur < nd.end
    }

    /** All, favourites or one album, shuffled if asked. Mirrors web `screensaverPhotos`. */
    fun photos(photos: List<PhotosApi.Photo>, cfg: DisplayConfig, random: Random = Random.Default): List<PhotosApi.Photo> {
        val picked = when (cfg.photoSource) {
            "favorites" -> photos.filter { it.isFavorite }
            "album" -> cfg.photoAlbum?.let { album -> photos.filter { it.memory == album } } ?: photos
            else -> photos
        }
        return if (cfg.photoShuffle) picked.shuffled(random) else picked
    }

    /** Waking a shared kiosk set to "return to picker" drops whoever last used it. */
    fun wakeReturnsToPicker(cfg: DisplayConfig?, isShared: Boolean): Boolean = cfg?.returnToPicker == true && isShared

    fun dateLine(date: String, weather: TodayApi.Weather?): String {
        val w = weather?.takeIf { it.configured } ?: return date
        val temp = w.tempF ?: return date
        val lead = listOfNotNull(w.emoji?.takeIf { it.isNotEmpty() }, "${temp.roundToInt()}°").joinToString(" ")
        val parts = listOfNotNull(lead, w.label?.takeIf { it.isNotEmpty() })
        return "$date · ${parts.joinToString(" · ")}"
    }

    fun albumLabel(photo: PhotosApi.Photo): String? =
        (photo.memory ?: photo.caption.takeIf { it.isNotEmpty() })?.takeIf { it.isNotEmpty() }

    fun nextEvent(events: List<SyncedEvent>, now: Instant): SyncedEvent? =
        events.mapNotNull { e -> WaffledDates.parseInstant(e.startsAt)?.let { e to it } }
            .filter { (_, at) -> !at.isBefore(now) }
            .minByOrNull { (_, at) -> at }
            ?.first

    fun nextEventLine(event: SyncedEvent?, time: (Instant) -> String): String? {
        val ev = event ?: return null
        if (ev.allDay) return "Next: ${ev.title}"
        val at = WaffledDates.parseInstant(ev.startsAt) ?: return "Next: ${ev.title}"
        return "Next: ${ev.title} · ${time(at)}"
    }

    fun nextIndex(index: Int, count: Int): Int = if (count <= 1) 0 else (index + 1) % count

    fun perPhotoSeconds(interval: Int): Int = maxOf(3, interval)
}
