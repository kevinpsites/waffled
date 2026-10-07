package app.waffled.feature.kiosk

import app.waffled.core.network.ApiErrorText
import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * One face on the profile picker. `hasPin` defaults to false because only the picker
 * LIST carries it; the claim response's embedded `person` omits it, and a strict decode
 * would surface as a bogus "couldn't reach the server".
 */
@Serializable
data class KioskProfile(
    val id: String,
    val name: String,
    val memberType: String? = null,
    val isAdmin: Boolean? = null,
    val avatarEmoji: String? = null,
    val avatarUrl: String? = null,
    val colorHex: String? = null,
    val hasPin: Boolean = false,
)

@Serializable
data class KioskProfiles(val deviceLabel: String? = null, val profiles: List<KioskProfile> = emptyList())

/** A freshly paired device's durable credential. */
@Serializable
data class DevicePairing(val deviceSecret: String, val deviceId: String = "", val householdId: String = "")

/** The per-person session minted when a profile is claimed. */
@Serializable
data class KioskClaim(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int? = null,
    val person: KioskProfile? = null,
)

/** Why a claim succeeded or failed — drives the PIN pad's retry/lockout copy. */
sealed interface KioskClaimResult {
    data class Success(val claim: KioskClaim) : KioskClaimResult
    data class WrongPin(val triesLeft: Int) : KioskClaimResult
    data class LockedOut(val retryAfter: Int) : KioskClaimResult
    data object NotFound : KioskClaimResult
    data class Other(val message: String) : KioskClaimResult
}

/**
 * The kiosk routes. Pairing needs no bearer (the one-time code is the credential);
 * promote uses the signed-in admin's bearer; everything else authenticates with the
 * DEVICE token, never the person's.
 *
 * KEEP IN SYNC with `apps/api/src/modules/kiosk/kiosk.ts`, the web
 * `apps/web/src/lib/api/kiosk.ts` and iOS `WaffledAPI` kiosk section.
 */
class KioskApi(
    private val client: HttpClient,
    private val personTokens: TokenProvider,
    private val device: KioskDeviceAuth,
) {

    suspend fun pairDevice(code: String, label: String?): DevicePairing = io {
        val response = client.request("api/kiosk/pair") {
            method = HttpMethod.Post
            json(pairBody(label) { put("code", code) })
        }
        decodeOrThrow(response)
    }

    suspend fun promoteDevice(label: String?): DevicePairing = io {
        WaffledHttp.authorized(client, personTokens, HttpMethod.Post, "api/kiosk/promote", {
            json(pairBody(label) {})
        }) { it.body<DevicePairing>() }
    }

    suspend fun profiles(): KioskProfiles = io {
        WaffledHttp.authorized(client, device.asTokenProvider, HttpMethod.Get, "api/kiosk/profiles") {
            it.body<KioskProfiles>()
        }
    }

    /**
     * Claim a profile. Deliberately NOT routed through the 401-retry helper: a claim 401
     * means a wrong PIN, and replaying it would burn a second attempt against the lockout.
     */
    suspend fun claimProfile(personId: String, pin: String?): KioskClaimResult = io {
        val token = device.token()
        val response = client.request("api/kiosk/profile/$personId") {
            method = HttpMethod.Post
            header(HttpHeaders.Authorization, "Bearer $token")
            json(buildJsonObject { if (!pin.isNullOrEmpty()) put("pin", pin) })
        }
        val status = response.status.value
        val text = runCatching { response.bodyAsText() }.getOrNull()
        when {
            response.status.isSuccess() -> KioskClaimResult.Success(WaffledJson.decodeFromString(KioskClaim.serializer(), text.orEmpty()))
            status == 401 -> KioskClaimResult.WrongPin(intField(text, "triesLeft") ?: 0)
            status == 404 -> KioskClaimResult.NotFound
            status == 429 -> KioskClaimResult.LockedOut(intField(text, "retryAfter") ?: DEFAULT_LOCKOUT_SECONDS)
            else -> KioskClaimResult.Other(ApiErrorText.from(text, status))
        }
    }

    /** Name this display from the kiosk itself, e.g. right after pairing. */
    suspend fun setDeviceLabel(label: String) {
        io {
            WaffledHttp.authorized(client, device.asTokenProvider, HttpMethod.Put, "api/kiosk/device/label", {
                json(buildJsonObject { put("label", label) })
            }) { }
        }
    }

    /** Liveness ping for the admin device list. Best effort — never throws. */
    suspend fun heartbeat() {
        try {
            io {
                WaffledHttp.authorized(client, device.asTokenProvider, HttpMethod.Post, "api/kiosk/heartbeat", {
                    json(JsonObject(emptyMap()))
                }) { }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    private fun pairBody(label: String?, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) = buildJsonObject {
        extra()
        label?.trim()?.takeIf { it.isNotEmpty() }?.let { put("label", it) }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.json(body: JsonObject) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend inline fun <reified T> decodeOrThrow(response: HttpResponse): T {
        val text = runCatching { response.bodyAsText() }.getOrNull()
        if (!response.status.isSuccess()) {
            throw WaffledApiException(response.status.value, ApiErrorText.from(text, response.status.value))
        }
        return WaffledJson.decodeFromString(text.orEmpty())
    }

    private suspend fun <T> io(block: suspend () -> T): T = withContext(Dispatchers.IO) { block() }

    private fun intField(text: String?, key: String): Int? = text?.let {
        runCatching { WaffledJson.parseToJsonElement(it).jsonObject[key]?.jsonPrimitive?.intOrNull }.getOrNull()
    }

    companion object {
        const val DEFAULT_LOCKOUT_SECONDS = 30
    }
}
