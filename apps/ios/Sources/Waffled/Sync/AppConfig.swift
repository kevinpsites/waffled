import Foundation

/// Where the app points and how it authenticates — device-only settings.
///
/// Precedence: launch environment (so the demo can be scripted with
/// `SIMCTL_CHILD_WAFFLED_DEV_TOKEN=…`) → UserDefaults (Settings sheet) → dev default.
/// Auth0 (Phase 4) replaces the pasted dev token; the JWT shape is identical.
enum AppConfig {
    private static let urlKey = "waffled.apiBaseURL"
    private static let tokenKey = "waffled.devToken"

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
        env("WAFFLED_API_URL")
            ?? UserDefaults.standard.string(forKey: urlKey)
            ?? defaultBaseURL
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

    /// Whether the app has *any* usable token — a real session or a dev token. Used
    /// to gate the login screen (headless demos with a dev token skip login). After an
    /// explicit sign-out the dev-token fallback is suppressed so logout sticks.
    static var hasUsableToken: Bool {
        if AuthTokens.isSignedIn { return true }
        if wasSignedOut { return false }
        return !devToken.isEmpty
    }

    /// Save the server address, or clear it (fall back to `defaultBaseURL`) when blank.
    static func setApiBaseURL(_ value: String) {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { UserDefaults.standard.removeObject(forKey: urlKey) }
        else { UserDefaults.standard.set(v, forKey: urlKey) }
    }

    /// Save the dev token, or clear it when blank.
    static func setDevToken(_ value: String) {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { UserDefaults.standard.removeObject(forKey: tokenKey) }
        else { UserDefaults.standard.set(v, forKey: tokenKey) }
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
    /// Initial iPad kiosk page (rail selection): today | calendar | tasks | goals |
    /// family | meals | lists | photos | settings. No effect on iPhone.
    static var kioskPage: String? { AppConfig.env("WAFFLED_KIOSK_PAGE") }
    /// Initial iPad calendar mode for verification: month | week | day.
    static var kioskCalMode: String? { AppConfig.env("WAFFLED_CAL_MODE") }
    /// Auto-open the first event's detail on the iPad calendar (verification).
    static var kioskOpenEvent: Bool { AppConfig.env("WAFFLED_KIOSK_OPEN_EVENT") == "1" }
    /// Auto-open the first event's editor on the iPad calendar (verification).
    static var kioskOpenEdit: Bool { AppConfig.env("WAFFLED_KIOSK_OPEN_EDIT") == "1" }
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
