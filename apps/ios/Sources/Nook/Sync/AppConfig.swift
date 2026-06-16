import Foundation

/// Where the app points and how it authenticates — device-only settings.
///
/// Precedence: launch environment (so the demo can be scripted with
/// `SIMCTL_CHILD_NOOK_DEV_TOKEN=…`) → UserDefaults (Settings sheet) → dev default.
/// Auth0 (Phase 4) replaces the pasted dev token; the JWT shape is identical.
enum AppConfig {
    private static let urlKey = "nook.apiBaseURL"
    private static let tokenKey = "nook.devToken"

    /// Our API base. The iOS simulator reaches the host Mac on `localhost`.
    static var apiBaseURL: String {
        env("NOOK_API_URL")
            ?? UserDefaults.standard.string(forKey: urlKey)
            ?? "http://localhost:3000"
    }

    /// Local HS256 session token (mint via `just token` / `nook token`). The API's
    /// `requireTenant` validates it and `/api/powersync/token` exchanges it for a
    /// short-lived PowerSync RS256 token.
    static var devToken: String {
        env("NOOK_DEV_TOKEN")
            ?? UserDefaults.standard.string(forKey: tokenKey)
            ?? ""
    }

    static func setApiBaseURL(_ value: String) {
        UserDefaults.standard.set(value, forKey: urlKey)
    }

    static func setDevToken(_ value: String) {
        UserDefaults.standard.set(value, forKey: tokenKey)
    }

    static func env(_ key: String) -> String? {
        let v = ProcessInfo.processInfo.environment[key]
        return (v?.isEmpty ?? true) ? nil : v
    }
}

/// Launch-env switches so the Phase 1 sync demo can be driven headlessly from
/// `simctl` (via `SIMCTL_CHILD_*`) instead of manual taps. No effect unless set.
enum DemoHooks {
    /// Initial tab: today | calendar | meals | family.
    static var startTab: String? { AppConfig.env("NOOK_START_TAB") }
    /// Auto-present the Sync panel on the Family screen.
    static var openSync: Bool { AppConfig.env("NOOK_OPEN_SYNC") == "1" }
    /// Insert one offline test event once members have synced.
    static var addEvent: Bool { AppConfig.env("NOOK_DEMO_ADD_EVENT") == "1" }
}
