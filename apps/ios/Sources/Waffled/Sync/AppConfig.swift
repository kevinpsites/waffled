import CryptoKit
import Foundation

/// Where the app points and how it authenticates — device-only settings.
///
/// Precedence: launch environment (so demos can be scripted with
/// `SIMCTL_CHILD_WAFFLED_DEV_TOKEN=…`) → UserDefaults (Settings sheet) → dev default.
enum AppConfig {
    private static let urlKey = "waffled.apiBaseURL"
    private static let tokenKey = "waffled.devToken"
    private static let memberTypeKey = "waffled.currentMemberType"
    private static let memberTypeServerKey = "waffled.currentMemberTypeServer"
    private static let memberTypeAuthScopeKey = "waffled.currentMemberTypeAuthScope"
    private static let accessExpiryKey = "waffled.currentAccessExpiresAt"
    private static let accessExpiryPresenceKey = "waffled.currentAccessExpiryPresence"
    private static let accessExpiryServerKey = "waffled.currentAccessExpiryServer"
    private static let accessExpiryAuthScopeKey = "waffled.currentAccessExpiryAuthScope"
    private static let principalIsolationRequiredKey = "waffled.principalIsolationRequired"
    private static let builtInMemberTypes: Set<String> = ["adult", "caregiver", "guest", "teen", "kid"]
    private static let memberTypeLock = NSLock()

    /// The built-in fallback server address (the compose stack's Caddy origin). Exposed so the
    /// About screen can show/reset to it.
    static let defaultBaseURL = "http://localhost:8080"

    static var storedApiBaseURL: String? { UserDefaults.standard.string(forKey: urlKey) }
    static var storedDevToken: String { UserDefaults.standard.string(forKey: tokenKey) ?? "" }

    /// Our API base MUST be the Caddy origin, not the api's own port: Caddy proxies `/api/*`
    /// AND serves uploaded media at `/media/*`, which the api alone (`:3000`) does not — so
    /// photo/recipe/proof images would 404. On a real device set this to the Mac's LAN IP on
    /// that same Caddy port. Override via the Settings sheet or `WAFFLED_API_URL`.
    static var apiBaseURL: String {
        let candidate = env("WAFFLED_API_URL")
            ?? UserDefaults.standard.string(forKey: urlKey)
            ?? defaultBaseURL
        return normalizedApiBaseURL(candidate) ?? defaultBaseURL
    }

    /// Local HS256 session token (mint via `just token`), validated by `requireTenant` and
    /// exchanged at `/api/powersync/token`. A *fallback* path, for headless demos.
    static var devToken: String {
        env("WAFFLED_DEV_TOKEN")
            ?? UserDefaults.standard.string(forKey: tokenKey)
            ?? ""
    }

    /// Read at call time so login/refresh/logout take effect on the next request.
    static var bearerToken: String {
        guard !principalIsolationRequired, !currentAccessIsExpired else { return "" }
        return AuthTokens.accessToken ?? devToken
    }

    /// The active household role, loaded from `/api/household`. Its last verified
    /// built-in value survives a cold offline launch, but only for the same server.
    /// Explicit session/profile/token changes clear it at their mutation boundary.
    /// WaffledAPI reads this shared value so every feature client applies the guest
    /// read-only rule, including models without the app's SyncManager environment.
    static var currentMemberType: String? {
        if AuthTokens.isSignedIn { return AuthTokens.memberType }
        memberTypeLock.lock(); defer { memberTypeLock.unlock() }
        let defaults = UserDefaults.standard
        guard let memberType = defaults.string(forKey: memberTypeKey),
              builtInMemberTypes.contains(memberType),
              defaults.string(forKey: memberTypeServerKey) == apiBaseURL,
              let authScope = currentIdentityScope,
              defaults.string(forKey: memberTypeAuthScopeKey) == authScope else {
            defaults.removeObject(forKey: memberTypeKey)
            defaults.removeObject(forKey: memberTypeServerKey)
            defaults.removeObject(forKey: memberTypeAuthScopeKey)
            clearAccessExpiry(defaults)
            return nil
        }
        return memberType
    }
    static func setCurrentMemberType(_ value: String?) {
        setCurrentAccess(memberType: value, accessExpiry: .missing)
    }

