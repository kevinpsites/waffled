import Foundation
import Security

/// A tiny, synchronous wrapper over the iOS Keychain for small string secrets.
/// Reads/writes are blocking but fast, so callers can treat them like UserDefaults.
enum Keychain {
    /// One service namespace for all of Waffled's items (per the app's bundle).
    private static let service = "app.waffled.auth"

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }

    /// Upsert (`value != nil`) or delete (`value == nil`) the item for `key`.
    @discardableResult
    static func set(_ key: String, _ value: String?) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        guard let value, let data = value.data(using: .utf8) else {
            let status = SecItemDelete(base as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            // Available after first unlock so the connector can refresh in the
            // background; never migrates to a new device's backup.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(base as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            return SecItemAdd(base.merging(attrs) { _, new in new } as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }
}

/// Presence-aware representation of the server's `accessExpiresAt` property. An
/// explicit JSON null means indefinite access; an omitted or malformed value is not
/// interchangeable with null for temporary roles and therefore fails closed.
enum AccessExpiryField: Equatable, Hashable, Sendable {
    case missing
    case null
    case value(String)
    case malformed

    var storedValue: String? {
        if case let .value(value) = self { return value }
        return nil
    }

    var isPresent: Bool {
        switch self {
        case .null, .value: return true
        case .missing, .malformed: return false
        }
    }

    static func decode<Key: CodingKey>(
        _ key: Key,
        from container: KeyedDecodingContainer<Key>
    ) -> AccessExpiryField {
        guard container.contains(key) else { return .missing }
        if (try? container.decodeNil(forKey: key)) == true { return .null }
        guard let value = try? container.decode(String.self, forKey: key) else {
            return .malformed
        }
        return .value(value)
    }
}

/// The signed-in session's tokens — the single source of truth, persisted in the
/// Keychain so they survive relaunches. The web keeps these in localStorage; on
/// iOS the Keychain is the secure equivalent.
///
/// Access token (HS256 JWT, ~1h) rides every request as `Authorization: Bearer`.
/// Refresh token (opaque, ~60d, single-use/rotating) mints a fresh pair on 401.
enum AuthTokens {
    struct RefreshLease: Equatable, Sendable {
        let refreshToken: String
        let identityScope: String
        let generation: UInt64
        let apiBaseURL: String

        init(
            refreshToken: String,
            identityScope: String,
            generation: UInt64,
            apiBaseURL: String = AppConfig.apiBaseURL
        ) {
            self.refreshToken = refreshToken
            self.identityScope = identityScope
            self.generation = generation
            self.apiBaseURL = apiBaseURL
        }
    }

    /// One authorization boundary captured before an HTTP request suspends. The
    /// logical scope survives an ordinary rotating-token refresh, while a login,
    /// household/profile replacement, dev-token edit, or server change replaces it.
    struct RequestSnapshot: Equatable, Sendable {
        let accessToken: String
        let identityScope: String
        let generation: UInt64
        let apiBaseURL: String

        var refreshLease: RefreshLease? {
            guard let refreshToken = AuthTokens.refreshTokenForRequestSnapshot(self) else {
                return nil
            }
            return RefreshLease(
                refreshToken: refreshToken,
                identityScope: identityScope,
                generation: generation,
                apiBaseURL: apiBaseURL
            )
        }
    }

    struct Candidate: Equatable, Sendable {
        let accessToken: String
        let refreshToken: String
        let memberType: String?
        let accessExpiry: AccessExpiryField

        /// Temporary principals must carry an explicit null or a valid ISO instant.
        /// Missing/malformed values are rejected before the prior principal is torn
        /// down, so an incomplete response can never become an offline session.
        var isValid: Bool {
            guard !accessToken.isEmpty, !refreshToken.isEmpty else { return false }
            guard let memberType,
                  ["adult", "caregiver", "guest", "teen", "kid"].contains(memberType) else {
                return false
            }
            guard memberType == "caregiver" || memberType == "guest" else { return true }
            switch accessExpiry {
            case .null: return true
            case let .value(raw): return AppConfig.parseAccessInstant(raw) != nil
            case .missing, .malformed: return false
            }
        }

        /// Structural validation alone is insufficient at an auth boundary: a
        /// perfectly-formed temporary session can already be expired by the time the
        /// response arrives. Callers use their injected wall clock so tests and
        /// foreground clock corrections exercise the same fail-closed decision.
        func isUsable(at now: Date) -> Bool {
            guard isValid else { return false }
            guard memberType == "caregiver" || memberType == "guest" else { return true }
            switch accessExpiry {
            case .null: return true
            case let .value(raw):
                guard let expiry = AppConfig.parseAccessInstant(raw) else { return false }
                return expiry > now
            case .missing, .malformed: return false
            }
        }
    }

    private struct Envelope: Codable {
        let version: Int
        let apiBaseURL: String
        let scope: String
        let accessToken: String
        let refreshToken: String
        let memberType: String?
        let accessExpiresAtPresent: Bool
        let accessExpiresAt: String?

        var accessExpiry: AccessExpiryField {
            guard accessExpiresAtPresent else {
                return accessExpiresAt == nil ? .missing : .malformed
            }
            return accessExpiresAt.map(AccessExpiryField.value) ?? .null
        }

        var isStructurallyValid: Bool {
            version == 2 && AppConfig.normalizedApiBaseURL(apiBaseURL) == apiBaseURL &&
                !scope.isEmpty && !accessToken.isEmpty && !refreshToken.isEmpty &&
                (accessExpiresAtPresent || accessExpiresAt == nil) &&
                Candidate(accessToken: accessToken, refreshToken: refreshToken,
                          memberType: memberType, accessExpiry: accessExpiry).isValid
        }
    }

    private static let envelopeKey = "waffled.sessionEnvelope.v1"
    private static let legacyAccessKey = "waffled.accessToken"
    private static let legacyRefreshKey = "waffled.refreshToken"
    private static let legacySessionScopeKey = "waffled.authSessionScope"

    // In-memory cache, lazily loaded from the Keychain once. `authorize()` reads the
    // access token on EVERY request; without this cache that's a securityd XPC call
    // per request, which under the sync/poll retry loops storms securityd into a
    // thread/memory blow-up (jetsam low-swap kill on sign-out). The Keychain stays
    // the durable store; this is just the hot-path read cache.
    private static let lock = NSLock()
    private static var cache: Envelope??
    private static var generation: UInt64 = 0

    private static func loaded() -> Envelope? {
        if let cache {
            guard let envelope = cache else { return nil }
            guard envelope.apiBaseURL == AppConfig.apiBaseURL else {
                failClosedStorageLocked()
                self.cache = .some(nil)
                return nil
            }
            return envelope
        }
        let decoder = JSONDecoder()
        if let raw = Keychain.get(envelopeKey) {
            if let data = raw.data(using: .utf8),
               let envelope = try? decoder.decode(Envelope.self, from: data),
               envelope.isStructurallyValid,
               envelope.apiBaseURL == AppConfig.apiBaseURL {
                cache = .some(envelope)
                return envelope
            }
            // An envelope key is authoritative. Never fall back to potentially stale
            // split items when it exists but is corrupt.
            failClosedStorageLocked()
            cache = .some(nil)
            return nil
        }

        // The former access/refresh pair had no durable commit marker. Even if both
        // items exist, an interrupted replacement could splice B's access with A's
        // refresh/policy. Delete it and require replica isolation + a fresh login.
        let legacyAccess = Keychain.get(legacyAccessKey)
        let legacyRefresh = Keychain.get(legacyRefreshKey)
        if legacyAccess != nil || legacyRefresh != nil {
            failClosedStorageLocked()
        }
        cache = .some(nil)
        return nil
    }

    private static func persistLocked(_ envelope: Envelope) -> Bool {
        guard let data = try? JSONEncoder().encode(envelope),
              let raw = String(data: data, encoding: .utf8) else { return false }
        return envelopeWriter(raw)
    }

    private static func deleteLegacyLocked() {
        Keychain.set(legacyAccessKey, nil)
        Keychain.set(legacyRefreshKey, nil)
        UserDefaults.standard.removeObject(forKey: legacySessionScopeKey)
    }

    private static var envelopeWriter: (String?) -> Bool = { Keychain.set(envelopeKey, $0) }

    private static func failClosedStorageLocked() {
        AppConfig.requirePrincipalIsolation()
        _ = envelopeWriter(nil)
        deleteLegacyLocked()
    }

    /// Serialized-test seam for simulating Keychain commit failure without altering
    /// the production Keychain wrapper.
    static func setEnvelopeWriterForTesting(_ writer: ((String?) -> Bool)?) {
        lock.lock()
        envelopeWriter = writer ?? { Keychain.set(envelopeKey, $0) }
        cache = nil
        lock.unlock()
    }

    static func seedRawStorageForTesting(
        envelope: String?, legacyAccess: String? = nil, legacyRefresh: String? = nil
    ) {
        lock.lock()
        _ = Keychain.set(envelopeKey, envelope)
        _ = Keychain.set(legacyAccessKey, legacyAccess)
        _ = Keychain.set(legacyRefreshKey, legacyRefresh)
        cache = nil
        lock.unlock()
    }

    static var accessToken: String? { lock.lock(); defer { lock.unlock() }; return loaded()?.accessToken }
    static var refreshToken: String? { lock.lock(); defer { lock.unlock() }; return loaded()?.refreshToken }
    static var memberType: String? { lock.lock(); defer { lock.unlock() }; return loaded()?.memberType }
    static var accessExpiry: AccessExpiryField? {
        lock.lock(); defer { lock.unlock() }
        return loaded()?.accessExpiry
    }

    /// Stable for one signed-in principal/household across rotating refreshes, but
    /// replaced for every explicit login, household switch, or kiosk profile claim.
    /// It is non-secret and persisted so a verified role can be trusted offline after
    /// relaunch without letting a delayed response cross a replacement-session boundary.
    private static func identityScopeLocked() -> String? {
        guard let envelope = loaded() else { return nil }
        return "session:\(envelope.scope)"
    }

    static var identityScope: String? {
        lock.lock(); defer { lock.unlock() }
        return identityScopeLocked()
    }

    /// True once a real login has stored tokens (distinct from the dev-token path).
    static var isSignedIn: Bool { accessToken != nil }

    /// Snapshot used to bind one rotating refresh request to the credentials and
    /// principal generation that launched it.
    static func refreshLease() -> RefreshLease? {
        lock.lock(); defer { lock.unlock() }
        guard let envelope = loaded(),
              let identityScope = identityScopeLocked() else { return nil }
        return RefreshLease(
            refreshToken: envelope.refreshToken,
            identityScope: identityScope,
            generation: generation,
            apiBaseURL: envelope.apiBaseURL
        )
    }

    static func isCurrent(_ lease: RefreshLease) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == lease.generation &&
            loaded()?.refreshToken == lease.refreshToken &&
            identityScopeLocked() == lease.identityScope &&
            loaded()?.apiBaseURL == lease.apiBaseURL &&
            AppConfig.apiBaseURL == lease.apiBaseURL
    }

    /// Capture the exact real-session authorization that a request is about to use.
    /// The caller compares `accessToken` with the already-built Authorization header,
    /// closing the small authorize→send race as well as later response races.
    static func requestSnapshot() -> RequestSnapshot? {
        lock.lock(); defer { lock.unlock() }
        guard let envelope = loaded(), envelope.apiBaseURL == AppConfig.apiBaseURL,
              let identityScope = identityScopeLocked() else { return nil }
        return RequestSnapshot(
            accessToken: envelope.accessToken,
            identityScope: identityScope,
            generation: generation,
            apiBaseURL: envelope.apiBaseURL
        )
    }

    /// A response may cross token rotation, but never a logical-principal or server
    /// boundary. Return the current token in the same critical section so a retry can
    /// only pick up credentials belonging to the captured principal.
    static func accessTokenIfSamePrincipal(as snapshot: RequestSnapshot) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let envelope = loaded(),
              envelope.apiBaseURL == snapshot.apiBaseURL,
              AppConfig.apiBaseURL == snapshot.apiBaseURL,
              identityScopeLocked() == snapshot.identityScope else { return nil }
        return envelope.accessToken
    }

    static func isSamePrincipal(as snapshot: RequestSnapshot) -> Bool {
        accessTokenIfSamePrincipal(as: snapshot) != nil
    }

    private static func refreshTokenForRequestSnapshot(_ snapshot: RequestSnapshot) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard generation == snapshot.generation,
              let envelope = loaded(),
              envelope.accessToken == snapshot.accessToken,
              envelope.apiBaseURL == snapshot.apiBaseURL,
              AppConfig.apiBaseURL == snapshot.apiBaseURL,
              identityScopeLocked() == snapshot.identityScope else { return nil }
        return envelope.refreshToken
    }

    /// Store a fresh access+refresh pair. Explicit login/household/profile replacement
    /// rotates the identity scope; the token refresher opts into preserving it.
    @discardableResult
    static func save(
        access: String,
        refresh: String,
        memberType: String? = nil,
        accessExpiry: AccessExpiryField = .missing,
        preservingIdentityScope: Bool = false
    ) -> Bool {
        lock.lock()
        guard !access.isEmpty, !refresh.isEmpty else {
            lock.unlock()
            return false
        }
        generation &+= 1
        let existing = loaded()
        if preservingIdentityScope, existing == nil {
            lock.unlock()
            return false
        }
        let effectiveMemberType = preservingIdentityScope ? existing?.memberType : memberType
        let effectiveExpiry = preservingIdentityScope ? existing?.accessExpiry : accessExpiry
        let candidate = Candidate(
            accessToken: access,
            refreshToken: refresh,
            memberType: effectiveMemberType,
            accessExpiry: effectiveExpiry ?? .missing
        )
        guard candidate.isValid else {
            lock.unlock()
            return false
        }
        let envelope = Envelope(
            version: 2,
            apiBaseURL: AppConfig.apiBaseURL,
            scope: preservingIdentityScope ? (existing?.scope ?? UUID().uuidString) : UUID().uuidString,
            accessToken: access,
            refreshToken: refresh,
            memberType: preservingIdentityScope ? existing?.memberType : memberType,
            accessExpiresAtPresent: preservingIdentityScope ? (existing?.accessExpiresAtPresent ?? false) : accessExpiry.isPresent,
            accessExpiresAt: preservingIdentityScope ? existing?.accessExpiresAt : accessExpiry.storedValue
        )
        guard persistLocked(envelope) else {
            failClosedStorageLocked()
            cache = .some(nil)
            lock.unlock()
            return false
        }
        cache = .some(envelope)
        deleteLegacyLocked()
        lock.unlock()
        NotificationCenter.default.post(name: .waffledAccessPolicyChanged, object: nil)
        return true
    }

    /// Commit a refresh response only while its exact lease is still current. A
    /// login, household/profile replacement, clear, or newer refresh invalidates it.
    @discardableResult
    static func saveIfCurrent(
        _ lease: RefreshLease,
        access: String,
        refresh: String
    ) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !access.isEmpty, !refresh.isEmpty,
              generation == lease.generation,
              let current = loaded(),
              current.refreshToken == lease.refreshToken,
              identityScopeLocked() == lease.identityScope,
              current.apiBaseURL == lease.apiBaseURL,
              AppConfig.apiBaseURL == lease.apiBaseURL else { return false }
        generation &+= 1
        let envelope = Envelope(
            version: current.version,
            apiBaseURL: current.apiBaseURL,
            scope: current.scope,
            accessToken: access,
            refreshToken: refresh,
            memberType: current.memberType,
            accessExpiresAtPresent: current.accessExpiresAtPresent,
            accessExpiresAt: current.accessExpiresAt
        )
        guard persistLocked(envelope) else {
            failClosedStorageLocked()
            cache = .some(nil)
            NotificationCenter.default.post(name: .waffledAuthExpired, object: lease)
            return false
        }
        cache = .some(envelope)
        return true
    }

    /// Replace just the access token (kept for parity; refresh always rotates too).
    static func saveAccess(_ access: String) {
        lock.lock()
        guard !access.isEmpty, let current = loaded() else { lock.unlock(); return }
        generation &+= 1
        let envelope = Envelope(
            version: current.version,
            apiBaseURL: current.apiBaseURL,
            scope: current.scope,
            accessToken: access,
            refreshToken: current.refreshToken,
            memberType: current.memberType,
            accessExpiresAtPresent: current.accessExpiresAtPresent,
            accessExpiresAt: current.accessExpiresAt
        )
        guard persistLocked(envelope) else {
            failClosedStorageLocked()
            cache = .some(nil)
            lock.unlock()
            NotificationCenter.default.post(name: .waffledAuthExpired, object: nil)
            return
        }
        cache = .some(envelope)
        lock.unlock()
    }

    /// Update policy returned by `/api/me` without splitting it from the token pair.
    static func updateAccessPolicy(memberType: String?, accessExpiry: AccessExpiryField) {
        lock.lock()
        guard let current = loaded() else { lock.unlock(); return }
        let candidate = Candidate(
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            memberType: memberType,
            accessExpiry: accessExpiry
        )
        guard candidate.isValid else {
            failClosedStorageLocked()
            cache = .some(nil)
            lock.unlock()
            NotificationCenter.default.post(name: .waffledAuthExpired, object: nil)
            return
        }
        let envelope = Envelope(
            version: current.version,
            apiBaseURL: current.apiBaseURL,
            scope: current.scope,
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            memberType: memberType,
            accessExpiresAtPresent: accessExpiry.isPresent,
            accessExpiresAt: accessExpiry.storedValue
        )
        guard persistLocked(envelope) else {
            failClosedStorageLocked()
            cache = .some(nil)
            lock.unlock()
            NotificationCenter.default.post(name: .waffledAuthExpired, object: nil)
            return
        }
        cache = .some(envelope)
        lock.unlock()
        NotificationCenter.default.post(name: .waffledAccessPolicyChanged, object: nil)
    }

    @discardableResult
    static func clear() -> Bool {
        lock.lock()
        generation &+= 1
        let removed = envelopeWriter(nil)
        cache = .some(nil)
        deleteLegacyLocked()
        lock.unlock()
        // Every explicit logout, expired refresh, and kiosk profile teardown uses
        // this boundary. Do not let the durable offline role cross principals.
        AppConfig.setCurrentMemberType(nil)
        if !removed { AppConfig.requirePrincipalIsolation() }
        return removed
    }

    /// Expiry/revocation is different from an ordinary user-requested sign-out: the
    /// local PowerSync replica must be removed before another principal can sign in.
    /// Persist the requirement before deleting credentials so a crash cannot forget it.
    static func requirePrincipalIsolation() {
        AppConfig.requirePrincipalIsolation()
    }
}

extension Notification.Name {
    /// Posted when the refresh token is rejected (expired/revoked) and the session
    /// can't be recovered — listeners send the user back to the login screen.
    static let waffledAuthExpired = Notification.Name("waffled.authExpired")
    /// Posted only after an expired principal's PowerSync replica has been purged.
    /// Signed-out gates that can expose a different principal wait for this boundary.
    static let waffledPrincipalIsolated = Notification.Name("waffled.principalIsolated")
    /// Posted when the identity-bound local membership policy changes so the auth
    /// gate can arm or cancel its offline expiry deadline.
    static let waffledAccessPolicyChanged = Notification.Name("waffled.accessPolicyChanged")
}
