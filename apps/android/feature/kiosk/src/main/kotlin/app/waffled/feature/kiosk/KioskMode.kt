package app.waffled.feature.kiosk

import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * What the kiosk needs from `app`'s session layer. Adopting a claim means: store the
 * person tokens, flip the session phase, set the current person and restart sync —
 * all owned by `app`. Return false to refuse a claim that raced a sign-out.
 */
interface KioskSessionHost {
    fun isSignedIn(): Boolean
    suspend fun adopt(accessToken: String, refreshToken: String): Boolean

    /** Clear the person tokens and stop sync, WITHOUT a server revoke; pairing stays. */
    suspend fun dropSession()

    /** A full sign-out back to the login screen. */
    suspend fun signOut()
}

data class KioskModeState(val isShared: Boolean, val hasProfile: Boolean, val deviceLabel: String?) {
    /** A paired kiosk with nobody claimed in shows the profile picker instead of login. */
    val needsPicker: Boolean get() = isShared && !hasProfile
}

sealed interface ClaimOutcome {
    data object Ok : ClaimOutcome
    data class WrongPin(val triesLeft: Int) : ClaimOutcome
    data class LockedOut(val retryAfter: Int) : ClaimOutcome
    data class Failed(val message: String) : ClaimOutcome
}

sealed interface ProfilesLoad {
    data class Loaded(val profiles: KioskProfiles) : ProfilesLoad
    data object Revoked : ProfilesLoad
    data class Failed(val message: String) : ProfilesLoad
}

/**
 * Whether this device runs as a **shared kiosk** (a profile picker the household taps
 * into) or a single persistent login — the port of iOS `KioskMode`.
 *
 * KEEP IN SYNC with iOS `KioskMode.swift` and the web kiosk shell.
 */
