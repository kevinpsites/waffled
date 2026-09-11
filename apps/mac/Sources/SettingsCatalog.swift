import Foundation

/// One api setting a household may tune from Advanced or Diagnostics.
///
/// Every key here is one the runtime forwards to the api (`services.go` passthroughKeys)
/// or reads itself — `SettingsCatalogTests` checks that against the runtime's source. The
/// placeholder is the api's own default, which is what a blank field leaves in force.
struct EnvSetting: Equatable {
    enum Kind: Equatable {
        case text
        /// Written only when filled in, never remembered, never shown back.
        case secret
        case url
        case count(minimum: Int)
        /// Asked for in seconds, written in milliseconds.
        case seconds
        /// On writes "1", off writes nothing — the api checks for exactly "1".
        case toggle
        case choice([Choice], default: String)
    }

    struct Choice: Equatable {
        var value: String
        var label: String
    }

    var key: String
    var label: String
    var placeholder = ""
    var kind = Kind.text

    var choices: [Choice] {
        if case let .choice(choices, _) = kind { return choices }
        return []
    }

    /// Why this value cannot be applied, or nil. Blank is always fine: it is the default.
    func problem(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return nil }
        switch kind {
        case .url where !SetupOptions.isWebURL(value):
            return "\(label) is a URL, like https://waffled.home."
        case let .count(minimum) where Int(value).map { $0 < minimum } ?? true:
            return "\(label) is a whole number of at least \(minimum)."
        case .seconds where Int(value).map { $0 < 1 } ?? true:
            return "\(label) is a whole number of seconds."
        default:
            return nil
        }
    }

    /// What goes into config.env for a value as typed.
    func written(_ value: String) -> String {
        if case .seconds = kind, let seconds = Int(value) { return String(seconds * 1000) }
        return value
    }
}

/// A group of settings under one heading.
struct SettingsSection: Equatable {
    var title: String
    var detail: String
    var settings: [EnvSetting]
}

/// Everything Advanced and Diagnostics offer, in the order they are shown and written.
///
/// Deliberately a curated list and not a free-form KEY=VALUE table: a key outside the
/// runtime's allowlist is written to config.env and reaches nothing. What the redesign
/// drew but nothing reads yet — offsite backup, a separate folder for photos or backups,
/// OpenTelemetry, an update channel, a rolling log file — is left out until it does
/// (docs/product/mac-settings-redesign.md §3d).
enum SettingsCatalog {
    static let advanced: [SettingsSection] = [
        SettingsSection(
            title: "AI model and limits",
            detail: """
                The model each provider uses unless the household picks another in Waffled's \
                own Settings, and how patiently it waits for one.
                """,
            settings: [
                EnvSetting(key: "ANTHROPIC_MODEL", label: "Claude model", placeholder: "claude-haiku-4-5-20251001"),
                EnvSetting(key: "OPENAI_MODEL", label: "OpenAI-compatible model", placeholder: "gpt-4o-mini"),
                EnvSetting(key: "OLLAMA_MODEL", label: "Ollama model", placeholder: "llama3.1"),
                EnvSetting(key: "AI_TIMEOUT_MS", label: "Timeout (seconds)", placeholder: "30", kind: .seconds),
                EnvSetting(key: "AI_MAX_RETRIES", label: "Retries", placeholder: "2", kind: .count(minimum: 0)),
            ]),
        SettingsSection(
            title: "Calendar sync",
            detail: """
                Your own OAuth app, so family members can connect Google or Microsoft \
                calendars. The redirect address must match the one registered on the app, \
                ending in /auth/google/calendar/callback or /auth/microsoft/calendar/callback.
                """,
            settings: [
                EnvSetting(key: "GOOGLE_CLIENT_ID", label: "Google client ID"),
                EnvSetting(key: "GOOGLE_CLIENT_SECRET", label: "Google client secret", kind: .secret),
                EnvSetting(key: "GOOGLE_CALENDAR_REDIRECT_URI", label: "Google redirect address",
                           placeholder: "http://waffled.local:8080/auth/google/calendar/callback", kind: .url),
                EnvSetting(key: "MS_CLIENT_ID", label: "Microsoft client ID"),
                EnvSetting(key: "MS_CLIENT_SECRET", label: "Microsoft client secret", kind: .secret),
                EnvSetting(key: "MS_CALENDAR_REDIRECT_URI", label: "Microsoft redirect address",
                           placeholder: "http://waffled.local:8080/auth/microsoft/calendar/callback", kind: .url),
            ]),
        SettingsSection(
            title: "Sessions and sign-in",
            detail: "How long people stay signed in, and where sign-in sends them back to.",
            settings: [
                EnvSetting(key: "ACCESS_TOKEN_TTL_SECONDS", label: "Sign-in token lifetime (seconds)",
                           placeholder: "3600", kind: .count(minimum: 60)),
                EnvSetting(key: "REFRESH_TOKEN_TTL_DAYS", label: "Stay signed in for (days)",
                           placeholder: "60", kind: .count(minimum: 1)),
                EnvSetting(key: "AUTH_FORCE_PASSWORD", label: "Always show the password form", kind: .toggle),
                EnvSetting(key: "PUBLIC_BASE_URL", label: "Sign-in return address",
                           placeholder: "Worked out from each request", kind: .url),
                EnvSetting(key: "OIDC_NATIVE_REDIRECT_URI", label: "App sign-in callback",
                           placeholder: "waffled://auth/callback"),
            ]),
        SettingsSection(
            title: "Rate limits",
            detail: """
                How many tries the sensitive routes allow before they make someone wait. The \
                time windows are built in; only the counts change.
                """,
            settings: [
                EnvSetting(key: "RATE_LIMIT_SETUP_MAX", label: "First-time setup", placeholder: "5", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_LOGIN_ACCOUNT_MAX", label: "Sign-ins per account", placeholder: "10", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_LOGIN_IP_MAX", label: "Sign-ins per device", placeholder: "50", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_OIDC_START_MAX", label: "Single sign-on starts", placeholder: "30", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_OIDC_EXCHANGE_MAX", label: "Single sign-on returns", placeholder: "20", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_REFRESH_MAX", label: "Session refreshes", placeholder: "60", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_KIOSK_PAIR_MAX", label: "Kiosk pairing", placeholder: "10", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_KIOSK_TOKEN_MAX", label: "Kiosk sign-ins", placeholder: "30", kind: .count(minimum: 1)),
                EnvSetting(key: "RATE_LIMIT_MEDIA_MAX", label: "Photo uploads", placeholder: "30", kind: .count(minimum: 1)),
            ]),
    ]

    static let diagnostics: [SettingsSection] = [
        SettingsSection(
            title: "Logging",
            detail: """
                What the server writes to api.log. Readable text is easier to scan but its \
                lines carry no timestamp.
                """,
            settings: [
                EnvSetting(key: "LOG_LEVEL", label: "Detail", kind: .choice([
                    .init(value: "debug", label: "Everything"),
                    .init(value: "info", label: "Normal"),
                    .init(value: "warn", label: "Warnings"),
                    .init(value: "error", label: "Errors only"),
                ], default: "info")),
                EnvSetting(key: "LOG_FORMAT", label: "Format", kind: .choice([
                    .init(value: "json", label: "Structured (JSON)"),
                    .init(value: "pretty", label: "Readable text"),
                ], default: "json")),
            ]),
    ]

    static var all: [EnvSetting] { (advanced + diagnostics).flatMap(\.settings) }

    static func sections(in tab: SettingsPresentation.Tab) -> [SettingsSection] {
        switch tab {
        case .basic: return []
        case .advanced: return advanced
        case .diagnostics: return diagnostics
        }
    }
}

/// The Basic rows that open into a drawer. Each collapsed row says what is in force, so
/// the screen fits the window without scrolling and nothing hides behind a click.
enum SettingsDrawer: String, CaseIterable, Equatable {
    case files, backup, address, provider