    static func setCurrentAccess(memberType value: String?, accessExpiry: AccessExpiryField) {
        if AuthTokens.isSignedIn {
            AuthTokens.updateAccessPolicy(memberType: value, accessExpiry: accessExpiry)
        } else {
            setDevCurrentAccess(memberType: value, accessExpiry: accessExpiry)
        }
    }

    /// Persist the server-verified active membership policy as one identity-bound
    /// unit. The expiry is an instant, so it can be enforced without connectivity
    /// even if the app remains open across the deadline.
    static func setCurrentAccess(memberType value: String?, accessExpiresAt: String?) {
        if AuthTokens.isSignedIn {
            AuthTokens.updateAccessPolicy(
                memberType: value,
                accessExpiry: accessExpiresAt.map(AccessExpiryField.value) ?? .null
            )
            return
        }
        setDevCurrentAccess(
            memberType: value,
            accessExpiry: accessExpiresAt.map(AccessExpiryField.value) ?? .null
        )
    }

    private static func setDevCurrentAccess(
        memberType value: String?, accessExpiry: AccessExpiryField
    ) {
        memberTypeLock.lock()
        let defaults = UserDefaults.standard
        if let value, builtInMemberTypes.contains(value), let authScope = currentIdentityScope {
            defaults.set(value, forKey: memberTypeKey)
            defaults.set(apiBaseURL, forKey: memberTypeServerKey)
            defaults.set(authScope, forKey: memberTypeAuthScopeKey)
            if ["caregiver", "guest"].contains(value) {
                switch accessExpiry {
                case let .value(raw):
                    defaults.set("value", forKey: accessExpiryPresenceKey)
                    defaults.set(raw, forKey: accessExpiryKey)
                case .null:
                    defaults.set("null", forKey: accessExpiryPresenceKey)
                    defaults.removeObject(forKey: accessExpiryKey)
                case .missing:
                    defaults.set("missing", forKey: accessExpiryPresenceKey)
                    defaults.removeObject(forKey: accessExpiryKey)
                case .malformed:
                    defaults.set("malformed", forKey: accessExpiryPresenceKey)
                    defaults.removeObject(forKey: accessExpiryKey)
                }
                defaults.set(apiBaseURL, forKey: accessExpiryServerKey)
                defaults.set(authScope, forKey: accessExpiryAuthScopeKey)
            } else {
                clearAccessExpiry(defaults)
            }
        } else {
            defaults.removeObject(forKey: memberTypeKey)
            defaults.removeObject(forKey: memberTypeServerKey)
            defaults.removeObject(forKey: memberTypeAuthScopeKey)
            clearAccessExpiry(defaults)
        }
        memberTypeLock.unlock()
        NotificationCenter.default.post(name: .waffledAccessPolicyChanged, object: nil)
    }

    private static func clearAccessExpiry(_ defaults: UserDefaults) {
        defaults.removeObject(forKey: accessExpiryKey)
        defaults.removeObject(forKey: accessExpiryPresenceKey)
        defaults.removeObject(forKey: accessExpiryServerKey)
        defaults.removeObject(forKey: accessExpiryAuthScopeKey)
    }

