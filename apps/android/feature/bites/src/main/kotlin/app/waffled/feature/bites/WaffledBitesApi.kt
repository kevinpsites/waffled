package app.waffled.feature.bites

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The Waffled-Bite slice of the API: pairing, the parent control panel's settings, and
 * the quiet-time / occasional-timer countdowns. Port of the `WaffledBite*` section of the
 * iOS `WaffledAPI.swift`.
 *
 * KEEP IN SYNC with `apps/web/src/lib/api/waffledBites.ts`. The server does NOT validate
 * settings patches (a real deep-merge, no allowlist), so the defaults and clamps in
 * [WaffledBiteOptions] are client discipline, not a server contract.
 */
class WaffledBitesApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types ------------------------------------------------------------

    @Serializable
    data class Device(
        val id: String,
        val label: String = "",
        val settings: Settings = Settings(),
        val runtimeState: RuntimeState = RuntimeState(),
        val lastSeenAt: String? = null,
        val createdAt: String = "",
    )

    @Serializable
    data class RuntimeState(
        val quiet: Countdown = Countdown(),
        val timer: Countdown = Countdown(),
        val wakeLight: WakeLight = WakeLight(),
    )

    /** Recomputed by the server from stored timestamps on every read — never partial. */
    @Serializable
    data class Countdown(
        val active: Boolean = false,
        val running: Boolean = false,
        val remainingSec: Int = 0,
        val durationSec: Int = 0,
    )

    /** Server-computed: render it, don't recompute it. `none | sleep | warn | wake`. */
    @Serializable
    data class WakeLight(
        val state: String = "none",
        val wakeAtHour: Int? = null,
        val wakeAtMinute: Int? = null,
    )

    /**
     * A fresh pairing stores `settings == {}`, so every top-level key is genuinely
     * absent. Apply [withDefaults] before rendering.
     */
    @Serializable
    data class Settings(
        val night: Night? = null,
        val sound: Sound? = null,
        val alarm: Alarm? = null,
        val schedules: List<Schedule>? = null,
        val display: Display? = null,
    )

    @Serializable
    data class Night(val on: Boolean = false, val color: String = "amber", val brightness: Int = 40)

    @Serializable
    data class Sound(
        val on: Boolean = false,
        val sound: String = "ocean",
        val volume: Int = 45,
        val timerMin: Int = 0,
    )

    /**
     * `volume` is optional: the alarm got its own volume after devices shipped, so older
     * rows have an alarm with no volume. Read [volumeOrDefault].
     */
    @Serializable
    data class Alarm(
        val on: Boolean = false,
        val hour: Int = 6,
        val min: Int = 45,
        val tone: String = "sunriseChime",
        val volume: Int? = null,
    ) {
        val volumeOrDefault: Int get() = volume ?: DEFAULT_VOLUME

        companion object {
            const val DEFAULT_VOLUME = 80
        }
    }

    @Serializable
    data class Display(val brightness: Int = 85, val nightDim: Boolean = true)

    /** Days are 0=Sun..6=Sat; times are minutes since midnight. */
    @Serializable
    data class Schedule(
        val days: List<Int> = emptyList(),
        val wakeMin: Int = 7 * 60,
        val leadMin: Int = 10,
        val bedtimeMin: Int? = null,
    )

    @Serializable
    data class PairingCode(val code: String, val personId: String = "", val expiresAt: String = "")

    @Serializable
    private data class DeviceEnvelope(val device: Device? = null)

    enum class CountdownKind(val path: String) { Quiet("quiet"), Timer("timer") }

    enum class CountdownAction(val path: String) {
        Start("start"), Pause("pause"), Resume("resume"), AddTime("add-time"), End("end"),
    }

    // ---- endpoints ---------------------------------------------------------------

    /** This kid's paired device + live state, or null if none is paired yet. */
    suspend fun device(personId: String): Device? =
        send<DeviceEnvelope>(HttpMethod.Get, "api/persons/$personId/waffled-bite").device

    /** A one-time pairing code (~10-min TTL, never surfaced: polling just never succeeds). */
    suspend fun mintPairingCode(personId: String, label: String?): PairingCode =
        send(HttpMethod.Post, "api/persons/$personId/waffled-bite/pairing-code") {
            json(buildJsonObject { if (!label.isNullOrEmpty()) put("label", label) })
        }

    suspend fun unpair(deviceId: String) {
        sendUnit(HttpMethod.Delete, "api/waffled-bites/$deviceId")
    }

    /** The server deep-merges [patch] into the stored settings. */
    suspend fun updateSettings(deviceId: String, patch: JsonObject) {
        sendUnit(HttpMethod.Patch, "api/waffled-bites/$deviceId/settings") { json(patch) }
    }

    /**
     * Quiet time and the occasional timer share one shape. The server clamps a start's
     * duration regardless of what is sent; add-time is always five minutes.
     */
    suspend fun countdown(
        deviceId: String,
        kind: CountdownKind,
        action: CountdownAction,
        durationSec: Int? = null,
    ) {
        val body = buildJsonObject {
            when (action) {
                CountdownAction.Start -> if (durationSec != null) put("durationSec", durationSec)
                CountdownAction.AddTime -> put("seconds", 300)
                else -> Unit
            }
        }
        sendUnit(HttpMethod.Post, "api/waffled-bites/$deviceId/${kind.path}/${action.path}") { json(body) }
    }

    // ---- request helper ------------------------------------------------------------

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = withContext(Dispatchers.IO) {
        WaffledHttp.authorized(client, tokens, method, path, configure) { it.body<T>() }
    }

    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit = {},
    ) {
        withContext(Dispatchers.IO) { WaffledHttp.authorized(client, tokens, method, path, configure) { } }
    }
}

private fun HttpRequestBuilder.json(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
