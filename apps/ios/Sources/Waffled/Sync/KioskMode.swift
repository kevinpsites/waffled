import Foundation
import Observation

/// Drives whether an iPad family display is running as a **shared kiosk** (a profile
/// picker the whole household taps into) versus the default single persistent login.
///
/// "Show the picker" reduces to one rule: this iPad is paired as a kiosk
/// (`KioskDeviceStore`) AND no per-person session is currently held (`AuthTokens`).
/// Enabling kiosk mode (promote or pair-by-code) drops the admin's personal session →
/// picker. Claiming a profile saves that person's tokens → shell. Idle-return clears
/// them → picker. Injected at the app root; inert on iPhone (never paired).
///
/// ⚠️ KEEP IN SYNC with the web kiosk shell (`apps/web/src/kiosk/*`,
/// `apps/web/src/lib/api/client.ts` kiosk-mode flags).
@MainActor
@Observable
final class KioskMode {
    /// This iPad has been set up as a shared family kiosk (device secret present).
    private(set) var isShared: Bool
    /// A profile session is currently held (someone has claimed the kiosk).
    private(set) var hasProfile: Bool
    /// The device's display name (above the picker).
    private(set) var deviceLabel: String?

    private let api = WaffledAPI()

    /// Show the picker when we're a kiosk with nobody currently claimed in.
    var needsPicker: Bool { isShared && !hasProfile }

    init() {
        isShared = KioskDeviceStore.isPaired
        hasProfile = AuthTokens.isSignedIn
        deviceLabel = KioskDeviceStore.label
        // A dead per-person refresh token on a shared kiosk should drop to the picker,
        // not the login screen — the device stays paired.
        NotificationCenter.default.addObserver(forName: .waffledAuthExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.hasProfile = false }
        }
    }

    /// The outcome of a profile-claim attempt — surfaced to the PIN pad.
    enum ClaimOutcome: Equatable {
        case ok
        case wrongPin(triesLeft: Int)
        case lockedOut(retryAfter: Int)
        case failed(String)
    }

    /// Turn this signed-in admin's iPad into a shared kiosk in one tap (promote), then
    /// drop their personal session so the picker takes over. Returns an error string.
    func enableViaPromote(label: String?, sync: SyncManager) async -> String? {
        do {
            let pairing = try await api.promoteDevice(label: label)
            KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label)
            await dropToPicker(sync: sync)
            isShared = true; deviceLabel = label
            return nil
        } catch let WaffledAPI.APIError.http(code, _) {
            return code == 403 ? "Only an admin can turn this iPad into a kiosk." : "Couldn’t set up the kiosk (error \(code))."
        } catch {
            return "Couldn’t reach the server to set up the kiosk."
        }
    }

    /// Pair a fresh iPad as a shared kiosk with a one-time code, then show the picker.
    func enableViaCode(_ code: String, label: String?, sync: SyncManager) async -> String? {
        do {
            let pairing = try await api.pairDevice(code: code, label: label)
            KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label)
            if let label, !label.isEmpty { try? await api.setKioskDeviceLabel(label) }
            await dropToPicker(sync: sync)
            isShared = true; deviceLabel = label
            return nil
        } catch let WaffledAPI.APIError.http(code, _) {
            return code == 401 ? "That code is invalid or expired." : "Couldn’t pair this device (error \(code))."
        } catch {
            return "Couldn’t reach the server. Check the address and your connection."
        }
    }

    /// Claim a profile and become that person. On success the per-person session is
    /// adopted and the live sync re-scopes; the gate then shows the kiosk shell.
    func claim(_ profile: WaffledAPI.KioskProfile, pin: String?, sync: SyncManager, session: Session) async -> ClaimOutcome {
        do {
            let claim = try await api.claimProfile(personId: profile.id, pin: pin)
            session.enterClaimedSession(access: claim.accessToken, refresh: claim.refreshToken)
            await sync.reauthenticate()
            hasProfile = true
            return .ok
        } catch let e as WaffledAPI.KioskClaimError {
            switch e {
            case let .wrongPin(t):   return .wrongPin(triesLeft: t)
            case let .lockedOut(r):  return .lockedOut(retryAfter: r)
            case .notFound:          return .failed("That profile is no longer available.")
            case let .other(m):      return .failed(m.isEmpty ? "Couldn’t sign in to that profile." : "Couldn’t sign in to that profile.")
            }
        } catch {
            return .failed("Couldn’t reach the server.")
        }
    }

    /// Idle-return / manual switch: drop the current person and show the picker again,
    /// keeping the device paired.
    func returnToPicker(sync: SyncManager) async {
        await dropToPicker(sync: sync)
    }

    /// The device pairing was rejected by the server (revoked or unknown — e.g. an admin
    /// unpaired this kiosk from the web). Forget it locally so the iPad falls back to the
    /// normal login screen instead of a dead picker. Mirrors the web's `clearKioskDevice`
    /// on a failed device-token refresh.
    func handleDeviceRevoked() {
        KioskDeviceStore.clear()
        isShared = false
        hasProfile = AuthTokens.isSignedIn
    }

    /// Fully un-kiosk this iPad: forget the device identity and the person session,
    /// returning to the normal login screen (admin-confirmed in Settings).
    func unpair(sync: SyncManager, session: Session) async {
        KioskDeviceStore.clear()
        isShared = false
        await dropToPicker(sync: sync)
        await session.signOut()
    }

    /// Drop the per-person session + tear down the live sync (no server revoke — the
    /// next claim re-scopes it). Leaves the device pairing intact.
    private func dropToPicker(sync: SyncManager) async {
        AuthTokens.clear()
        hasProfile = false
        await sync.signOut()
    }
}