    static var currentAccessExpiresAt: Date? {
        if AuthTokens.isSignedIn {
            // `accessExpiresAt` is membership policy, not access-token lifetime. A
            // missing field is fail-closed only for temporary roles; permanent roles
            // do not arm the local expiry timer.
            guard let role = AuthTokens.memberType,
                  role == "caregiver" || role == "guest" else { return nil }
            guard let expiry = AuthTokens.accessExpiry else { return .distantPast }
            switch expiry {
            case .null: return nil
            case let .value(raw): return parseAccessInstant(raw) ?? .distantPast
            case .missing, .malformed: return .distantPast
            }
        }
        memberTypeLock.lock(); defer { memberTypeLock.unlock() }
        let defaults = UserDefaults.standard
        guard let role = defaults.string(forKey: memberTypeKey),
              role == "caregiver" || role == "guest" else { return nil }
        guard
              defaults.string(forKey: accessExpiryServerKey) == apiBaseURL,
              let authScope = currentIdentityScope,
              defaults.string(forKey: accessExpiryAuthScopeKey) == authScope else {
            clearAccessExpiry(defaults)
            return .distantPast
        }
        switch defaults.string(forKey: accessExpiryPresenceKey) {
        case "null": return nil
        case "value":
            guard let raw = defaults.string(forKey: accessExpiryKey) else { return .distantPast }
            return parseAccessInstant(raw) ?? .distantPast
        default: return .distantPast
        }
    }

    static func accessIsExpired(memberType: String?, accessExpiresAt: Date?, now: Date = Date()) -> Bool {
        guard memberType == "caregiver" || memberType == "guest", let accessExpiresAt else { return false }
        return accessExpiresAt <= now
    }

    static var currentAccessIsExpired: Bool {
        let role = currentMemberType
        guard role == "caregiver" || role == "guest" else { return false }
        if AuthTokens.isSignedIn {
            guard let expiry = AuthTokens.accessExpiry else { return true }
            switch expiry {
            case .null: return false
            case let .value(raw):
                guard let date = parseAccessInstant(raw) else { return true }
                return date <= Date()
            case .missing, .malformed: return true
            }
        }
        return accessIsExpired(memberType: role, accessExpiresAt: currentAccessExpiresAt)
    }

    /// Durable crash-safe latch set before expired credentials are deleted. Because the
    /// PowerSync database is a single shared file, no login/profile gate may reopen
    /// until `disconnectAndClear` succeeds and clears this marker.
    static var principalIsolationRequired: Bool {
        UserDefaults.standard.bool(forKey: principalIsolationRequiredKey)
    }

    static func requirePrincipalIsolation() {
        UserDefaults.standard.set(true, forKey: principalIsolationRequiredKey)
        UserDefaults.standard.synchronize()
    }

    static func clearPrincipalIsolationRequirement() {
        UserDefaults.standard.removeObject(forKey: principalIsolationRequiredKey)
    }

    static func parseAccessInstant(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }

