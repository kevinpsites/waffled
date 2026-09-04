import Foundation
import Observation

/// Side effects that complete a session sign-out after the local mirror is gone.
/// Injectable so failure-path tests can prove credentials are not removed early.
struct SessionSignOutCredentials {
    let refreshToken: () -> String?
    let clear: () -> Void
    let markSignedOut: () -> Void
    let isCurrent: (AuthTokens.RefreshLease) -> Bool

    init(
        refreshToken: @escaping () -> String?,
        clear: @escaping () -> Void,
        markSignedOut: @escaping () -> Void,
        isCurrent: @escaping (AuthTokens.RefreshLease) -> Bool = { _ in true }
    ) {
        self.refreshToken = refreshToken
        self.clear = clear
        self.markSignedOut = markSignedOut
        self.isCurrent = isCurrent
    }

    static let live = SessionSignOutCredentials(
        refreshToken: { AuthTokens.refreshToken },
        clear: { AuthTokens.clear() },
        markSignedOut: { AppConfig.markSignedOut() },
        isCurrent: { AuthTokens.isCurrent($0) }
    )
}

/// Persisted launch-boundary state, injectable so migration behavior can be proven
/// without mutating process-wide Keychain/UserDefaults state in parallel tests.
struct SessionBootstrapState {
    let hasUsableToken: () -> Bool
    let migrationIsComplete: () -> Bool
    let markMigrationComplete: () -> Void
    let loadAuthStatus: () async -> WaffledAPI.AuthStatus?

    static let live = SessionBootstrapState(
        hasUsableToken: { AppConfig.hasUsableToken },
        migrationIsComplete: { PrincipalIsolationMigration.isComplete },
        markMigrationComplete: { PrincipalIsolationMigration.markComplete() },
        loadAuthStatus: { try? await WaffledAPI().authStatus() }
    )
}

/// The app's auth state machine: are we still checking, showing login, or in?
/// Gates the whole UI from `AuthGate`. Tokens live in the Keychain (`AuthTokens`);
/// this just drives navigation and the login/logout round-trips.
@MainActor
@Observable
final class Session {
    enum Phase: Equatable { case loading, login, authed }
    enum BootstrapResult: Equatable {
        case ready
        case pendingMigrationUploads(Int)
        case purgeFailed
    }

    private(set) var phase: Phase
    /// Server capabilities (initialized? which sign-in methods) — drives the login UI.
    private(set) var status: WaffledAPI.AuthStatus?

    private let api = WaffledAPI()
    private let signOutCredentials: SessionSignOutCredentials
    private let bootstrapState: SessionBootstrapState

    init(
        initialPhase: Phase = .loading,
        signOutCredentials: SessionSignOutCredentials = .live,
        bootstrapState: SessionBootstrapState = .live
    ) {
        phase = initialPhase
        self.signOutCredentials = signOutCredentials
        self.bootstrapState = bootstrapState
    }

    /// Clear any unowned/legacy mirror before the app renders either login or the kiosk
    /// picker. A valid upgraded session first connects behind the blocking gate so its
    /// queued writes can flush; the user must explicitly authorize discarding any that
    /// remain. The migration marker is written only after an actual successful purge.
    func bootstrap(
        sync: SyncManager,
        kioskNeedsPicker: Bool,
        discardMigrationUploads: Bool = false
    ) async -> BootstrapResult {
        phase = .loading
        // QA/demo: force the login screen. Clears any real session but leaves a
        // pasted dev token in place (so a normal next launch signs back in).
        let forceLogin = DemoHooks.resetAuth
        if forceLogin {
            AuthTokens.clear()
        }

        let needsPrincipalSelection = forceLogin || kioskNeedsPicker || !bootstrapState.hasUsableToken()
        let needsMigration = !bootstrapState.migrationIsComplete()
        if needsMigration || needsPrincipalSelection {
            let policy: SyncManager.PrincipalExitPolicy
            if needsPrincipalSelection {
                policy = .securityCritical
            } else if discardMigrationUploads {
                policy = .discardAuthorized
            } else {
                // Hidden by the app-level isolation gate: stale rows may load only so
                // PowerSync can flush this still-valid principal's queued writes.
                await sync.start()
                policy = .requireNoPendingUploads
            }
            switch await sync.signOut(policy: policy) {
            case .completed:
                if needsMigration { bootstrapState.markMigrationComplete() }
            case let .pendingUploads(count):
                return .pendingMigrationUploads(count)
            case .purgeFailed, .transitionInProgress:
                return .purgeFailed
            }
        }

        if !forceLogin, bootstrapState.hasUsableToken(), !kioskNeedsPicker {
            phase = .authed
            return .ready
        }
        status = await bootstrapState.loadAuthStatus()
        phase = .login
        return .ready
    }

