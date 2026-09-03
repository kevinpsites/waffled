import Foundation
import Observation

/// Local credential mutations at kiosk boundaries. Injectable so tests can verify a
/// failed database purge leaves both the profile and device identities untouched.
struct KioskLocalCredentials {
    let clearProfile: () -> Void
    let clearDevice: () -> Void

    static let live = KioskLocalCredentials(
        clearProfile: { AuthTokens.clear() },
        clearDevice: { KioskDeviceStore.clear() }
    )
}

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
    private let localCredentials: KioskLocalCredentials

    /// Show the picker when we're a kiosk with nobody currently claimed in.
    var needsPicker: Bool { isShared && !hasProfile }

    init() {
        isShared = KioskDeviceStore.isPaired
        hasProfile = AuthTokens.isSignedIn
        deviceLabel = KioskDeviceStore.label
        localCredentials = .live
    }

    /// Deterministic state/side-effect seam for principal-boundary tests.
    init(
        testIsShared: Bool,
        testHasProfile: Bool,
        localCredentials: KioskLocalCredentials
    ) {
        isShared = testIsShared
        hasProfile = testHasProfile
        deviceLabel = nil
        self.localCredentials = localCredentials
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
            guard await clearPreviousProfile(sync: sync) else {
                return sync.lastError ?? "Couldn’t safely clear the previous account’s local data."
            }
            // Persist the pairing only after the old mirror is gone. If teardown fails,
            // a relaunch therefore cannot expose a picker backed by uncleared rows.
            KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label)
            localCredentials.clearProfile()
            isShared = true; hasProfile = false; deviceLabel = label
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
            guard await clearPreviousProfile(sync: sync) else {
                return sync.lastError ?? "Couldn’t safely clear the previous account’s local data."
            }
            KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label)
            localCredentials.clearProfile()
            isShared = true; hasProfile = false; deviceLabel = label
            if let label, !label.isEmpty { try? await api.setKioskDeviceLabel(label) }
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
        // Bind the claim response to the session that made the request. A sign-out or
        // other principal transition while the request is in flight revokes this lease.
        let sourceScope = sync.restDataScopeKey
        do {
            let claim = try await api.claimProfile(personId: profile.id, pin: pin)
            guard await sync.reauthenticate(expectedScope: sourceScope, adoptCredentials: {
                session.enterClaimedSession(access: claim.accessToken, refresh: claim.refreshToken)
            }) else {
                return .failed("Couldn’t safely finish switching profiles. Try again.")
            }
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
    @discardableResult
    func returnToPicker(sync: SyncManager) async -> Bool {
        await dropToPicker(sync: sync)
    }

    /// Complete an account-expiry transition after the shared database has been
    /// cleared. The app-level session coordinator calls this only on teardown success,
    /// so a failed purge can never expose the next profile picker.
    func completeProfileSignOut() {
        hasProfile = false
    }

    /// The device pairing was rejected by the server (revoked or unknown — e.g. an admin
    /// unpaired this kiosk from the web). Forget it locally so the iPad falls back to the
    /// normal login screen instead of a dead picker. Mirrors the web's `clearKioskDevice`
    /// on a failed device-token refresh.
    func handleDeviceRevoked() {
        localCredentials.clearDevice()
        isShared = false
        hasProfile = AuthTokens.isSignedIn
    }

    /// Fully un-kiosk this iPad: forget the device identity and the person session,
    /// returning to the normal login screen (admin-confirmed in Settings).
    @discardableResult
    func unpair(sync: SyncManager, session: Session) async -> Bool {
        guard await session.signOut(sync: sync) else { return false }
        localCredentials.clearDevice()
        isShared = false
        hasProfile = false
        return true
    }

    /// Drop the per-person session + tear down the live sync (no server revoke — the
    /// next claim re-scopes it). Leaves the device pairing intact.
    private func dropToPicker(sync: SyncManager) async -> Bool {
        // Clear the previous profile's mirror before exposing the shared picker or
        // accepting another profile. Same-household identities are still separate
        // privacy principals.
        guard await clearPreviousProfile(sync: sync) else { return false }
        localCredentials.clearProfile()
        hasProfile = false
        return true
    }

    private func clearPreviousProfile(sync: SyncManager) async -> Bool {
        await sync.signOut()
    }
}
