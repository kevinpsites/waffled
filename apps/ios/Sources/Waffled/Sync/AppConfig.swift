import CryptoKit
import Foundation

/// Where the app points and how it authenticates — device-only settings.
///
/// Precedence: launch environment (so the demo can be scripted with
/// `SIMCTL_CHILD_WAFFLED_DEV_TOKEN=…`) → UserDefaults (Settings sheet) → dev default.
/// Auth0 (Phase 4) replaces the pasted dev token; the JWT shape is identical.
enum AppConfig {
    private static let urlKey = "waffled.apiBaseURL"
    private static let tokenKey = "waffled.devToken"
    private static let memberTypeKey = "waffled.currentMemberType"
    private static let memberTypeServerKey = "waffled.currentMemberTypeServer"
    private static let memberTypeAuthScopeKey = "waffled.currentMemberTypeAuthScope"
    private static let builtInMemberTypes: Set<String> = ["adult", "caregiver", "guest", "teen", "kid"]
    private static let memberTypeLock = NSLock()

    /// The built-in fallback server address — the compose stack's Caddy origin (serves
    /// /api + /media). Exposed so the About screen can show/reset to it.
    static let defaultBaseURL = "http://localhost:8080"

    /// The address explicitly saved in Settings (nil if unset — i.e. using the default).
    static var storedApiBaseURL: String? { UserDefaults.standard.string(forKey: urlKey) }
    /// The dev token explicitly saved in Settings (ignores the env override).
    static var storedDevToken: String { UserDefaults.standard.string(forKey: tokenKey) ?? "" }

    /// Our API base — the single public origin Caddy fronts (it proxies `/api/*` to the
    /// api container AND serves uploaded media at `/media/*`). It must be the Caddy
    /// origin, NOT the api's own port: the api alone (`:3000`) doesn't serve `/media`, so
    /// photo/recipe/proof images would 404 and fall back to a placeholder. The default
    /// targets the compose stack's Caddy (`:8080` on the host); the simulator reaches the
    /// host Mac on `localhost`. On a real device, set the Server address to the Mac's LAN
    /// IP on that same Caddy port. Override via the Settings sheet or `WAFFLED_API_URL`.
    static var apiBaseURL: String {
        let candidate = env("WAFFLED_API_URL")
            ?? UserDefaults.standard.string(forKey: urlKey)
            ?? defaultBaseURL
        return normalizedApiBaseURL(candidate) ?? defaultBaseURL
    }

    /// Local HS256 session token (mint via `just token` / `waffled token`). The API's
    /// `requireTenant` validates it and `/api/powersync/token` exchanges it for a
    /// short-lived PowerSync RS256 token.
    ///
    /// This is now the *fallback* path: real users sign in (tokens live in the
    /// Keychain via `AuthTokens`); a pasted/env dev token still works for headless
    /// demos and local development.
    static var devToken: String {
        env("WAFFLED_DEV_TOKEN")
            ?? UserDefaults.standard.string(forKey: tokenKey)
            ?? ""
    }

    /// The bearer token every request carries: a real signed-in access token when
    /// present, else the dev token. Read at call time so login/refresh/logout take
    /// effect on the next request.
    static var bearerToken: String {
        AuthTokens.accessToken ?? devToken
    }

    /// The active household role, loaded from `/api/household`. Its last verified
    /// built-in value survives a cold offline launch, but only for the same server.
    /// Explicit session/profile/token changes clear it at their mutation boundary.
    /// WaffledAPI reads this shared value so every feature client applies the guest
    /// read-only rule, including models without the app's SyncManager environment.
    static var currentMemberType: String? {
        memberTypeLock.lock(); defer { memberTypeLock.unlock() }
        let defaults = UserDefaults.standard
        guard let memberType = defaults.string(forKey: memberTypeKey),
              builtInMemberTypes.contains(memberType),
              defaults.string(forKey: memberTypeServerKey) == apiBaseURL,
              let authScope = memberTypeAuthScope(),
              defaults.string(forKey: memberTypeAuthScopeKey) == authScope else {
            defaults.removeObject(forKey: memberTypeKey)
            defaults.removeObject(forKey: memberTypeServerKey)
            defaults.removeObject(forKey: memberTypeAuthScopeKey)
            return nil
        }
        return memberType
    }
    static func setCurrentMemberType(_ value: String?) {
        memberTypeLock.lock(); defer { memberTypeLock.unlock() }
        let defaults = UserDefaults.standard
        if let value, builtInMemberTypes.contains(value), let authScope = memberTypeAuthScope() {
            defaults.set(value, forKey: memberTypeKey)
            defaults.set(apiBaseURL, forKey: memberTypeServerKey)
            defaults.set(authScope, forKey: memberTypeAuthScopeKey)
        } else {
            defaults.removeObject(forKey: memberTypeKey)
            defaults.removeObject(forKey: memberTypeServerKey)
            defaults.removeObject(forKey: memberTypeAuthScopeKey)
        }
    }

