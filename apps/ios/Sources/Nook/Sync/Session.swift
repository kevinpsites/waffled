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
