package app.waffled.feature.bites

import androidx.compose.runtime.Immutable
import app.waffled.feature.bites.WaffledBitesApi.CountdownAction
import app.waffled.feature.bites.WaffledBitesApi.CountdownKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

@Immutable
data class WaffledBitesState(
    val device: WaffledBitesApi.Device? = null,
    val loading: Boolean = true,
    val busy: Boolean = false,
    val errorMessage: String? = null,
    /** Locally smoothed countdowns — reseeded from the server on every load. */
    val quietRemaining: Int = 0,
    val timerRemaining: Int = 0,
)

/**
 * Loads and controls one kid's Waffled-Bite. Port of the iOS `WaffledBitesModel`.
 *
 * Methods are plain `suspend` functions so the whole thing is drivable from a JVM test;
 * the screen owns the coroutines (the 1s [tick], the 10s [PollLoop]).
 */
class WaffledBitesModel(
    val personId: String,
    private val api: WaffledBitesApi,
) {
    private val _state = MutableStateFlow(WaffledBitesState())
    val state: StateFlow<WaffledBitesState> = _state.asStateFlow()

    /**
     * Captured before each fetch, so a response that resolves out of order (two rapid
     * edits' reloads racing) is dropped instead of reverting an edit that already saved.
     */
    private var loadGeneration = 0

    private val device: WaffledBitesApi.Device? get() = _state.value.device

    suspend fun load() {
        val generation = ++loadGeneration
        val result = runCatching { api.device(personId) }
        result.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        if (generation != loadGeneration) return
        _state.update { s ->
            val next = result.fold(
                onSuccess = { s.copy(device = it, errorMessage = null) },
                onFailure = { s.copy(errorMessage = "Couldn't load this Waffled-Bite.") },
            )
            next.copy(
                loading = false,
                quietRemaining = next.device?.runtimeState?.quiet?.remainingSec ?: 0,
                timerRemaining = next.device?.runtimeState?.timer?.remainingSec ?: 0,
            )
        }
    }

    /** One second of local countdown, between server reloads. */
    fun tick() {
        _state.update { s ->
            val rt = s.device?.runtimeState ?: return@update s
            s.copy(
                quietRemaining = if (rt.quiet.running && s.quietRemaining > 0) s.quietRemaining - 1 else s.quietRemaining,
                timerRemaining = if (rt.timer.running && s.timerRemaining > 0) s.timerRemaining - 1 else s.timerRemaining,
            )
        }
    }

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    /** True on success, so the caller can pop back to the person page. */
    suspend fun unpair(): Boolean {
        val id = device?.id ?: return false
        _state.update { it.copy(busy = true) }
        return try {
            api.unpair(id)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(errorMessage = "Couldn't unpair — try again.") }
            false
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    // ---- quiet time / occasional timer --------------------------------------------

    suspend fun startQuiet(minutes: Int) = countdown(CountdownKind.Quiet, CountdownAction.Start, minutes)
    suspend fun pauseQuiet() = countdown(CountdownKind.Quiet, CountdownAction.Pause)
    suspend fun resumeQuiet() = countdown(CountdownKind.Quiet, CountdownAction.Resume)
    suspend fun addQuietTime() = countdown(CountdownKind.Quiet, CountdownAction.AddTime)
    suspend fun endQuiet() = countdown(CountdownKind.Quiet, CountdownAction.End)

    suspend fun startTimer(minutes: Int) = countdown(CountdownKind.Timer, CountdownAction.Start, minutes)
    suspend fun pauseTimer() = countdown(CountdownKind.Timer, CountdownAction.Pause)
    suspend fun resumeTimer() = countdown(CountdownKind.Timer, CountdownAction.Resume)
    suspend fun addTimerTime() = countdown(CountdownKind.Timer, CountdownAction.AddTime)
    suspend fun endTimer() = countdown(CountdownKind.Timer, CountdownAction.End)

    private suspend fun countdown(kind: CountdownKind, action: CountdownAction, minutes: Int? = null) {
        val seconds = minutes?.let { WaffledBiteOptions.clampCustomMinutes(it) * 60 }
        mutate { api.countdown(it, kind, action, seconds) }
    }

    // ---- settings ------------------------------------------------------------------
    //
    // Every setter sends the FULL sub-object, never just the changed key. The server's
    // deep-merge only merges into an EXISTING object; a fresh device has `settings == {}`,
    // so a bare `{"on":true}` would be stored verbatim and the next decode of a client
    // that requires `color`/`brightness` would fail. Matches the web's
    // `patchSettings({ night: { ...night, on } })`.

    private val filled: FilledSettings
        get() = (device?.settings ?: WaffledBitesApi.Settings()).withDefaults()

    suspend fun setNightOn(on: Boolean) = patchNight(filled.night.copy(on = on))
    suspend fun setNightColor(key: String) = patchNight(filled.night.copy(color = key))
    suspend fun setNightBrightness(b: Int) = patchNight(filled.night.copy(brightness = b))

    suspend fun setSoundOn(on: Boolean) = patchSound(filled.sound.copy(on = on))
    suspend fun setSoundOption(key: String) = patchSound(filled.sound.copy(sound = key))
    suspend fun setSoundVolume(v: Int) = patchSound(filled.sound.copy(volume = v))
    suspend fun setSoundSleepTimer(min: Int) = patchSound(filled.sound.copy(timerMin = min))

    suspend fun setAlarmOn(on: Boolean) = patchAlarm(filled.alarm.copy(on = on))
    suspend fun setAlarmTime(hour: Int, min: Int) = patchAlarm(filled.alarm.copy(hour = hour, min = min))
    suspend fun setAlarmTone(tone: String) = patchAlarm(filled.alarm.copy(tone = tone))
    suspend fun setAlarmVolume(v: Int) = patchAlarm(filled.alarm.copy(volume = v))

    suspend fun setDisplayBrightness(b: Int) = patchDisplay(filled.display.copy(brightness = b))
    suspend fun setDisplayNightDim(on: Boolean) = patchDisplay(filled.display.copy(nightDim = on))

    private suspend fun patchNight(n: WaffledBitesApi.Night) = patch(
        buildJsonObject {
            putJsonObject("night") {
                put("on", n.on); put("color", n.color); put("brightness", n.brightness)
            }
        },
    )

    private suspend fun patchSound(s: WaffledBitesApi.Sound) = patch(
        buildJsonObject {
            putJsonObject("sound") {
                put("on", s.on); put("sound", s.sound); put("volume", s.volume); put("timerMin", s.timerMin)
            }
        },
    )

    // `volumeOrDefault`: the whole object is rebuilt on every patch, so a device that
    // predates the volume field must not get a null written back.
    private suspend fun patchAlarm(a: WaffledBitesApi.Alarm) = patch(
        buildJsonObject {
            putJsonObject("alarm") {
                put("on", a.on); put("hour", a.hour); put("min", a.min); put("tone", a.tone)
                put("volume", a.volumeOrDefault)
            }
        },
    )

    private suspend fun patchDisplay(d: WaffledBitesApi.Display) = patch(
        buildJsonObject {
            putJsonObject("display") { put("brightness", d.brightness); put("nightDim", d.nightDim) }
        },
    )

    /** The server replaces arrays outright, so schedules always round-trip whole. */
    suspend fun setSchedules(schedules: List<WaffledBitesApi.Schedule>) = patch(
        buildJsonObject {
            put(
                "schedules",
                buildJsonArray {
                    schedules.forEach { s ->
                        add(
                            buildJsonObject {
                                putJsonArray("days") { s.days.forEach { add(it) } }
                                put("wakeMin", s.wakeMin)
                                put("leadMin", s.leadMin)
                                s.bedtimeMin?.let { put("bedtimeMin", it) }
                            },
                        )
                    }
                },
            )
        },
    )

    private suspend fun patch(body: JsonObject) = mutate { api.updateSettings(it, body) }

    private suspend fun mutate(action: suspend (deviceId: String) -> Unit) {
        val id = device?.id ?: return
        _state.update { it.copy(busy = true) }
        try {
            action(id)
            load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(errorMessage = "That didn't stick — try again.") }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }
}
