import Foundation
import Observation

/// Side effects that complete a session sign-out after the local mirror is gone.
/// Injectable so failure-path tests can prove credentials are not removed early.
struct SessionSignOutCredentials {
    let refreshToken: () -> String?
    let clear: () -> Void
    let markSignedOut: () -> Void

    static let live = SessionSignOutCredentials(
        refreshToken: { AuthTokens.refreshToken },
        clear: { AuthTokens.clear() },
        markSignedOut: { AppConfig.markSignedOut() }
    )
}

/// The app's auth state machine: are we still checking, showing login, or in?
/// Gates the whole UI from `AuthGate`. Tokens live in the Keychain (`AuthTokens`);
/// this just drives navigation and the login/logout round-trips.
@MainActor
@Observable
final class Session {
    enum Phase: Equatable { case loading, login, authed }

    private(set) var phase: Phase
    /// Server capabilities (initialized? which sign-in methods) — drives the login UI.
    private(set) var status: WaffledAPI.AuthStatus?

    private let api = WaffledAPI()
    private let signOutCredentials: SessionSignOutCredentials

    init(
        initialPhase: Phase = .loading,
        signOutCredentials: SessionSignOutCredentials = .live
    ) {
        phase = initialPhase
        self.signOutCredentials = signOutCredentials
    }

    /// Decide the initial screen on launch. A real session (or a dev/env token for
    /// headless demos) goes straight in; otherwise we probe `/auth/status` and show
    /// login.
    func bootstrap() async {
        // QA/demo: force the login screen. Clears any real session but leaves a
        // pasted dev token in place (so a normal next launch signs back in).
        if DemoHooks.resetAuth {
            AuthTokens.clear()
        } else if AppConfig.hasUsableToken {
            phase = .authed
            return
        }
        status = try? await api.authStatus()
        phase = .login
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

    /// Tear down auth and sync as one principal boundary. The loading gate prevents a
    /// new login from starting while the previous PowerSync connection is still being
    /// disconnected; `SyncManager.signOut` rotates the REST scope before it suspends.
    /// Credentials remain installed until the local mirror is gone so a failed purge
    /// cannot expose either a login screen or a different principal.
    @discardableResult
    func signOut(sync: SyncManager) async -> Bool {
        guard case .authed = phase else { return false }
        let refresh = signOutCredentials.refreshToken()
        phase = .loading
        guard await sync.signOut() else {
            // Fail closed on the previous principal. Re-entering the authenticated gate
            // also lets a later manual/expiry attempt retry the local deletion.
            phase = .authed
            return false
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
        return true
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