    /// A rotating real session keeps one logical scope; a pasted/launch-env dev
    /// token gets a non-reversible fingerprint so changing it across launches also
    /// invalidates the cached role without copying that credential into defaults.
    static var currentIdentityScope: String? {
        if let scope = AuthTokens.identityScope { return scope }
        let token = devToken
        guard !token.isEmpty else { return nil }
        // A token is meaningful only at the origin that issued it. Including the
        // normalized server closes the A→B case where the same pasted dev token
        // would otherwise look like one principal and reconnect atop A's replica.
        let digest = SHA256.hash(data: Data((apiBaseURL + "\u{0}" + token).utf8))
        return "dev:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Any usable token — a real session or a dev token. Suppressed after an explicit sign-out.
    static var hasUsableToken: Bool {
        if principalIsolationRequired || currentAccessIsExpired { return false }
        if AuthTokens.isSignedIn { return true }
        if wasSignedOut { return false }
        return !devToken.isEmpty
    }

    /// A Waffled server is an HTTP(S) origin, not an API path or URL with credentials.
    /// Returns the canonical value without a trailing slash, or nil when malformed.
    static func normalizedApiBaseURL(_ value: String) -> String? {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty,
              var components = URLComponents(string: v),
              let rawScheme = components.scheme,
              ["http", "https"].contains(rawScheme.lowercased()),
              let rawHost = components.host, !rawHost.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else { return nil }
        components.scheme = rawScheme.lowercased()
        components.host = rawHost.lowercased()
        components.path = ""
        guard let url = components.url else { return nil }
        return url.absoluteString
    }

    /// Optional so corrupt stored values can never become a force-unwrap crash.
    static func apiURL(path: String, baseURL: String = apiBaseURL) -> URL? {
        guard path.hasPrefix("/"), let base = normalizedApiBaseURL(baseURL) else { return nil }
        return URL(string: base + path)
    }

    /// Save the server address, or clear it when blank. Invalid non-empty values are rejected.
    @discardableResult
    static func setApiBaseURL(_ value: String) -> Bool {
        let previous = apiBaseURL
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty {
            UserDefaults.standard.removeObject(forKey: urlKey)
            if apiBaseURL != previous { setCurrentMemberType(nil) }
            return true
        }
        guard let normalized = normalizedApiBaseURL(v) else { return false }
        UserDefaults.standard.set(normalized, forKey: urlKey)
        if apiBaseURL != previous { setCurrentMemberType(nil) }
        return true
    }

    static func setDevToken(_ value: String) {
        let previous = storedDevToken
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { UserDefaults.standard.removeObject(forKey: tokenKey) }
        else { UserDefaults.standard.set(v, forKey: tokenKey) }
        // A pasted developer token is dormant while a real Keychain session exists.
        // Clear only the dev-token policy cache; routing through setCurrentMemberType
        // would treat nil as a malformed update to the real session and fail-close it.
        if storedDevToken != previous {
            setDevCurrentAccess(memberType: nil, accessExpiry: .missing)
        }
    }

    private static let signedOutKey = "waffled.signedOut"

    /// Set when the user explicitly signs out. While set (and there's no real session) the
    /// dev-token fallback is ignored so logout sticks. Cleared on the next real login.
    static var wasSignedOut: Bool { UserDefaults.standard.bool(forKey: signedOutKey) }
    static func markSignedOut() {
        UserDefaults.standard.set(true, forKey: signedOutKey)
        UserDefaults.standard.synchronize()   // persist now, before any teardown
    }
    static func clearSignedOut() { UserDefaults.standard.removeObject(forKey: signedOutKey) }

    static func env(_ key: String) -> String? {
        let v = ProcessInfo.processInfo.environment[key]
        return (v?.isEmpty ?? true) ? nil : v
    }
}

/// Launch-env switches so demos and verification can be driven headlessly from `simctl`
/// (via `SIMCTL_CHILD_*`). Most of these exist only because the simulator has NO tap API,
/// so anything behind a tap is otherwise unreachable. No effect unless set.
enum DemoHooks {
    /// Initial tab: today | calendar | meals | family.
    static var startTab: String? { AppConfig.env("WAFFLED_START_TAB") }
    /// A Family-hub screen to push on launch: rhythms | pantry | chores | goals | lists |
    /// rewards | photos. The iPhone counterpart of `kioskPage`.
    static var hubPage: String? { AppConfig.env("WAFFLED_HUB_PAGE") }
    /// Open the rhythm editor on the register as soon as it appears: `new` for a blank one,
    /// or a rhythm's title to edit that one.
    static var rhythmEditor: String? { AppConfig.env("WAFFLED_RHYTHM_EDITOR") }
    static var rhythmEditorMore: Bool { AppConfig.env("WAFFLED_RHYTHM_MORE") == "1" }
    /// Initial iPad kiosk page (rail selection): today | calendar | tasks | goals |
    /// family | meals | lists | photos | settings. No effect on iPhone.
    static var kioskPage: String? { AppConfig.env("WAFFLED_KIOSK_PAGE") }
    /// Initial calendar mode for verification, on iPad and iPhone: month | week | day.
    static var kioskCalMode: String? { AppConfig.env("WAFFLED_CAL_MODE") }
    static var kioskOpenEvent: Bool { AppConfig.env("WAFFLED_KIOSK_OPEN_EVENT") == "1" }
    static var cookPlate: String? { AppConfig.env("WAFFLED_COOK_PLATE") }
    /// Replay a timer jump inside that session, as `fromStep:dishIndex:step` — open on
    /// `fromStep`, then jump to dish `dishIndex` at `step`, exactly as a fired timer would.
    static var cookJump: String? { AppConfig.env("WAFFLED_COOK_JUMP") }
    static var kioskOpenEdit: Bool { AppConfig.env("WAFFLED_KIOSK_OPEN_EDIT") == "1" }
    /// Push straight into a Settings sub-page on launch. Currently: `calendars`.
    static var settingsPage: String? { AppConfig.env("WAFFLED_SETTINGS_PAGE") }
    /// Push into the Pantry and open an item's detail on launch. Value: an item id, or
    /// `first` for the first item listed.
    static var pantryItem: String? { AppConfig.env("WAFFLED_PANTRY_ITEM") }
    /// Initial Meals section for verification: week | month | recipes.
    static var mealsSection: String? { AppConfig.env("WAFFLED_MEALS_SECTION") }
    static var looseEndsSeeAll: Bool { AppConfig.env("WAFFLED_LE_SEEALL") == "1" }
    static var openLists: Bool { AppConfig.env("WAFFLED_OPEN_LISTS") == "1" }
    static var planWeek: Bool { AppConfig.env("WAFFLED_PLAN_WEEK") == "1" }
    static var planMonth: Bool { AppConfig.env("WAFFLED_PLAN_MONTH") == "1" }
    static var openGoal: Bool { AppConfig.env("WAFFLED_OPEN_GOAL") == "1" }
    static var newGoal: Bool { AppConfig.env("WAFFLED_NEW_GOAL") == "1" }
    static var openPerson: Bool { AppConfig.env("WAFFLED_OPEN_PERSON") == "1" }
    static var openShop: Bool { AppConfig.env("WAFFLED_OPEN_SHOP") == "1" }
    static var openSync: Bool { AppConfig.env("WAFFLED_OPEN_SYNC") == "1" }
    static var addEvent: Bool { AppConfig.env("WAFFLED_DEMO_ADD_EVENT") == "1" }
    static var openCapture: Bool { AppConfig.env("WAFFLED_OPEN_CAPTURE") == "1" }
    static var captureText: String? { AppConfig.env("WAFFLED_DEMO_CAPTURE") }
    static var captureCommit: Bool { AppConfig.env("WAFFLED_DEMO_CAPTURE_COMMIT") == "1" }
    /// Deep-link a Family hub tile on launch: chores | goals | rewards | lists | photos | settings.
    static var openHub: String? { AppConfig.env("WAFFLED_OPEN_HUB") }
    /// With openHub=lists, also open a specific list by type or name (e.g. "grocery").
    static var openList: String? { AppConfig.env("WAFFLED_OPEN_LIST") }
    static var openDetails: Bool { AppConfig.env("WAFFLED_OPEN_DETAILS") == "1" }
    /// Force the scene's interface orientation on launch: "landscape" | "portrait". The
    /// Simulator has no headless rotate API, so the app requests the rotation itself.
    static var forceOrientation: String? { AppConfig.env("WAFFLED_ORIENTATION") }
    /// Auto-focus the add field (keyboard verification): a list detail's "Add item",
    /// or — with kioskPage=today — the Today grocery card's quick-add.
    static var focusAdd: Bool { AppConfig.env("WAFFLED_FOCUS_ADD") == "1" }
    /// Auto-focus a planning session's park-a-note field (step 1's capture bar, step 3's park
    /// bar). The footer is PINNED, so the band above the keyboard is only measurable with it up.
    static var focusPark: Bool { AppConfig.env("WAFFLED_FOCUS_PARK") == "1" }
    static var skipBootCover: Bool { AppConfig.env("WAFFLED_SKIP_BOOT_COVER") == "1" }
    /// Initial grocery board mode for verification: "meal" switches to By meal.
    static var groceryMode: String? { AppConfig.env("WAFFLED_GROCERY_MODE") }
    static var openRecipe: String? { AppConfig.env("WAFFLED_OPEN_RECIPE") }
    static var resetAuth: Bool { AppConfig.env("WAFFLED_RESET_AUTH") == "1" }
}
