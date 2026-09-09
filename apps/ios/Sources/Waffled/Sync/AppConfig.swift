import Foundation

/// Where the app points and how it authenticates — device-only settings.
///
/// Precedence: launch environment (so demos can be scripted with
/// `SIMCTL_CHILD_WAFFLED_DEV_TOKEN=…`) → UserDefaults (Settings sheet) → dev default.
enum AppConfig {
    private static let urlKey = "waffled.apiBaseURL"
    private static let tokenKey = "waffled.devToken"

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
        AuthTokens.accessToken ?? devToken
    }

    /// Any usable token — a real session or a dev token. Suppressed after an explicit sign-out.
    static var hasUsableToken: Bool {
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
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty {
            UserDefaults.standard.removeObject(forKey: urlKey)
            return true
        }
        guard let normalized = normalizedApiBaseURL(v) else { return false }
        UserDefaults.standard.set(normalized, forKey: urlKey)
        return true
    }

    static func setDevToken(_ value: String) {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { UserDefaults.standard.removeObject(forKey: tokenKey) }
        else { UserDefaults.standard.set(v, forKey: tokenKey) }
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
    /// Initial iPad calendar mode for verification: month | week | day.
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
