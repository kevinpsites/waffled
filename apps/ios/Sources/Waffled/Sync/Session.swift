import Foundation
import Observation
import UIKit

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

    private let api: WaffledAPI
    /// Removes the prior principal's PowerSync replica before an expired session may
    /// expose either signed-out gate. `nil` deliberately fails closed: production
    /// wires this to `SyncManager.isolateExpiredPrincipal`, while isolated unit tests
    /// that never expire a session need no database.
    private let isolateExpiredPrincipal: (@MainActor () async -> Bool)?
    private let now: @MainActor () -> Date
    private var accessExpiryTask: Task<Void, Never>?
    private var expiryIsolationInProgress = false
    private var nextAuthAttemptNonce: UInt64 = 0
    private var activeAuthAttemptNonce: UInt64?

    init(
        initialPhase: Phase = .loading,
        isolateExpiredPrincipal: (@MainActor () async -> Bool)? = nil,
        now: @escaping @MainActor () -> Date = { Date() },
        api: WaffledAPI = WaffledAPI()
    ) {
        phase = initialPhase
        self.isolateExpiredPrincipal = isolateExpiredPrincipal
        self.now = now
        self.api = api
        // A dead refresh token (caught mid-request) drops us back to login.
        NotificationCenter.default.addObserver(forName: .waffledAuthExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.handleExpiry() }
        }
        NotificationCenter.default.addObserver(forName: .waffledAccessPolicyChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.handleAccessPolicyChanged() }
        }
        for name in [UIApplication.willEnterForegroundNotification, UIApplication.significantTimeChangeNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.recheckAccessExpiry() }
            }
        }
    }

    /// Decide the initial screen on launch. A real session (or a dev/env token for
    /// headless demos) goes straight in; otherwise we probe `/auth/status` and show
    /// login.
    func bootstrap() async {
        if AppConfig.principalIsolationRequired {
            await isolateExpiredAccess()
            return
        }
        if currentAccessIsExpired {
            await expireLocalAccess()
            return
        }
        armAccessExpiry()
        // QA/demo: force the login screen. Clears any real session but leaves a
        // pasted dev token in place (so a normal next launch signs back in).
        if DemoHooks.resetAuth {
            AuthTokens.requirePrincipalIsolation()
            await isolateExpiredAccess()
            return
        } else if AppConfig.hasUsableToken {
            phase = .authed
            return
        }
        status = try? await api.authStatus()
        phase = .login
    }

    /// Attempt a password login. Returns a user-facing error string, or nil on success.
    func login(email: String, password: String, sync: SyncManager) async -> String? {
        let email = email.trimmingCharacters(in: .whitespaces)
        guard !email.isEmpty, !password.isEmpty else { return "Enter your email and password." }
        let requestBaseURL = AppConfig.apiBaseURL
        let sourceScope = AppConfig.currentIdentityScope
        let attempt = beginAuthAttempt()
        defer { finishAuthAttempt(attempt) }
        do {
            let s = try await api.login(
                email: email, password: password, baseURL: requestBaseURL
            )
            guard authAttemptIsCurrent(attempt, baseURL: requestBaseURL) else {
                return "The sign-in context changed. Try again."
            }
            guard s.candidate.isValid else { return "The server returned incomplete access details." }
            return await adoptCandidate(
                s.candidate,
                sourceScope: sourceScope,
                sync: sync,
                credentialContextIsCurrent: { [weak self] in
                    self?.authAttemptIsCurrent(attempt, baseURL: requestBaseURL) == true
                }
            )
        } catch let WaffledAPI.APIError.http(code, _) {
            return code == 401 ? "Wrong email or password." : "Couldn’t sign in (error \(code))."
        } catch {
            return "Couldn’t reach the server. Check the address and your connection."
        }
    }

    /// Sign in via backend-mediated OIDC: open the provider in a secure web session,
    /// capture the deep-link `code`, and exchange it for a session. Returns a
    /// user-facing error string, or nil on success.
    func loginWithOIDC(sync: SyncManager) async -> String? {
        let requestBaseURL = AppConfig.apiBaseURL
        let sourceScope = AppConfig.currentIdentityScope
        let attempt = beginAuthAttempt()
        defer { finishAuthAttempt(attempt) }
        let launcher = OAuthLauncher()
        guard let startURL = try? api.oidcStartURL(baseURL: requestBaseURL) else {
            return "Enter a valid server address beginning with http:// or https://."
        }
        guard let callback = await launcher.authorize(url: startURL, scheme: "waffled") else {
            return nil   // user cancelled the sheet — no error
        }
        guard authAttemptIsCurrent(attempt, baseURL: requestBaseURL) else {
            return "The sign-in context changed. Try again."
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
            let s = try await api.oidcExchange(code: code, baseURL: requestBaseURL)
            guard authAttemptIsCurrent(attempt, baseURL: requestBaseURL) else {
                return "The sign-in context changed. Try again."
            }
            guard s.candidate.isValid else { return "The server returned incomplete access details." }
            return await adoptCandidate(
                s.candidate,
                sourceScope: sourceScope,
                sync: sync,
                credentialContextIsCurrent: { [weak self] in
                    self?.authAttemptIsCurrent(attempt, baseURL: requestBaseURL) == true
                }
            )
        } catch let WaffledAPI.APIError.http(status, _) {
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
    @discardableResult
    func signOut(
        sync: SyncManager,
        policy: SyncManager.PrincipalExitPolicy = .requireNoPendingUploads
    ) async -> SyncManager.PrincipalExitResult {
        guard phase == .authed else { return .transitionInProgress }
        let refresh = AuthTokens.refreshToken
        let sourceBaseURL = AppConfig.apiBaseURL
        let sourceScope = AppConfig.currentIdentityScope
        phase = .loading
        let result = await sync.signOut(policy: policy, expectedIdentityScope: sourceScope)
        switch result {
        case .completed:
            guard AuthTokens.clear() else { return .purgeFailed }
            AppConfig.markSignedOut()
            phase = .login
            Task { [weak self] in
                guard let self else { return }
                if let refresh {
                    await self.api.revoke(
                        refreshToken: refresh, baseURL: sourceBaseURL
                    )
                }
                let next = try? await self.api.authStatus()
                guard self.phase == .login else { return }
                self.status = next
            }
        case .pendingUploads, .transitionInProgress:
            await restoreGateUnlessIsolationOwnsIt()
        case .purgeFailed, .credentialAdoptionFailed:
            break
        }
        return result
    }

    /// Adopt a freshly-minted session without a password round-trip — used by the kiosk
    /// profile picker (a per-person device claim) and the household switcher (a new
    /// access/refresh pair carrying the target household's claim). Saves the tokens and
    /// flips/keeps the gate at authed.
    func adoptCandidate(
        _ candidate: AuthTokens.Candidate,
        sourceScope: String?,
        sync: SyncManager,
        policy: SyncManager.PrincipalExitPolicy = .securityCritical,
        credentialContextIsCurrent: @escaping @MainActor () -> Bool = { true }
    ) async -> String? {
        guard candidate.isUsable(at: now()) else {
            return candidate.isValid
                ? "This temporary access has already expired."
                : "The server returned incomplete access details."
        }
        phase = .loading
        var persisted = false
        var adoptedIdentityScope: String?
        let result = await sync.reauthenticate(
            expectedIdentityScope: sourceScope,
            policy: policy,
            adoptCredentials: {
                guard credentialContextIsCurrent() else { return false }
                persisted = AuthTokens.save(
                    access: candidate.accessToken,
                    refresh: candidate.refreshToken,
                    memberType: candidate.memberType,
                    accessExpiry: candidate.accessExpiry
                )
                if persisted {
                    adoptedIdentityScope = AppConfig.currentIdentityScope
                    AppConfig.clearSignedOut()
                }
                return persisted
            }
        )
        switch result {
        case .completed:
            guard persisted else {
                AuthTokens.requirePrincipalIsolation()
                return "Couldn’t securely save the new session."
            }
            // A kiosk/server identity can change while the replacement sync start is
            // suspended. Revalidate after that await, before authenticated UI can be
            // published; if stale, purge the just-installed principal immediately.
            guard let adoptedIdentityScope,
                  AppConfig.currentIdentityScope == adoptedIdentityScope,
                  credentialContextIsCurrent() else {
                AuthTokens.requirePrincipalIsolation()
                await isolateExpiredAccess()
                return "The sign-in context changed. Try again."
            }
            // The deadline may have crossed while the previous replica was draining
            // or while the replacement connection started. Never publish `.authed`
            // until the just-persisted policy has been checked again synchronously.
            if currentAccessIsExpired {
                AuthTokens.requirePrincipalIsolation()
                await isolateExpiredAccess()
                return "This temporary access has expired."
            }
            AppConfig.clearPrincipalIsolationRequirement()
            phase = .authed
            armAccessExpiry()
            return nil
        case let .pendingUploads(count):
            await restoreGateUnlessIsolationOwnsIt()
            return "Wait for \(count) pending change\(count == 1 ? "" : "s") to sync."
        case .transitionInProgress:
            await restoreGateUnlessIsolationOwnsIt()
            return "Another account change is still finishing. Try again."
        case .credentialAdoptionFailed:
            // The previous replica was successfully purged and reauthenticate never
            // started a replacement connection. Remove any residual envelope/latch
            // before making the ordinary login gate visible again.
            _ = completeIsolatedPrincipalExit()
            return "Couldn’t securely save the new session."
        case .purgeFailed:
            return "Couldn’t safely clear the previous account’s local data."
        }
    }

    func prepareForPrincipalTransition() {
        phase = .loading
    }

    private func beginAuthAttempt() -> UInt64 {
        nextAuthAttemptNonce &+= 1
        activeAuthAttemptNonce = nextAuthAttemptNonce
        return nextAuthAttemptNonce
    }

    private func finishAuthAttempt(_ nonce: UInt64) {
        if activeAuthAttemptNonce == nonce { activeAuthAttemptNonce = nil }
    }

    private func authAttemptIsCurrent(_ nonce: UInt64, baseURL: String) -> Bool {
        activeAuthAttemptNonce == nonce && AppConfig.apiBaseURL == baseURL
    }

    @discardableResult
    func completeIsolatedPrincipalExit() -> Bool {
        guard AuthTokens.clear() else { return false }
        AppConfig.clearPrincipalIsolationRequirement()
        AppConfig.markSignedOut()
        phase = .login
        return true
    }

    /// Reject credentials that became stale after their commit (for example when a
    /// kiosk was re-paired while sync startup was suspended). The neutral gate is
    /// retained until the newly connected replica and envelope are both removed.
    func isolateCurrentPrincipal() async {
        phase = .loading
        AuthTokens.requirePrincipalIsolation()
        await isolateExpiredAccess()
    }

    /// A security-critical expiry may supersede an ordinary replacement while its
    /// connection start is suspended. Only the isolation task may release the neutral
    /// gate; the superseded operation must not briefly expose login or authenticated UI.
    private func restoreGateUnlessIsolationOwnsIt() async {
        if currentAccessIsExpired {
            phase = .loading
            AuthTokens.requirePrincipalIsolation()
            await isolateExpiredAccess()
            return
        }
        guard !expiryIsolationInProgress, !AppConfig.principalIsolationRequired else {
            phase = .loading
            return
        }
        phase = AppConfig.hasUsableToken ? .authed : .login
    }

    /// Re-probe server status (e.g. after editing the server URL on the login screen).
    func refreshStatus() async {
        status = try? await api.authStatus()
    }

    private func handleExpiry() async {
        guard phase == .authed || AppConfig.principalIsolationRequired else { return }
        AuthTokens.requirePrincipalIsolation()
        await isolateExpiredAccess()
    }

    private func handleAccessPolicyChanged() async {
        // Credential adoption evaluates and, when needed, isolates its policy before
        // releasing the loading gate. Joining that transition from this notification
        // would make the replacement wait on itself. Once authenticated, policy
        // refreshes still receive the immediate deadline check.
        guard phase == .authed || AppConfig.principalIsolationRequired else { return }
        await recheckAccessExpiry()
    }

    private func armAccessExpiry() {
        accessExpiryTask?.cancel()
        accessExpiryTask = nil
        guard let expiry = AppConfig.currentAccessExpiresAt else { return }
        let delay = expiry.timeIntervalSince(now())
        guard delay > 0 else {
            Task { await expireLocalAccess() }
            return
        }
        accessExpiryTask = Task { [weak self] in
            let nanos = UInt64(min(delay, Double(UInt64.max) / 1_000_000_000) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            // This is the deadline task itself. Clear the handle before isolation so
            // `isolateExpiredAccess` does not cancel the task that must perform the
            // asynchronous database purge.
            self?.accessExpiryTask = nil
            await self?.recheckAccessExpiry()
        }
    }

    /// Called on foreground/wall-clock changes as well as by the deadline task. If the
    /// clock moved backward, the timer is rearmed; if it jumped past the deadline, the
    /// principal is isolated immediately.
    func recheckAccessExpiry() async {
        // A prior security-critical purge or Keychain deletion may have failed for a
        // permanent role, which has no expiry timestamp to drive another attempt.
        // Foreground/significant-time callbacks must retry the durable latch first.
        if AppConfig.principalIsolationRequired {
            await isolateExpiredAccess()
            return
        }
        guard let expiry = AppConfig.currentAccessExpiresAt else {
            accessExpiryTask?.cancel()
            accessExpiryTask = nil
            return
        }
        if expiry <= now() {
            await expireLocalAccess()
        } else {
            armAccessExpiry()
        }
    }

    private func expireLocalAccess() async {
        guard currentAccessIsExpired else { return }
        AuthTokens.requirePrincipalIsolation()
        await isolateExpiredAccess()
    }

    /// Session owns a clock so launch, transition, timer, and lifecycle checks all
    /// evaluate the same instant. `currentAccessExpiresAt` already maps a missing or
    /// malformed temporary policy to `.distantPast` and permanent roles to `nil`.
    private var currentAccessIsExpired: Bool {
        AppConfig.currentAccessExpiresAt.map { $0 <= now() } ?? false
    }

    /// The privacy boundary for every membership/session expiry. The authed surface is
    /// replaced by the neutral loading gate before suspension; login (or the shared
    /// kiosk picker) is released only after PowerSync confirms its on-device replica
    /// was deleted. A purge error intentionally leaves the app at `.loading`, where no
    /// prior-principal data or replacement-principal controls are visible.
    private func isolateExpiredAccess() async {
        // A superseding credential transition is allowed to observe the neutral gate
        // without joining the purge that already owns it. The owner alone releases
        // the gate after the replica and credentials have both been cleared.
        guard !expiryIsolationInProgress else { return }
        expiryIsolationInProgress = true
        defer { expiryIsolationInProgress = false }
        accessExpiryTask?.cancel()
        accessExpiryTask = nil
        phase = .loading

        guard let isolateExpiredPrincipal,
              await isolateExpiredPrincipal() else {
            return
        }

        guard AuthTokens.clear() else { return }
        AppConfig.clearPrincipalIsolationRequirement()
        NotificationCenter.default.post(name: .waffledPrincipalIsolated, object: nil)
        phase = .login
        Task { [weak self] in
            guard let self else { return }
            self.status = try? await self.api.authStatus()
        }
    }
}
