import Foundation

enum TokenRefreshResponse: Equatable, Sendable {
    case refreshed(access: String, refresh: String)
    case rejected
    case unavailable
}

struct TokenRefreshCredentials: Sendable {
    let currentLease: @Sendable () async -> AuthTokens.RefreshLease?
    let saveIfCurrent: @Sendable (AuthTokens.RefreshLease, String, String) async -> Bool
    let isCurrent: @Sendable (AuthTokens.RefreshLease) async -> Bool

    static let live = TokenRefreshCredentials(
        currentLease: { AuthTokens.refreshLease() },
        saveIfCurrent: { lease, access, refresh in
            AuthTokens.saveIfCurrent(lease, access: access, refresh: refresh)
        },
        isCurrent: { AuthTokens.isCurrent($0) }
    )
}

/// Coordinates rotating-refresh so a burst of concurrent 401s triggers exactly one
/// `/api/auth/refresh` round-trip (single-flight). On success the new pair is stored
/// in the Keychain; on failure the session is cleared and `.waffledAuthExpired` fires so
/// the UI returns to login.
actor TokenRefresher {
    static let shared = TokenRefresher()

    private struct Flight {
        let id: UUID
        let lease: AuthTokens.RefreshLease
        let task: Task<Bool, Never>
    }

    private var inFlight: Flight?
    private let credentials: TokenRefreshCredentials
    private let request: @Sendable (AuthTokens.RefreshLease) async -> TokenRefreshResponse
    private let expire: @Sendable (AuthTokens.RefreshLease) async -> Void

    init(
        credentials: TokenRefreshCredentials = .live,
        request: @escaping @Sendable (AuthTokens.RefreshLease) async -> TokenRefreshResponse = {
            await TokenRefresher.request(lease: $0)
        },
        expire: @escaping @Sendable (AuthTokens.RefreshLease) async -> Void = {
            await TokenRefresher.expire($0)
        }
    ) {
        self.credentials = credentials
        self.request = request
        self.expire = expire
    }

    /// Refresh the access token, returning whether a usable one now exists. Callers
    /// racing the same credential await one attempt; replacement credentials start a
    /// separate flight and cannot be overwritten or expired by the older response.
    func refresh() async -> Bool {
        guard let lease = await credentials.currentLease() else { return false }
        return await refresh(ifCurrent: lease)
    }

    /// Refresh only the credentials captured by the request that received a 401.
    /// Passing the expected lease is what prevents an old A request from noticing B
    /// is now signed in and refreshing/retrying with B's credentials.
    func refresh(ifCurrent lease: AuthTokens.RefreshLease) async -> Bool {
        if let flight = inFlight, flight.lease == lease {
            return await flight.task.value
        }
        guard await credentials.isCurrent(lease) else { return false }
        let id = UUID()
        let task = Task { await performRefresh(lease: lease) }
        inFlight = Flight(id: id, lease: lease, task: task)
        let ok = await task.value
        if inFlight?.id == id { inFlight = nil }
        return ok
    }

    private func performRefresh(lease: AuthTokens.RefreshLease) async -> Bool {
        switch await request(lease) {
        case let .refreshed(access, refresh):
            return await credentials.saveIfCurrent(lease, access, refresh)
        case .rejected:
            guard await credentials.isCurrent(lease) else { return false }
            await expire(lease)
            return false
        case .unavailable:
            return false
        }
    }

    private static func request(lease: AuthTokens.RefreshLease) async -> TokenRefreshResponse {
        struct Body: Encodable { let refreshToken: String }
        struct Pair: Decodable { let accessToken: String; let refreshToken: String }

        guard let endpoint = AppConfig.apiURL(
            path: "/api/auth/refresh", baseURL: lease.apiBaseURL
        ) else { return .unavailable }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(Body(refreshToken: lease.refreshToken))

        guard let (data, resp) = try? await URLSession.shared.data(for: req) else {
            // Network failure (offline) — keep the tokens; PowerSync retries later.
            return .unavailable
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { return .rejected }
        guard (200..<300).contains(code), let pair = try? JSONDecoder().decode(Pair.self, from: data) else {
            return .unavailable
        }
        return .refreshed(access: pair.accessToken, refresh: pair.refreshToken)
    }

    private static func expire(_ lease: AuthTokens.RefreshLease) async {
        // Login/profile adoption also runs on the main actor. Recheck and clear in
        // one non-suspending block so a stale 401 cannot notify listeners after a
        // replacement session has won the race.
        await MainActor.run {
            guard AuthTokens.isCurrent(lease) else { return }
            AuthTokens.requirePrincipalIsolation()
            NotificationCenter.default.post(name: .waffledAuthExpired, object: lease)
        }
    }
}
