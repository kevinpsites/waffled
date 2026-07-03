import Foundation

/// Coordinates rotating-refresh so a burst of concurrent 401s triggers exactly one
/// `/api/auth/refresh` round-trip (single-flight). On success the new pair is stored
/// in the Keychain; on failure the session is cleared and `.waffledAuthExpired` fires so
/// the UI returns to login.
actor TokenRefresher {
    static let shared = TokenRefresher()

    private var inFlight: Task<Bool, Never>?

    /// Refresh the access token, returning whether a usable one now exists. Callers
    /// racing the same refresh all await the one in-flight attempt.
    func refresh() async -> Bool {
        if let task = inFlight { return await task.value }
        let task = Task { await performRefresh() }
        inFlight = task
        let ok = await task.value
        inFlight = nil
        return ok
    }

    private func performRefresh() async -> Bool {
        guard let refreshToken = AuthTokens.refreshToken else { return false }
        struct Body: Encodable { let refreshToken: String }
        struct Pair: Decodable { let accessToken: String; let refreshToken: String }

        var req = URLRequest(url: URL(string: AppConfig.apiBaseURL + "/api/auth/refresh")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(Body(refreshToken: refreshToken))

        guard let (data, resp) = try? await URLSession.shared.data(for: req) else {
            // Network failure (offline) — keep the tokens; PowerSync retries later.
            return false
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 {
            // The refresh token itself is dead — sign out for real.
            AuthTokens.clear()
            await MainActor.run { NotificationCenter.default.post(name: .waffledAuthExpired, object: nil) }
            return false
        }
        guard (200..<300).contains(code), let pair = try? JSONDecoder().decode(Pair.self, from: data) else {
            return false
        }
        AuthTokens.save(access: pair.accessToken, refresh: pair.refreshToken)
        return true
    }
}
