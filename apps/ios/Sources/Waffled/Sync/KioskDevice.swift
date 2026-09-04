import Foundation

/// The shared-kiosk **device identity** for an iPad family display.
///
/// Separate from the per-person session (`AuthTokens`): pairing this iPad as a
/// household kiosk stores a long-lived `deviceSecret` in the Keychain. That secret
/// is exchanged (by `KioskDeviceAuth`) for short-lived device access tokens that can
/// list profiles and claim one — the device-scoped half of the web kiosk model
/// (`apps/web/src/lib/api/kiosk.ts` `deviceFetch`). Once a profile is claimed the
/// app runs on that person's normal access/refresh pair, exactly like a login.
///
/// ⚠️ KEEP IN SYNC with the web kiosk client (`apps/web/src/lib/api/client.ts`
/// `getKioskDevice`/`setKioskDevice`, `apps/web/src/lib/api/kiosk.ts`) and the
/// server kiosk routes — the token shapes and endpoints must match.
enum KioskDeviceStore {
    private static let secretKey = "waffled.kiosk.deviceSecret"
    // Removed after the device label moved into the same atomic envelope as its
    // secret/server binding. Kept only so upgrades erase the stale split value.
    private static let labelKey = "waffled.kiosk.deviceLabel"
    private static let lock = NSLock()
    private static var generation: UInt64 = 0
    private static var secretWriter: (String?) -> Bool = { Keychain.set(secretKey, $0) }
    private static var cache: Envelope??

    private struct Envelope: Codable {
        let version: Int
        let secret: String
        let label: String?
        let apiBaseURL: String

        var isValid: Bool {
            version == 1 && !secret.isEmpty &&
                AppConfig.normalizedApiBaseURL(apiBaseURL) == apiBaseURL
        }
    }

    struct Snapshot: Equatable, Sendable {
        let secret: String?
        let generation: UInt64
        let apiBaseURL: String
    }

    enum ConditionalClearResult: Equatable {
        case cleared
        case superseded
        case failed
    }

    /// The long-lived device secret (nil until this iPad is paired as a kiosk).
    static var secret: String? { snapshot().secret }
    /// Whether this iPad has been set up as a shared family kiosk.
    static var isPaired: Bool { secret != nil }
    /// The device's display name, shown above the profile picker.
    static var label: String? {
        lock.lock(); defer { lock.unlock() }
        return loadedLocked()?.label
    }

    private static func loadedLocked() -> Envelope? {
        if let cache {
            guard let envelope = cache else { return nil }
            guard envelope.apiBaseURL == AppConfig.apiBaseURL else {
                _ = secretWriter(nil)
                UserDefaults.standard.removeObject(forKey: labelKey)
                self.cache = .some(nil)
                generation &+= 1
                return nil
            }
            return envelope
        }
        guard let raw = Keychain.get(secretKey),
              let data = raw.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.isValid,
              envelope.apiBaseURL == AppConfig.apiBaseURL else {
            // A legacy bare secret, corrupt envelope, or origin mismatch is never
            // reusable: it must not be posted to whichever server happens to be
            // configured now.
            _ = secretWriter(nil)
            UserDefaults.standard.removeObject(forKey: labelKey)
            cache = .some(nil)
            return nil
        }
        UserDefaults.standard.removeObject(forKey: labelKey)
        cache = .some(envelope)
        return envelope
    }

    /// Persist a freshly paired device secret (from pair-by-code or admin promote).
    @discardableResult
    static func savePaired(secret: String, label: String?) -> Bool {
        lock.lock()
        guard !secret.isEmpty else { lock.unlock(); return false }
        let envelope = Envelope(
            version: 1,
            secret: secret,
            label: label.flatMap { $0.isEmpty ? nil : $0 },
            apiBaseURL: AppConfig.apiBaseURL
        )
        guard let data = try? JSONEncoder().encode(envelope),
              let raw = String(data: data, encoding: .utf8) else {
            lock.unlock()
            return false
        }
        let saved = secretWriter(raw)
        generation &+= 1
        if saved { cache = .some(envelope) }
        lock.unlock()
        guard saved else { return false }
        UserDefaults.standard.removeObject(forKey: labelKey)
        return true
    }

    /// Forget the device identity entirely (un-kiosk this iPad). Does not touch the
    /// per-person session — callers clear `AuthTokens` separately when needed.
    @discardableResult
    static func clear() -> Bool {
        lock.lock()
        let cleared = secretWriter(nil)
        generation &+= 1
        if cleared { cache = .some(nil) }
        lock.unlock()
        UserDefaults.standard.removeObject(forKey: labelKey)
        return cleared
    }

    /// Compare and delete in the same critical section. A separate `isCurrent` check
    /// followed by `clear` leaves a check/use window where a new pairing can be erased
    /// by an old device's delayed 401 or unpair flow.
    static func clear(ifCurrent expected: Snapshot) -> ConditionalClearResult {
        lock.lock()
        let envelope = loadedLocked()
        let current = Snapshot(
            secret: envelope?.secret,
            generation: generation,
            apiBaseURL: envelope?.apiBaseURL ?? AppConfig.apiBaseURL
        )
        guard current == expected else {
            lock.unlock()
            return .superseded
        }
        let cleared = secretWriter(nil)
        generation &+= 1
        if cleared { cache = .some(nil) }
        lock.unlock()
        UserDefaults.standard.removeObject(forKey: labelKey)
        return cleared ? .cleared : .failed
    }

