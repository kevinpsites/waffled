import Foundation
import Observation

/// The app's auth state machine: are we still checking, showing login, or in?
/// Gates the whole UI from `AuthGate`. Tokens live in the Keychain (`AuthTokens`);
/// this just drives navigation and the login/logout round-trips.
@MainActor
@Observable
final class Session {
    enum Phase { case loading, login, authed }

    private(set) var phase: Phase = .loading
    /// Server capabilities (initialized? which sign-in methods) — drives the login UI.
    private(set) var status: NookAPI.AuthStatus?

    private let api = NookAPI()

    init() {
        // A dead refresh token (caught mid-request) drops us back to login.
        NotificationCenter.default.addObserver(forName: .nookAuthExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.handleExpiry() }
        }
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
        } catch let NookAPI.APIError.http(code, _) {
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
        guard let callback = await launcher.authorize(url: api.oidcStartURL(), scheme: "nook") else {
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
        } catch let NookAPI.APIError.http(status, _) {
            return status == 403
                ? "This account isn't invited to this household yet."
                : "Couldn't finish single sign-on (error \(status))."
        } catch {
            return "Couldn't reach the server to finish sign-in."
        }
    }

    /// Return to login immediately, then revoke + re-probe in the background. Clearing
    /// the Keychain and flipping `phase` first makes sign-out feel instant and tears
    /// down the authed UI before any network work (no waiting on a slow revoke).
    func signOut() async {
        let refresh = AuthTokens.refreshToken
        AuthTokens.clear()
        AppConfig.markSignedOut()   // else the dev-token fallback re-auths us
        phase = .login
        if let refresh { await api.revoke(refreshToken: refresh) }   // best-effort
        status = try? await api.authStatus()
    }

    /// Adopt a per-person session minted by the kiosk profile picker (the device-token
    /// claim already returned the tokens). Flips the gate to authed without a password
    /// round-trip — the kiosk equivalent of `login()`.
    func enterClaimedSession(access: String, refresh: String) {
        AuthTokens.save(access: access, refresh: refresh)
        AppConfig.clearSignedOut()
        phase = .authed
    }

    /// Re-probe server status (e.g. after editing the server URL on the login screen).
    func refreshStatus() async {
        status = try? await api.authStatus()
    }

    private func handleExpiry() async {
        // Tokens were already cleared by the refresher; just surface login.
        guard phase == .authed else { return }
        status = try? await api.authStatus()
        phase = .login
    }
}
