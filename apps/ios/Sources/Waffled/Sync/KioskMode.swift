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
    private(set) var principalTransitionInProgress = false
    private(set) var deviceIdentityError: String?

    private let claimProfileRequest: @MainActor (String, String?) async throws -> WaffledAPI.KioskClaim
    private let promoteDeviceRequest: @MainActor (String?) async throws -> WaffledAPI.DevicePairing
    private let pairDeviceRequest: @MainActor (String, String?) async throws -> WaffledAPI.DevicePairing
    private var nextClaimNonce: UInt64 = 0
    private var activeClaimNonce: UInt64?

    /// Show the picker when we're a kiosk with nobody currently claimed in.
    var needsPicker: Bool {
        isShared && !hasProfile && !principalTransitionInProgress &&
            !AppConfig.principalIsolationRequired
    }
    /// The picker/PIN pad owns its visible busy state while the device request runs.
    /// This separate flag serializes requests without replacing that UI with the
    /// neutral principal-transition gate prematurely.
    var claimInFlight: Bool { activeClaimNonce != nil }

    init(
        claimProfileRequest: (@MainActor (String, String?) async throws -> WaffledAPI.KioskClaim)? = nil,
        promoteDeviceRequest: (@MainActor (String?) async throws -> WaffledAPI.DevicePairing)? = nil,
        pairDeviceRequest: (@MainActor (String, String?) async throws -> WaffledAPI.DevicePairing)? = nil
    ) {
        self.claimProfileRequest = claimProfileRequest ?? { personId, pin in
            try await WaffledAPI().claimProfile(personId: personId, pin: pin)
        }
        self.promoteDeviceRequest = promoteDeviceRequest ?? { label in
            try await WaffledAPI().promoteDevice(label: label)
        }
        self.pairDeviceRequest = pairDeviceRequest ?? { code, label in
            try await WaffledAPI().pairDevice(code: code, label: label)
        }
        isShared = KioskDeviceStore.isPaired
        // A crash/relaunch during mandatory expiry isolation must keep the outer
        // KioskGate away from the picker until the residual replica is purged.
        hasProfile = AuthTokens.isSignedIn || AppConfig.principalIsolationRequired
        deviceLabel = KioskDeviceStore.label
        // A dead per-person refresh token on a shared kiosk should drop to the picker,
        // not the login screen — but only after the prior profile's local replica has
        // been purged. Reacting to the raw expiry event would expose the next-person
        // gate while the previous person's data was still on disk.
        NotificationCenter.default.addObserver(forName: .waffledPrincipalIsolated, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.hasProfile = false
                self?.principalTransitionInProgress = false
            }
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
    func enableViaPromote(label: String?, sync: SyncManager, session: Session) async -> String? {
        let requestBaseURL = AppConfig.apiBaseURL
        let sourceScope = AppConfig.currentIdentityScope
        let sourceDevice = KioskDeviceStore.snapshot()
        do {
            let pairing = try await promoteDeviceRequest(label)
            guard requestContextIsCurrent(
                baseURL: requestBaseURL, identityScope: sourceScope, device: sourceDevice
            ) else { return "This kiosk setup was superseded. Try again." }
            principalTransitionInProgress = true
            let result = await session.signOut(sync: sync, policy: .securityCritical)
            guard result == .completed else {
                if result != .purgeFailed { principalTransitionInProgress = false }
                return "Couldn’t safely clear the previous account’s local data."
            }
            guard isolatedContextIsCurrent(
                baseURL: requestBaseURL, device: sourceDevice, session: session
            ) else {
                principalTransitionInProgress = AppConfig.principalIsolationRequired
                return "This kiosk setup was superseded. Try again."
            }
            guard KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label) else {
                return "Couldn’t securely save this kiosk’s device identity."
            }
            deviceIdentityError = nil
            isShared = true; hasProfile = false; principalTransitionInProgress = false; deviceLabel = label
            return nil
        } catch let WaffledAPI.APIError.http(code, _) {
            return code == 403 ? "Only an admin can turn this iPad into a kiosk." : "Couldn’t set up the kiosk (error \(code))."
        } catch {
            return "Couldn’t reach the server to set up the kiosk."
        }
    }

    /// Pair a fresh iPad as a shared kiosk with a one-time code, then show the picker.
    func enableViaCode(_ code: String, label: String?, sync: SyncManager, session: Session) async -> String? {
        let requestBaseURL = AppConfig.apiBaseURL
        let sourceScope = AppConfig.currentIdentityScope
        let sourceDevice = KioskDeviceStore.snapshot()
        do {
            let pairing = try await pairDeviceRequest(code, label)
            guard requestContextIsCurrent(
                baseURL: requestBaseURL, identityScope: sourceScope, device: sourceDevice
            ) else { return "This kiosk setup was superseded. Try again." }
            principalTransitionInProgress = true
            // A fresh picker normally has no person session, but still run the same
            // serialized mirror boundary before installing the device identity.
            session.prepareForPrincipalTransition()
            let result = await sync.signOut(policy: .securityCritical, expectedIdentityScope: sourceScope)
            guard result == .completed else {
                if result != .purgeFailed { principalTransitionInProgress = false }
                return "Couldn’t safely clear data left by the previous account."
            }
            guard session.completeIsolatedPrincipalExit() else {
                return "Couldn’t securely finish clearing the previous session."
            }
            guard isolatedContextIsCurrent(
                baseURL: requestBaseURL, device: sourceDevice, session: session
            ) else {
                principalTransitionInProgress = AppConfig.principalIsolationRequired
                return "This kiosk setup was superseded. Try again."
            }
            guard KioskDeviceStore.savePaired(secret: pairing.deviceSecret, label: label) else {
                return "Couldn’t securely save this kiosk’s device identity."
            }
            deviceIdentityError = nil
            isShared = true; hasProfile = false; principalTransitionInProgress = false; deviceLabel = label
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
        guard activeClaimNonce == nil else {
            return .failed("Another profile sign-in is already finishing.")
        }
        nextClaimNonce &+= 1
        let claimNonce = nextClaimNonce
        activeClaimNonce = claimNonce
        defer {
            if activeClaimNonce == claimNonce {
                activeClaimNonce = nil
                // A failed replica purge deliberately leaves Session on its neutral
                // loading gate. Keep the outer kiosk gate neutral too; otherwise
                // `needsPicker` would override Session and expose the next-person
                // picker before the previous replica was confirmed deleted.
                if !AppConfig.principalIsolationRequired, session.phase != .loading {
                    principalTransitionInProgress = false
                }
            }
        }

        let sourceScope = AppConfig.currentIdentityScope
        let deviceSnapshot = KioskDeviceStore.snapshot()
        guard deviceSnapshot.secret != nil else {
            return .failed("This kiosk is no longer paired.")
        }
        do {
            let claim = try await claimProfileRequest(profile.id, pin)
            // The claim response itself is device-authorized. Binding only the token
            // mint is insufficient: an A response delayed across clear/re-pair B must
            // never install A's per-person session under B's kiosk identity.
            guard KioskDeviceStore.isCurrent(deviceSnapshot) else {
                return .failed("This kiosk identity changed. Try again.")
            }
            let candidate = AuthTokens.Candidate(
                accessToken: claim.accessToken,
                refreshToken: claim.refreshToken,
                memberType: claim.person?.memberType,
                accessExpiry: claim.person?.accessExpiry ?? .missing
            )
            guard candidate.isValid else { return .failed("The server returned incomplete access details.") }
            guard KioskDeviceStore.isCurrent(deviceSnapshot) else {
                return .failed("This kiosk identity changed. Try again.")
            }
            // The device request has completed and the picker/PIN pad has shown its
            // spinner throughout. Only credential replacement needs the neutral gate.
            principalTransitionInProgress = true
            let error = await session.adoptCandidate(
                candidate,
                sourceScope: sourceScope,
                sync: sync,
                policy: .securityCritical,
                credentialContextIsCurrent: { [weak self] in
                    self?.activeClaimNonce == claimNonce &&
                        KioskDeviceStore.isCurrent(deviceSnapshot)
                }
            )
            guard error == nil else {
                return .failed(error!)
            }
            guard claimContextIsCurrent(nonce: claimNonce, device: deviceSnapshot) else {
                await session.isolateCurrentPrincipal()
                return .failed("This kiosk identity changed. Try again.")
            }
            hasProfile = true
            return .ok
        } catch let e as WaffledAPI.KioskClaimError {
            guard claimContextIsCurrent(nonce: claimNonce, device: deviceSnapshot) else {
                return .failed("This kiosk identity changed. Try again.")
            }
            switch e {
            case let .wrongPin(t):   return .wrongPin(triesLeft: t)
            case let .lockedOut(r):  return .lockedOut(retryAfter: r)
            case .notFound:          return .failed("That profile is no longer available.")
            case let .other(m):      return .failed(m.isEmpty ? "Couldn’t sign in to that profile." : "Couldn’t sign in to that profile.")
            }
        } catch {
            guard claimContextIsCurrent(nonce: claimNonce, device: deviceSnapshot) else {
                return .failed("This kiosk identity changed. Try again.")
            }
            return .failed("Couldn’t reach the server.")
        }
    }

    private func claimContextIsCurrent(
        nonce: UInt64, device: KioskDeviceStore.Snapshot
    ) -> Bool {
        activeClaimNonce == nonce && KioskDeviceStore.isCurrent(device)
    }

    private func requestContextIsCurrent(
        baseURL: String, identityScope: String?, device: KioskDeviceStore.Snapshot
    ) -> Bool {
        AppConfig.apiBaseURL == baseURL &&
            AppConfig.currentIdentityScope == identityScope &&
            KioskDeviceStore.isCurrent(device)
    }

    /// After a successful principal exit, the source envelope is intentionally gone.
    /// The transition itself verified its original identity scope through the purge;
    /// this final check ensures no replacement session/server/device appeared before
    /// the pairing secret's atomic Keychain write.
    private func isolatedContextIsCurrent(
        baseURL: String, device: KioskDeviceStore.Snapshot, session: Session
    ) -> Bool {
        AppConfig.apiBaseURL == baseURL && session.phase == .login &&
            !AuthTokens.isSignedIn &&
            KioskDeviceStore.isCurrent(device)
    }

    /// Idle-return / manual switch: drop the current person and show the picker again,
    /// keeping the device paired.
    func returnToPicker(sync: SyncManager, session: Session) async {
        principalTransitionInProgress = true
        let result = await session.signOut(sync: sync, policy: .requireNoPendingUploads)
        if result == .completed {
            hasProfile = false
            principalTransitionInProgress = false
        } else if result != .purgeFailed {
            principalTransitionInProgress = false
        }
    }

    /// The device pairing was rejected by the server (revoked or unknown — e.g. an admin
    /// unpaired this kiosk from the web). Forget it locally so the iPad falls back to the
    /// normal login screen instead of a dead picker. Mirrors the web's `clearKioskDevice`
    /// on a failed device-token refresh.
    @discardableResult
    func handleDeviceRevoked(expectedDevice: KioskDeviceStore.Snapshot? = nil) -> Bool {
        // A delayed 401/NotPaired from device A must never clear a newly paired B.
        let clearResult = expectedDevice.map { KioskDeviceStore.clear(ifCurrent: $0) }
            ?? (KioskDeviceStore.clear() ? .cleared : .failed)
        if clearResult == .superseded { return false }
        guard clearResult == .cleared else {
            // The durable secret is authoritative. Keep the UI in paired mode so a
            // failed Keychain delete cannot reappear as a surprise pairing on launch.
            isShared = true
            hasProfile = false
            principalTransitionInProgress = false
            deviceIdentityError = "Couldn’t securely remove this kiosk identity. Try again."
            return false
        }
        isShared = false
        hasProfile = AuthTokens.isSignedIn || AppConfig.principalIsolationRequired
        deviceIdentityError = nil
        return true
    }

    /// Fully un-kiosk this iPad: forget the device identity and the person session,
    /// returning to the normal login screen (admin-confirmed in Settings).
    @discardableResult
    func unpair(sync: SyncManager, session: Session) async -> Bool {
        let expectedDevice = KioskDeviceStore.snapshot()
        principalTransitionInProgress = true
        let result = await session.signOut(sync: sync, policy: .requireNoPendingUploads)
        guard result == .completed else {
            if result != .purgeFailed { principalTransitionInProgress = false }
            return false
        }
        let clearResult = KioskDeviceStore.clear(ifCurrent: expectedDevice)
        if clearResult == .superseded {
            // The requested A unpair already completed its person-session isolation,
            // but B's pairing won while that work was suspended and belongs to the
            // current device. Leave B intact and let its picker remain authoritative.
            isShared = KioskDeviceStore.isPaired
            hasProfile = false
            principalTransitionInProgress = false
            deviceIdentityError = "The kiosk identity changed while unpairing. Try again."
            return false
        }
        guard clearResult == .cleared else {
            isShared = true
            hasProfile = false
            principalTransitionInProgress = false
            deviceIdentityError = "Couldn’t securely remove this kiosk identity. Try again."
            return false
        }
        isShared = false
        hasProfile = false
        principalTransitionInProgress = false
        deviceIdentityError = nil
        return true
    }
}