    /// A rotating real session keeps one logical scope; a pasted/launch-env dev
    /// token gets a non-reversible fingerprint so changing it across launches also
    /// invalidates the cached role without copying that credential into defaults.
    private static func memberTypeAuthScope() -> String? {
        if AuthTokens.isSignedIn { return "session" }
        let token = devToken
        guard !token.isEmpty else { return nil }
        let digest = SHA256.hash(data: Data(token.utf8))
        return "dev:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Whether the app has *any* usable token — a real session or a dev token. Used
    /// to gate the login screen (headless demos with a dev token skip login). After an
    /// explicit sign-out the dev-token fallback is suppressed so logout sticks.
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

    /// Build a request URL from a validated origin. Kept optional so corrupt legacy
    /// preferences or launch overrides can never become a force-unwrap crash.
    static func apiURL(path: String, baseURL: String = apiBaseURL) -> URL? {
        guard path.hasPrefix("/"), let base = normalizedApiBaseURL(baseURL) else { return nil }
        return URL(string: base + path)
    }

    /// Save the server address, or clear it (fall back to `defaultBaseURL`) when blank.
    /// Invalid non-empty values are rejected without replacing the current server.
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

    /// Save the dev token, or clear it when blank.
    static func setDevToken(_ value: String) {
        let previous = storedDevToken
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { UserDefaults.standard.removeObject(forKey: tokenKey) }
        else { UserDefaults.standard.set(v, forKey: tokenKey) }
        if storedDevToken != previous { setCurrentMemberType(nil) }
    }

    private static let signedOutKey = "waffled.signedOut"

    /// Set when the user explicitly signs out. While set (and there's no real
    /// session), we ignore the dev-token fallback so logout actually sticks — even
    /// when a dev/env `WAFFLED_DEV_TOKEN` is present. Cleared on the next real login.
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

/// Launch-env switches so the Phase 1 sync demo can be driven headlessly from
/// `simctl` (via `SIMCTL_CHILD_*`) instead of manual taps. No effect unless set.
enum DemoHooks {
    /// Initial tab: today | calendar | meals | family.
    static var startTab: String? { AppConfig.env("WAFFLED_START_TAB") }
    /// A Family-hub screen to push on launch: rhythms | pantry | chores | goals |
    /// lists | rewards | photos. The iPhone counterpart of `kioskPage` — those screens
    /// are otherwise only reachable by tapping, and the simulator has no tap API, so
    /// without this the phone rendering of any of them can't be looked at headlessly.
    static var hubPage: String? { AppConfig.env("WAFFLED_HUB_PAGE") }
    /// Open the rhythm editor on the register as soon as it appears: `new` for a blank
    /// one, or a rhythm's title to edit that one. Same reason as `cookPlate` — a sheet
    /// behind a toolbar button can't be reached without a tap, and there is no tap API.
    static var rhythmEditor: String? { AppConfig.env("WAFFLED_RHYTHM_EDITOR") }
    /// Open that editor with More options already expanded — the disclosure is behind a
    /// tap like everything else here.
    static var rhythmEditorMore: Bool { AppConfig.env("WAFFLED_RHYTHM_MORE") == "1" }
    /// Initial iPad kiosk page (rail selection): today | calendar | tasks | goals |
    /// family | meals | lists | photos | settings. No effect on iPhone.
    static var kioskPage: String? { AppConfig.env("WAFFLED_KIOSK_PAGE") }
    /// Initial iPad calendar mode for verification: month | week | day.
    static var kioskCalMode: String? { AppConfig.env("WAFFLED_CAL_MODE") }
    /// Auto-open the first event's detail on the iPad calendar (verification).
    static var kioskOpenEvent: Bool { AppConfig.env("WAFFLED_KIOSK_OPEN_EVENT") == "1" }
    /// Start Cook Mode for a plate on launch (verification). Cook Mode is otherwise
    /// only reachable by tapping, and the simulator has no tap API — so without this
    /// the whole multi-dish cook screen can't be looked at headlessly at all.
    static var cookPlate: String? { AppConfig.env("WAFFLED_COOK_PLATE") }
    /// Replay a timer jump inside that session, as `fromStep:dishIndex:step` — put the
    /// opening dish on `fromStep`, then jump to dish `dishIndex` at `step`, exactly as a
    /// fired timer would. Used to look at the "back to where I was" offer.
    static var cookJump: String? { AppConfig.env("WAFFLED_COOK_JUMP") }
    /// Auto-open the first event's editor on the iPad calendar (verification).
    static var kioskOpenEdit: Bool { AppConfig.env("WAFFLED_KIOSK_OPEN_EDIT") == "1" }
    /// Push straight into a Settings sub-page on launch (verification). Settings is a
    /// nav stack you can only get into by tapping, and the simulator has no tap API,
    /// so without this the sub-screens can't be looked at headlessly at all.
    /// Currently: `calendars`.
    static var settingsPage: String? { AppConfig.env("WAFFLED_SETTINGS_PAGE") }
    /// Push straight into the Pantry and open an item's detail on launch
    /// (verification). On iPhone the pantry sits behind the Family hub and its detail
    /// behind a row tap, and the simulator has no tap API — so without this the item
    /// screen (and whether its Edit button clears the tab bar) can't be looked at
    /// headlessly at all. Value: an item id, or `first` for the first item listed.
    static var pantryItem: String? { AppConfig.env("WAFFLED_PANTRY_ITEM") }
    /// Initial Meals section for verification: week | month | recipes.
    static var mealsSection: String? { AppConfig.env("WAFFLED_MEALS_SECTION") }
    /// Auto-open the "Plan my week" sheet (verification).
    static var planWeek: Bool { AppConfig.env("WAFFLED_PLAN_WEEK") == "1" }
    /// Auto-open the "Plan my month" sheet (verification).
    static var planMonth: Bool { AppConfig.env("WAFFLED_PLAN_MONTH") == "1" }
    /// Auto-open the featured goal's detail on the iPad Goals page (verification).
    static var openGoal: Bool { AppConfig.env("WAFFLED_OPEN_GOAL") == "1" }
    /// Auto-open the "New goal" create sheet on the Goals page (verification).
    static var newGoal: Bool { AppConfig.env("WAFFLED_NEW_GOAL") == "1" }
    /// Auto-open the first member's spotlight on the iPad Family page (verification).
    static var openPerson: Bool { AppConfig.env("WAFFLED_OPEN_PERSON") == "1" }
    /// Open the first kid's reward shop (headless verification of the shop).
    static var openShop: Bool { AppConfig.env("WAFFLED_OPEN_SHOP") == "1" }
    /// Auto-present the Sync panel on the Family screen.
    static var openSync: Bool { AppConfig.env("WAFFLED_OPEN_SYNC") == "1" }
    /// Insert one offline test event once members have synced.
    static var addEvent: Bool { AppConfig.env("WAFFLED_DEMO_ADD_EVENT") == "1" }
    /// Auto-present the capture sheet on launch.
    static var openCapture: Bool { AppConfig.env("WAFFLED_OPEN_CAPTURE") == "1" }
    /// Prefill the capture sheet with this text and auto-parse it.
    static var captureText: String? { AppConfig.env("WAFFLED_DEMO_CAPTURE") }
    /// Also auto-commit the parsed capture (use with captureText).
    static var captureCommit: Bool { AppConfig.env("WAFFLED_DEMO_CAPTURE_COMMIT") == "1" }
    /// Deep-link a Family hub tile on launch: chores | goals | rewards | lists | photos | settings.
    static var openHub: String? { AppConfig.env("WAFFLED_OPEN_HUB") }
    /// With openHub=lists, also open a specific list by type or name (e.g. "grocery").
    static var openList: String? { AppConfig.env("WAFFLED_OPEN_LIST") }
    /// With openList set, auto-present the first item's Details editor (verification).
    static var openDetails: Bool { AppConfig.env("WAFFLED_OPEN_DETAILS") == "1" }
    /// Force the scene's interface orientation on launch: "landscape" | "portrait".
    /// The Simulator has no headless rotate API, so landscape keyboard checks (the
    /// iPad inset under-report, PR #90/#92) request the rotation from inside the app.
    static var forceOrientation: String? { AppConfig.env("WAFFLED_ORIENTATION") }
    /// Auto-focus the add field (keyboard verification): a list detail's "Add item",
    /// or — with kioskPage=today — the Today grocery card's quick-add.
    static var focusAdd: Bool { AppConfig.env("WAFFLED_FOCUS_ADD") == "1" }
    /// Skip the iPad boot cover (headless verification of REST-driven kiosk pages
    /// when the PowerSync endpoint isn't reachable from the simulator).
    static var skipBootCover: Bool { AppConfig.env("WAFFLED_SKIP_BOOT_COVER") == "1" }
    /// Initial grocery board mode for verification: "meal" switches to By meal.
    static var groceryMode: String? { AppConfig.env("WAFFLED_GROCERY_MODE") }
    /// On the Meals tab, push a recipe's detail by title substring (verification).
    static var openRecipe: String? { AppConfig.env("WAFFLED_OPEN_RECIPE") }
    /// Clear any stored session on launch and start at the login screen (QA/demo).
    static var resetAuth: Bool { AppConfig.env("WAFFLED_RESET_AUTH") == "1" }
}
