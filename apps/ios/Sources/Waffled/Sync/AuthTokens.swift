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
    static func set(_ key: String, _ value: String?) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        guard let value, let data = value.data(using: .utf8) else {
            SecItemDelete(base as CFDictionary)
            return
        }
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            // Available after first unlock so the connector can refresh in the
            // background; never migrates to a new device's backup.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(base as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(base.merging(attrs) { _, new in new } as CFDictionary, nil)
        }
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
    }

    private static let accessKey = "waffled.accessToken"
    private static let refreshKey = "waffled.refreshToken"
    private static let sessionScopeKey = "waffled.authSessionScope"

    // In-memory cache, lazily loaded from the Keychain once. `authorize()` reads the
    // access token on EVERY request; without this cache that's a securityd XPC call
    // per request, which under the sync/poll retry loops storms securityd into a
    // thread/memory blow-up (jetsam low-swap kill on sign-out). The Keychain stays
    // the durable store; this is just the hot-path read cache.
    private static let lock = NSLock()
    private static var cache: (access: String?, refresh: String?)?
    private static var generation: UInt64 = 0

    private static func loaded() -> (access: String?, refresh: String?) {
        if let c = cache { return c }
        let c = (Keychain.get(accessKey), Keychain.get(refreshKey))
        cache = c
        return c
    }

    static var accessToken: String? { lock.lock(); defer { lock.unlock() }; return loaded().access }
    static var refreshToken: String? { lock.lock(); defer { lock.unlock() }; return loaded().refresh }

    /// Stable for one signed-in principal/household across rotating refreshes, but
    /// replaced for every explicit login, household switch, or kiosk profile claim.
    /// It is non-secret and persisted so a verified role can be trusted offline after
    /// relaunch without letting a delayed response cross a replacement-session boundary.
    private static func identityScopeLocked() -> String? {
        guard loaded().access != nil else { return nil }
        let defaults = UserDefaults.standard
        if let scope = defaults.string(forKey: sessionScopeKey), !scope.isEmpty {
            return "session:\(scope)"
        }
        let scope = UUID().uuidString
        defaults.set(scope, forKey: sessionScopeKey)
        return "session:\(scope)"
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
        guard let refreshToken = loaded().refresh,
              let identityScope = identityScopeLocked() else { return nil }
        return RefreshLease(
            refreshToken: refreshToken,
            identityScope: identityScope,
            generation: generation
        )
    }

    static func isCurrent(_ lease: RefreshLease) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == lease.generation &&
            loaded().refresh == lease.refreshToken &&
            identityScopeLocked() == lease.identityScope
    }

    /// Store a fresh access+refresh pair. Explicit login/household/profile replacement
    /// rotates the identity scope; the token refresher opts into preserving it.
    static func save(access: String, refresh: String, preservingIdentityScope: Bool = false) {
        lock.lock()
        generation &+= 1
        cache = (access, refresh)
        let defaults = UserDefaults.standard
        if !preservingIdentityScope || defaults.string(forKey: sessionScopeKey) == nil {
            defaults.set(UUID().uuidString, forKey: sessionScopeKey)
        }
        Keychain.set(accessKey, access)
        Keychain.set(refreshKey, refresh)
        lock.unlock()
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
        guard generation == lease.generation,
              loaded().refresh == lease.refreshToken,
              identityScopeLocked() == lease.identityScope else { return false }
        generation &+= 1
        cache = (access, refresh)
        Keychain.set(accessKey, access)
        Keychain.set(refreshKey, refresh)
        return true
    }

    /// Replace just the access token (kept for parity; refresh always rotates too).
    static func saveAccess(_ access: String) {
        lock.lock()
        generation &+= 1
        cache = (access, loaded().refresh)
        Keychain.set(accessKey, access)
        lock.unlock()
    }

    static func clear() {
        lock.lock()
        generation &+= 1
        cache = (nil, nil)
        UserDefaults.standard.removeObject(forKey: sessionScopeKey)
        Keychain.set(accessKey, nil)
        Keychain.set(refreshKey, nil)
        lock.unlock()
        // Every explicit logout, expired refresh, and kiosk profile teardown uses
        // this boundary. Do not let the durable offline role cross principals.
        AppConfig.setCurrentMemberType(nil)
    }
}

extension Notification.Name {
    /// Posted when the refresh token is rejected (expired/revoked) and the session
    /// can't be recovered — listeners send the user back to the login screen.
    static let waffledAuthExpired = Notification.Name("waffled.authExpired")
}
