import Foundation
import Observation

/// Local device-credential mutations at kiosk boundaries. Profile credentials belong
/// to `Session`, so tests can verify a failed purge leaves both identities untouched.
struct KioskLocalCredentials {
    let clearDevice: () -> Void

    static let live = KioskLocalCredentials(
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
    func enableViaPromote(
        label: String?,
        sync: SyncManager,
        session: Session,
        policy: SyncManager.PrincipalExitPolicy
    ) async -> String? {
        let sourceScope = sync.restDataScopeKey
        do {
            let pairing = try await api.promoteDevice(label: label)
            // Keep the authenticated shell in place while the atomic pending-write
            // check runs. Only expose the picker/login after the mirror and reminders
            // are gone; `Session.signOut` would flip to a loading auth gate too early.
            let result = await sync.signOut(policy: policy, expectedScope: sourceScope)
            guard result == .completed else {
                return principalExitError(result, sync: sync)
            }
            session.completeIsolatedPrincipalExit()
            // Persist the pairing only after the old mirror is gone. If teardown fails,
            // a relaunch therefore cannot expose a picker backed by uncleared rows.
            KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label)
            isShared = true; hasProfile = false; deviceLabel = label
            return nil
        } catch let WaffledAPI.APIError.http(code, _) {
            return code == 403 ? "Only an admin can turn this iPad into a kiosk." : "Couldn’t set up the kiosk (error \(code))."
        } catch {
            return "Couldn’t reach the server to set up the kiosk."
        }
    }

    /// Pair a fresh iPad as a shared kiosk with a one-time code, then show the picker.
    func enableViaCode(
        _ code: String,
        label: String?,
        sync: SyncManager,
        session: Session,
        policy: SyncManager.PrincipalExitPolicy
    ) async -> String? {
        let sourceScope = sync.restDataScopeKey
        do {
            let pairing = try await api.pairDevice(code: code, label: label)
            let result = await sync.signOut(policy: policy, expectedScope: sourceScope)
            guard result == .completed else {
                return principalExitError(result, sync: sync)
            }
            session.completeIsolatedPrincipalExit()
            KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label)
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
            let result = await sync.reauthenticate(
                expectedScope: sourceScope,
                policy: .requireNoPendingUploads,
                adoptCredentials: {
                session.enterClaimedSession(access: claim.accessToken, refresh: claim.refreshToken)
            })
            guard result == .completed else {
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
    func returnToPicker(
        sync: SyncManager,
        session: Session,
        policy: SyncManager.PrincipalExitPolicy
    ) async -> SyncManager.PrincipalExitResult {
        let result = await sync.signOut(policy: policy)
        if result == .completed {
            session.completeIsolatedPrincipalExit()
            hasProfile = false
        }
        return result
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
    func handleDeviceRevoked(session: Session) {
        localCredentials.clearDevice()
        isShared = false
        hasProfile = false
        session.completeIsolatedPrincipalExit()
    }

    /// Fully un-kiosk this iPad: forget the device identity and the person session,
    /// returning to the normal login screen (admin-confirmed in Settings).
    @discardableResult
    func unpair(
        sync: SyncManager,
        session: Session,
        policy: SyncManager.PrincipalExitPolicy
    ) async -> SyncManager.PrincipalExitResult {
        let result = await sync.signOut(policy: policy)
        guard result == .completed else { return result }
        session.completeIsolatedPrincipalExit()
        localCredentials.clearDevice()
        isShared = false
        hasProfile = false
        return .completed
    }

    private func principalExitError(
        _ result: SyncManager.PrincipalExitResult,
        sync: SyncManager
    ) -> String {
        switch result {
        case let .pendingUploads(count):
            return "Wait for \(count) change\(count == 1 ? "" : "s") to finish syncing, then try again."
        case .purgeFailed:
            return sync.lastError ?? "Couldn’t safely clear the previous account’s local data."
        case .transitionInProgress:
            return "Another account change is still finishing. Try again."
        case .completed:
            return ""
        }
    }
}