    /// Attempt a password login. Returns a user-facing error string, or nil on success.
    func login(email: String, password: String) async -> String? {
        let email = email.trimmingCharacters(in: .whitespaces)
        guard !email.isEmpty, !password.isEmpty else { return "Enter your email and password." }
        do {
            let s = try await api.login(email: email, password: password)
            AuthTokens.save(access: s.accessToken, refresh: s.refreshToken)
            AppConfig.clearSignedOut()
            phase = .authed
            return nil
        } catch let WaffledAPI.APIError.http(code, _) {
            return code == 401 ? "Wrong email or password." : "Couldn’t sign in (error \(code))."
        } catch {
            return "Couldn’t reach the server. Check the address and your connection."
        }
    }

    /// Sign in via backend-mediated OIDC: open the provider in a secure web session,
    /// capture the deep-link `code`, and exchange it for a session. Returns a
    /// user-facing error string, or nil on success.
    func loginWithOIDC() async -> String? {
        let launcher = OAuthLauncher()
        guard let startURL = try? api.oidcStartURL() else {
            return "Enter a valid server address beginning with http:// or https://."
        }
        guard let callback = await launcher.authorize(url: startURL, scheme: "waffled") else {
            return nil   // user cancelled the sheet — no error
        }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
        // The backend bounces invite-gating / verification failures back through the
        // deep link as `error` + `error_description` (instead of a dead-end web page).
        if let err = items?.first(where: { $0.name == "error" })?.value {
            let detail = items?.first(where: { $0.name == "error_description" })?.value
            return detail ?? (err == "not_invited"
                ? "This account isn't invited to this household yet."
                : "Single sign-on didn't complete. Please try again.")
        }
        guard let code = items?.first(where: { $0.name == "code" })?.value else {
            return "Sign-in didn't complete. Please try again."
        }
        do {
            let s = try await api.oidcExchange(code: code)
            AuthTokens.save(access: s.accessToken, refresh: s.refreshToken)
            AppConfig.clearSignedOut()
            phase = .authed
            return nil
        } catch let WaffledAPI.APIError.http(status, _) {
            return status == 403
                ? "This account isn't invited to this household yet."
                : "Couldn't finish single sign-on (error \(status))."
        } catch {
            return "Couldn't reach the server to finish sign-in."
        }
    }

    /// Tear down auth and sync as one principal boundary. `SyncManager.signOut` freezes
    /// local writes and rotates the REST scope before it suspends. Manual callers keep
    /// their current view alive so an exact pending-count race or purge failure can be
    /// surfaced there; an authoritative credential expiry opts into the neutral gate.
    /// Credentials remain installed until the local mirror is gone so a failed purge
    /// cannot expose either a login screen or a different principal.
    @discardableResult
    func signOut(
        sync: SyncManager,
        policy: SyncManager.PrincipalExitPolicy,
        expectedRefreshLease: AuthTokens.RefreshLease? = nil,
        blocksAuthenticatedUI: Bool = false
    ) async -> SyncManager.PrincipalExitResult {
        guard case .authed = phase else { return .transitionInProgress }
        if let expectedRefreshLease, !signOutCredentials.isCurrent(expectedRefreshLease) {
            return .transitionInProgress
        }
        let refresh = signOutCredentials.refreshToken()
        if blocksAuthenticatedUI { phase = .loading }
        let result = await sync.signOut(policy: policy)
        guard result == .completed else {
            // Fail closed on the previous principal. Re-entering the authenticated gate
            // also lets a later manual/expiry attempt retry the local deletion.
            if blocksAuthenticatedUI { phase = .authed }
            return result
        }
        signOutCredentials.clear()
        signOutCredentials.markSignedOut() // else the dev-token fallback re-auths us
        phase = .login

        // Revocation/status are best-effort and must not keep the login screen gated.
        // Ignore the late status if the user has already completed a new login.
        Task { [weak self] in
            guard let self else { return }
            if let refresh { await self.api.revoke(refreshToken: refresh) }
            let refreshedStatus = try? await self.api.authStatus()
            guard case .login = self.phase else { return }
            self.status = refreshedStatus
        }
        return .completed
    }

    /// Complete a kiosk boundary whose serialized purge/notification cleanup already
    /// succeeded, without running a second database teardown. Callers invoke this only
    /// before exposing the picker or normal login gate.
    func completeIsolatedPrincipalExit() {
        signOutCredentials.clear()
        signOutCredentials.markSignedOut()
        phase = .login
    }

    /// Adopt a freshly-minted session without a password round-trip — used by the kiosk
    /// profile picker (a per-person device claim) and the household switcher (a new
    /// access/refresh pair carrying the target household's claim). Saves the tokens and
    /// flips/keeps the gate at authed.
    func enterClaimedSession(access: String, refresh: String) {
        AuthTokens.save(access: access, refresh: refresh)
        AppConfig.clearSignedOut()
        phase = .authed
    }

    /// Re-probe server status (e.g. after editing the server URL on the login screen).
    func refreshStatus() async {
        status = try? await api.authStatus()
    }

}