    static func snapshot() -> Snapshot {
        lock.lock()
        let envelope = loadedLocked()
        let snapshot = Snapshot(
            secret: envelope?.secret,
            generation: generation,
            apiBaseURL: envelope?.apiBaseURL ?? AppConfig.apiBaseURL
        )
        lock.unlock()
        return snapshot
    }

    static func isCurrent(_ candidate: Snapshot) -> Bool {
        snapshot() == candidate
    }

    static func advanceGeneration() {
        lock.lock()
        generation &+= 1
        lock.unlock()
    }

    static func setSecretWriterForTesting(_ writer: ((String?) -> Bool)?) {
        lock.lock()
        secretWriter = writer ?? { Keychain.set(secretKey, $0) }
        generation &+= 1
        cache = nil
        lock.unlock()
    }
}

/// Mints and caches the short-lived **device** access token from the stored
/// `deviceSecret`, mirroring the web's `deviceFetch` refresh. Plain HS-token exchange
/// against `/api/kiosk/device/token` (no bearer needed — the secret IS the credential).
/// An actor so concurrent profile polls share one in-flight refresh.
actor KioskDeviceAuth {
    static let shared = KioskDeviceAuth()

    struct MintedToken: Sendable, Equatable {
        let accessToken: String
        let expiresAt: Date
    }

    private var cached: (token: MintedToken, snapshot: KioskDeviceStore.Snapshot)?
    private let snapshot: @Sendable () -> KioskDeviceStore.Snapshot
    private let mint: @Sendable (KioskDeviceStore.Snapshot) async throws -> MintedToken
    private let now: @Sendable () -> Date

    struct NotPaired: Error {}
    struct Superseded: Error {}
    private struct TokenResp: Decodable { let accessToken: String; let expiresIn: Int? }

    init(
        snapshot: @escaping @Sendable () -> KioskDeviceStore.Snapshot = { KioskDeviceStore.snapshot() },
        mint: @escaping @Sendable (KioskDeviceStore.Snapshot) async throws -> MintedToken = {
            try await KioskDeviceAuth.request(snapshot: $0)
        },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.snapshot = snapshot
        self.mint = mint
        self.now = now
    }

    /// A device access token, minting one if we don't already hold a live one.
    func token() async throws -> String {
        let current = snapshot()
        return try await token(for: current)
    }

    /// Return a token only for the caller's captured kiosk generation/server.
    func token(for expected: KioskDeviceStore.Snapshot) async throws -> String {
        guard expected.secret != nil else { throw NotPaired() }
        guard snapshot() == expected else { throw Superseded() }
        // Keep a small skew window so a token cannot expire between selection and send.
        if let cached, cached.snapshot == expected,
           cached.token.expiresAt.timeIntervalSince(now()) > 15 {
            return cached.token.accessToken
        }
        return try await refresh(startingFrom: expected)
    }

    /// Force-mint a fresh device access token (called after a 401 on a device call).
    @discardableResult
    func refresh() async throws -> String {
        try await refresh(startingFrom: snapshot())
    }

    /// Force-mint for one captured kiosk generation. Profile claims use this before
    /// their single PIN submission so an expired cached device token cannot masquerade
    /// as a wrong PIN; the claim response itself is never resubmitted on 401.
    func refresh(for expected: KioskDeviceStore.Snapshot) async throws -> String {
        guard snapshot() == expected else { throw Superseded() }
        return try await refresh(startingFrom: expected)
    }

    private func refresh(startingFrom start: KioskDeviceStore.Snapshot) async throws -> String {
        guard start.secret != nil else { throw NotPaired() }
        let token = try await mint(start)
        guard snapshot() == start else { throw Superseded() }
        cached = (token, start)
        return token.accessToken
    }

    private static func request(snapshot: KioskDeviceStore.Snapshot) async throws -> MintedToken {
        guard let secret = snapshot.secret else { throw NotPaired() }
        guard let endpoint = AppConfig.apiURL(
            path: "/api/kiosk/device/token", baseURL: snapshot.apiBaseURL
        ) else {
            throw WaffledAPI.APIError.invalidServerURL
        }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["deviceSecret": secret])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            // Unknown/revoked device → the secret is dead; drop it so the UI can
            // surface "this kiosk was unpaired" instead of looping on 401s.
            throw WaffledAPI.APIError.http((resp as? HTTPURLResponse)?.statusCode ?? -1,
                                        String(data: data, encoding: .utf8) ?? "")
        }
        let token = try WaffledAPI.decoder.decode(TokenResp.self, from: data)
        // The server currently returns expiresIn. Missing/invalid values are not safe
        // to cache; make the token immediately stale so the next operation re-mints.
        let lifetime = max(0, token.expiresIn ?? 0)
        return MintedToken(
            accessToken: token.accessToken,
            expiresAt: Date().addingTimeInterval(TimeInterval(lifetime))
        )
    }

    /// Drop the cached token (after re-pairing or unpairing).
    nonisolated func invalidate() { KioskDeviceStore.advanceGeneration() }
    private func clearCache() { cached = nil }
}