class KioskMode(
    private val store: KioskDeviceStore,
    private val api: KioskApi,
    private val deviceAuth: KioskDeviceAuth?,
    private val host: KioskSessionHost,
) {
    private val _state = MutableStateFlow(
        KioskModeState(isShared = store.isPaired, hasProfile = host.isSignedIn(), deviceLabel = store.label),
    )
    val state: StateFlow<KioskModeState> = _state.asStateFlow()

    /** Turn this signed-in admin's device into a kiosk in one tap. Returns an error, or null. */
    suspend fun enableViaPromote(label: String?): String? = try {
        val pairing = api.promoteDevice(label)
        becomeKiosk(pairing, label)
        null
    } catch (e: CancellationException) {
        throw e
    } catch (e: WaffledApiException) {
        if (e.status == 403) "Only an admin can turn this device into a kiosk." else "Couldn’t set up the kiosk (error ${e.status})."
    } catch (e: Exception) {
        "Couldn’t reach the server to set up the kiosk."
    }

    /** Pair a fresh device with a one-time code, then show the picker. */
    suspend fun enableViaCode(code: String, label: String?): String? = try {
        val name = label?.trim()?.takeIf { it.isNotEmpty() }
        val pairing = api.pairDevice(code.trim(), name)
        store.savePaired(pairing.deviceSecret, name)
        deviceAuth?.invalidate()
        if (name != null) runCatching { api.setDeviceLabel(name) }
        becomeKiosk(null, name)
        null
    } catch (e: CancellationException) {
        throw e
    } catch (e: WaffledApiException) {
        if (e.status == 401) "That code is invalid or expired." else "Couldn’t pair this device (error ${e.status})."
    } catch (e: Exception) {
        "Couldn’t reach the server. Check the address and your connection."
    }

    suspend fun claim(profile: KioskProfile, pin: String?): ClaimOutcome {
        val result = try {
            api.claimProfile(profile.id, pin)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return ClaimOutcome.Failed("Couldn’t reach the server.")
        }
        return when (result) {
            is KioskClaimResult.Success -> {
                if (!host.adopt(result.claim.accessToken, result.claim.refreshToken)) {
                    return ClaimOutcome.Failed("Couldn’t safely finish switching profiles. Try again.")
                }
                _state.update { it.copy(hasProfile = true) }
                ClaimOutcome.Ok
            }
            is KioskClaimResult.WrongPin -> ClaimOutcome.WrongPin(result.triesLeft)
            is KioskClaimResult.LockedOut -> ClaimOutcome.LockedOut(result.retryAfter)
            KioskClaimResult.NotFound -> ClaimOutcome.Failed("That profile is no longer available.")
            is KioskClaimResult.Other -> ClaimOutcome.Failed("Couldn’t sign in to that profile.")
        }
    }

    /** The picker's profile list. A rejected device credential forgets the pairing. */
    suspend fun loadProfiles(): ProfilesLoad = try {
        ProfilesLoad.Loaded(api.profiles()).also { loaded ->
            loaded.profiles.deviceLabel?.let { label -> _state.update { it.copy(deviceLabel = label) } }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: KioskDeviceAuth.NotPaired) {
        handleDeviceRevoked()
        ProfilesLoad.Revoked
    } catch (e: WaffledApiException) {
        if (e.status == 401) {
            handleDeviceRevoked()
            ProfilesLoad.Revoked
        } else {
            ProfilesLoad.Failed(PROFILES_FAILED)
        }
    } catch (e: Exception) {
        ProfilesLoad.Failed(PROFILES_FAILED)
    }

    suspend fun heartbeat() = api.heartbeat()

    /** Idle-return or a manual switch: drop the person, keep the device paired. */
    suspend fun returnToPicker() {
        host.dropSession()
        _state.update { it.copy(hasProfile = false) }
    }

    /**
     * `app` calls this when the person's refresh token dies. On a shared kiosk that is a
     * return to the picker, not to login — the device stays paired.
     */
    fun onPersonSessionExpired() {
        _state.update { it.copy(hasProfile = false) }
    }

    /** The server rejected the device (an admin unpaired it). Fall back to normal login. */
    fun handleDeviceRevoked() {
        store.clear()
        deviceAuth?.invalidate()
        _state.value = KioskModeState(isShared = false, hasProfile = host.isSignedIn(), deviceLabel = null)
    }

    /** Fully un-kiosk this device and sign out. */
    suspend fun unpair() {
        store.clear()
        deviceAuth?.invalidate()
        _state.value = KioskModeState(isShared = false, hasProfile = false, deviceLabel = null)
        host.signOut()
    }

    /** Re-read after the server address changed: the old base's device token is void. */
    fun serverChanged() {
        deviceAuth?.invalidate()
    }

    private suspend fun becomeKiosk(pairing: DevicePairing?, label: String?) {
        if (pairing != null) {
            store.savePaired(pairing.deviceSecret, label)
            deviceAuth?.invalidate()
        }
        host.dropSession()
        _state.value = KioskModeState(isShared = true, hasProfile = false, deviceLabel = label?.trim()?.takeIf { it.isNotEmpty() })
    }

    private companion object {
        const val PROFILES_FAILED = "Couldn’t load profiles. Check the connection."
    }
}

/** The PIN pad's pure state. 4–8 digits; wrong-PIN and lockout feedback stay inline. */
data class PinPadState(
    val pin: String = "",
    val message: String? = null,
    /** Remaining lockout seconds. */
    val lockedFor: Int = 0,
) {
    val canSubmit: Boolean get() = pin.length >= MIN_LEN && !locked
    val dotCount: Int get() = maxOf(pin.length + 1, MIN_LEN)
    val locked: Boolean get() = lockedFor > 0
    val prompt: String get() = if (locked) "Locked — try again in ${lockedFor}s" else "Enter your PIN"
    val visibleMessage: String? get() = if (locked) null else message

    fun press(digit: Char): PinPadState =
        if (locked || pin.length >= MAX_LEN || !digit.isDigit()) this else copy(pin = pin + digit, message = null)

    fun backspace(): PinPadState = if (pin.isEmpty()) this else copy(pin = pin.dropLast(1), message = null)

    fun after(outcome: ClaimOutcome): PinPadState = when (outcome) {
        ClaimOutcome.Ok -> this
        is ClaimOutcome.WrongPin -> copy(
            pin = "",
            message = if (outcome.triesLeft > 0) {
                "Incorrect PIN — ${outcome.triesLeft} ${if (outcome.triesLeft == 1) "try" else "tries"} left"
            } else {
                "Incorrect PIN"
            },
        )
        is ClaimOutcome.LockedOut -> copy(pin = "", lockedFor = outcome.retryAfter)
        is ClaimOutcome.Failed -> copy(message = outcome.message)
    }

    fun tick(): PinPadState = if (locked) copy(lockedFor = lockedFor - 1) else this

    companion object {
        const val MIN_LEN = 4
        const val MAX_LEN = 8
    }
}

object KioskCodeEntry {
    fun canSubmit(code: String, busy: Boolean): Boolean = !busy && code.trim().length >= 4
}