    func summary(_ options: SetupOptions) -> String {
        switch self {
        case .files:
            return ""
        case .backup:
            guard options.backupEnabled else { return "Off" }
            return "Nightly at \(SetupOptions.backupTimeLabel(options.backupAt)) · keeps the last \(options.backupKeep)"
        case .address:
            switch options.addressMode {
            case .name: return "This Mac's name"
            case .ip: return "Its IP address"
            case .custom: return options.customHost.isEmpty ? "A name I've set up myself" : options.customHost
            }
        case .provider:
            return options.provider == .ollama
                ? "Ollama at \(options.ollamaHost)" : options.provider.label
        }
    }
}

/// Whether Ollama is running where the household says it is, asked once when the segment
/// is chosen or the address changes — never on a timer.
enum OllamaProbe {
    enum Result: Equatable {
        case checking
        case running(models: [String])
        case notAnswering

        var sentence: String {
            switch self {
            case .checking:
                return "Looking for Ollama…"
            case let .running(models) where models.isEmpty:
                return "Ollama is running here, but has no models yet — `ollama pull llama3.1` adds one."
            case let .running(models):
                let noun = models.count == 1 ? "model" : "models"
                return "Ollama is running here, with \(models.count) \(noun): \(models.joined(separator: ", "))."
            case .notAnswering:
                return "Nothing answered at that address. Is Ollama open?"
            }
        }
    }

    static func tagsURL(host: String) -> URL? {
        guard SetupOptions.isWebURL(host) else { return nil }
        var base = host.trimmingCharacters(in: .whitespaces)
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + "/api/tags")
    }

    /// The model names in Ollama's `/api/tags` answer; nil when it is not that answer.
    static func models(in data: Data) -> [String]? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = object["models"] as? [[String: Any]] else { return nil }
        return models.compactMap { $0["name"] as? String }
    }

    static func check(host: String) async -> Result {
        guard let url = tagsURL(host: host) else { return .notAnswering }
        var request = URLRequest(url: url, timeoutInterval: 2)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let models = models(in: data) else { return .notAnswering }
        return .running(models: models)
    }
}
