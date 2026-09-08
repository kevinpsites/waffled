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
        let generation: UInt64
    }

    private static let accessKey = "waffled.accessToken"
    private static let refreshKey = "waffled.refreshToken"

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

    /// True once a real login has stored tokens (distinct from the dev-token path).
    static var isSignedIn: Bool { accessToken != nil }

    /// Snapshot used to bind an in-flight rotating refresh to the exact credential
    /// generation that launched it. A later login/claim/save invalidates the lease.
    static func refreshLease() -> RefreshLease? {
        lock.lock(); defer { lock.unlock() }
        guard let refresh = loaded().refresh else { return nil }
        return RefreshLease(refreshToken: refresh, generation: generation)
    }

    static func isCurrent(_ lease: RefreshLease) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == lease.generation && loaded().refresh == lease.refreshToken
    }

    /// Store a fresh access+refresh pair (login, setup, or a rotated refresh).
    static func save(access: String, refresh: String) {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        cache = (access, refresh)
        Keychain.set(accessKey, access)
        Keychain.set(refreshKey, refresh)
    }

    /// Commit a refresh response only if no login, claim, clear, or newer refresh has
    /// replaced the credentials since its request began.
    @discardableResult
    static func saveIfCurrent(
        _ lease: RefreshLease,
        access: String,
        refresh: String
    ) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard generation == lease.generation, loaded().refresh == lease.refreshToken else {
            return false
        }
        generation &+= 1
        cache = (access, refresh)
        Keychain.set(accessKey, access)
        Keychain.set(refreshKey, refresh)
        return true
    }

    /// Replace just the access token (kept for parity; refresh always rotates too).
    static func saveAccess(_ access: String) {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        cache = (access, loaded().refresh)
        Keychain.set(accessKey, access)
    }

    static func clear() {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        cache = (nil, nil)
        Keychain.set(accessKey, nil)
        Keychain.set(refreshKey, nil)
    }
}

extension Notification.Name {
    /// Posted when the refresh token is rejected (expired/revoked) and the session
    /// can't be recovered — listeners send the user back to the login screen.
    static let waffledAuthExpired = Notification.Name("waffled.authExpired")
}
