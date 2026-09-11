import Foundation

/// What the "Where things go" screen collects, and the runtime calls it owes.
///
/// It is a value for the same reason the menu and the window are: the argv the app would
/// really have used can be asserted without spawning anything, and every rule about what
/// a household may type lives in one place rather than in five controls.
///
/// Everything here is applied BEFORE the first `start`, so the first boot already uses
/// the folder, the port and the name that were chosen.
struct SetupOptions: Equatable, Codable {
    /// How other devices address this Mac. The two reserved words are the runtime's
    /// (`WAFFLED_PUBLIC_HOST`); `custom` carries a name the household set up themselves.
    enum AddressMode: String, CaseIterable, Equatable, Codable {
        case name, ip, custom
    }

    /// Which provider's credential the AI settings row writes. config.env only makes a provider
    /// AVAILABLE; which one a household uses, and its model, is chosen per household in the
    /// web app's Settings — so each case writes a credential and nothing else.
    enum Provider: String, CaseIterable, Equatable, Codable {
        case none, anthropic, openai, ollama

        /// The credential the api reads for this provider. Ollama's is its address.
        var configKey: String? {
            switch self {
            case .none: return nil
            case .anthropic: return "ANTHROPIC_API_KEY"
            case .openai: return "OPENAI_API_KEY"
            case .ollama: return "OLLAMA_HOST"
            }
        }

        var label: String {
            switch self {
            case .none: return "Not now"
            case .anthropic: return "Claude"
            case .openai: return "OpenAI-compatible"
            case .ollama: return "Ollama"
            }
        }

        var needsKey: Bool { self == .anthropic || self == .openai }

        static let credentialKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_HOST"]
    }

    /// nil means the default, `~/Library/Application Support/Waffled`.
    var dataDirectory: URL?
    var backupEnabled = true
    var backupAt = SetupOptions.defaultBackupAt
    var backupKeep = SetupOptions.defaultBackupKeep
    var provider = Provider.none
    /// The chosen provider's key. A secret: never remembered, and blank means unchanged.
    var providerKey = ""
    /// An OpenAI-compatible server somewhere other than OpenAI. Blank is the api's default.
    var openAIBaseURL = ""
    var ollamaHost = SetupOptions.defaultOllamaHost
    var startAtLogin = true
    var addressMode = AddressMode.ip
    var customHost = ""
    var port = String(SetupOptions.defaultPort)
    /// Advanced and Diagnostics values as typed, keyed by the variable they write — see
    /// `SettingsCatalog`. Empty or absent is the api's own default.
    var settings: [String: String] = [:]
    /// The catalog's secret fields. Like `providerKey`: never remembered, blank is unchanged.
    var secrets: [String: String] = [:]

    /// What is written down between launches, so `Settings…` knows what it is comparing
    /// against. The secrets are deliberately absent — they belong in owner-only config.env,
    /// not the app's preferences file — and so is `dataDirectory`, which already has a key
    /// of its own and would only get a chance to disagree with it.
    private enum CodingKeys: String, CodingKey {
        case backupEnabled, backupAt, backupKeep, provider, openAIBaseURL, ollamaHost
        case startAtLogin, addressMode, customHost, port, settings
    }

    static let defaultBackupAt = "03:00"
    static let defaultPort = 8080
    /// The runtime's own default retention (`backup.DefaultKeepDumps`).
    static let defaultBackupKeep = 14
    /// No "keep everything": the runtime has no such mode, so it would be a choice that
    /// silently kept 14.
    static let retentionChoices = [7, 14, 30, 90]
    static let defaultOllamaHost = "http://localhost:11434"
    /// The times the screen offers. The runtime takes any HH:MM; these are the four a
    /// household is actually choosing between, and Noon is in there because a Mac that
    /// sleeps at night backs up at lunchtime or never.
    static let backupTimes = ["01:00", "03:00", "05:00", "12:00"]

    static func backupTimeLabel(_ at: String) -> String {
        switch at {
        case "12:00": return "Noon"
        case "00:00": return "Midnight"
        default:
            let hour = Int(at.prefix(2)) ?? 0
            let minutes = at.suffix(2)
            let suffix = hour < 12 ? "AM" : "PM"
            let twelve = hour % 12 == 0 ? 12 : hour % 12
            return "\(twelve):\(minutes) \(suffix)"
        }
    }

    /// Every variable this app can ask the runtime to write. `SettingsCatalogTests` checks
    /// each one against what the runtime really reads.
    static var keysTheAppWrites: [String] {
        ["WAFFLED_PUBLIC_HOST", "HTTP_PORT", "OPENAI_BASE_URL"]
            + Provider.credentialKeys + SettingsCatalog.all.map(\.key)
    }

    // MARK: what a person may type

    /// The reasons the first-run screen cannot be applied yet, in the words the rows show.
    /// Empty means "Set up Waffled" is a working button.
    var problems: [String] { problems(comparedTo: SetupOptions()) }

    /// The same, against what was applied last — which is what `Settings…` needs, because
    /// a key field that opens blank there means "unchanged" rather than "missing".
    func problems(comparedTo previous: SetupOptions) -> [String] {
        var out: [String] = []
        if addressMode == .custom, !Self.isHostname(customHost.trimmingCharacters(in: .whitespaces)) {
            out.append("That is not a name — use something like waffled.home, with no http:// and no port.")
        }
        if Self.portNumber(port) == nil {
            out.append("A port is a number between \(Self.lowestPort) and 65535 — ports "
                + "below \(Self.lowestPort) need an administrator.")
        }
        if provider.needsKey, trimmedKey.isEmpty, provider != previous.provider {
            out.append("\(provider.label) needs an API key to turn on — or choose Not now.")
        }
        if provider == .ollama, !Self.isWebURL(ollamaHost) {
            out.append("Ollama's address is a URL, like \(Self.defaultOllamaHost).")
        }
        if provider == .openai, !trimmed(openAIBaseURL).isEmpty, !Self.isWebURL(openAIBaseURL) {
            out.append("The server address is a URL, like https://api.openai.com/v1.")
        }
        for setting in SettingsCatalog.all {
            if let problem = setting.problem(settings[setting.key] ?? "") { out.append(problem) }
        }
        return out
    }

    /// Below this a port needs root. `ports.IsFree` answers by BINDING, so an
    /// unprivileged Waffled finds every one of them taken and reports "no free port" —
    /// a dead end, reached long after the screen where a person could have typed another.
    static let lowestPort = 1024

    static func portNumber(_ raw: String) -> Int? {
        guard let n = Int(raw.trimmingCharacters(in: .whitespaces)),
              (lowestPort...65535).contains(n) else {
            return nil
        }
        return n
    }

    /// The same shape the runtime insists on: letters, digits, dashes and dots only. A
    /// paste carries a scheme, a port or a path, and each would compose an address no
    /// device could reach with nothing anywhere to say so.
    static func isHostname(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 253, !s.hasPrefix("."), !s.hasSuffix("."),
              !s.contains("..") else { return false }
        return s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == ".") }
    }

    /// An http(s) URL with a host — what every address field here is handed to the api as.
    static func isWebURL(_ raw: String) -> Bool {
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard !s.contains(where: \.isWhitespace), let url = URL(string: s),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return false }
        return true
    }

    // MARK: what the runtime is asked to do

    /// The value `WAFFLED_PUBLIC_HOST` takes.
    var publicHost: String {
        switch addressMode {
        case .name: return "name"
        case .ip: return "ip"
        case .custom: return customHost.trimmingCharacters(in: .whitespaces)
        }
    }

    private var trimmedKey: String { providerKey.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }

    /// Every runtime invocation this screen owes, in the order they are made — all of
    /// them before the first `start`, so nothing has to be applied twice.
    ///
    /// A backup toggle that is off installs nothing rather than uninstalling something:
    /// this runs once, on a Mac where there is nothing of ours to remove.
    ///
    /// - Parameter isDevMode: a run against a runtime this app did not ship with. It
    ///   writes config into its own scratch data directory happily, but it installs no
    ///   nightly backup: launchd's label is global, so one Mac holds exactly one, and a
    ///   dev run would take the household's real schedule over and point it at /tmp.
    func commandsBeforeFirstStart(isDevMode: Bool = false) -> [RuntimeCommand] {
        guard problems.isEmpty else { return [] }
        // The address is always written: the default is a choice too, and the runtime reads an ABSENT setting as "keep the address this install
        // has always had" — which is right for an upgrade and wrong for a first run.
        var out: [RuntimeCommand] = [.configSet("WAFFLED_PUBLIC_HOST", publicHost)]
        // The port is not. An assignment nobody asked for is a preference on record that a
        // household never expressed, and the port they end up on is the same either way.
        if let chosen = Self.portNumber(port), chosen != Self.defaultPort {
            out.append(.configSet("HTTP_PORT", String(chosen)))
        }
        out += credentialCommands(from: SetupOptions())
        out += settingCommands(from: SetupOptions())
        if backupEnabled, !isDevMode {
            out.append(install(keep: backupKeep == Self.defaultBackupKeep ? nil : backupKeep))
        }
        return out
    }

    /// What `Settings…` owes the runtime: only what actually changed.
    ///
    /// The difference rather than the whole screen, because writing every setting on every
    /// Apply puts preferences on record that nobody expressed — which is exactly how
    /// `HTTP_PORT` came to move a published port. The port is not here at all for the same
    /// reason: it is the preference for the FIRST allocation and nothing after it, so a
    /// value written now would be a setting that silently did nothing.
    ///
    /// The data folder is not here either. That one is `waffled-runtime move`, which needs
    /// the server stopped, so it is its own button rather than part of Apply.
    ///
    /// - Parameter isDevMode: as on the first run, a dev run leaves the nightly backup
    ///   alone in BOTH directions — launchd's label is global, so uninstalling from here
    ///   would take the household's real schedule away.
    func commandsForChange(from previous: SetupOptions, isDevMode: Bool = false) -> [RuntimeCommand] {
        guard problems(comparedTo: previous).isEmpty else { return [] }
        var out: [RuntimeCommand] = []

        if publicHost != previous.publicHost {
            out.append(.configSet("WAFFLED_PUBLIC_HOST", publicHost))
        }
        out += credentialCommands(from: previous)
        out += settingCommands(from: previous)
        if !isDevMode {
            if backupEnabled, !previous.backupEnabled {
                // The plist went with the uninstall, so a retention that is not the
                // default has to be said again or it quietly becomes 14.
                out.append(install(keep: backupKeep == Self.defaultBackupKeep ? nil : backupKeep))
            } else if backupEnabled, backupAt != previous.backupAt || backupKeep != previous.backupKeep {
                // Omitting --keep keeps the installed one, so it is stated only when it
                // is the thing that changed — including a change back to 14.
                out.append(install(keep: backupKeep != previous.backupKeep ? backupKeep : nil))
            } else if !backupEnabled, previous.backupEnabled {
                out.append(RuntimeCommand(subcommand: "backup", flags: ["--uninstall-schedule"]))
            }
        }
        return out
    }

    private func install(keep: Int?) -> RuntimeCommand {
        var flags = ["--install-schedule", "--at", backupAt]
        if let keep { flags += ["--keep", String(keep)] }
        return RuntimeCommand(subcommand: "backup", flags: flags)
    }

    /// The provider's credential, when it changed.
    ///
    /// An empty key field means "I did not change it", never "delete my key": the key is
    /// never read back out of config.env, so the field starts empty every time Settings
    /// opens, and treating that as a deletion would turn the suggestions off for anyone
    /// who came to change the backup time. Choosing Not now is the deletion — a choice,
    /// not an empty field — and it clears every provider's, since the api offers each
    /// one whose credential is present.
    private func credentialCommands(from previous: SetupOptions) -> [RuntimeCommand] {
        switch provider {
        case .none:
            guard previous.provider != .none else { return [] }
            return Provider.credentialKeys.map { .configSet($0, "") }
        case .anthropic, .openai:
            var out: [RuntimeCommand] = []
            if let key = provider.configKey, !trimmedKey.isEmpty,
               trimmedKey != previous.providerKey || provider != previous.provider {
                out.append(.configSet(key, trimmedKey))
            }
            if provider == .openai, trimmed(openAIBaseURL) != trimmed(previous.openAIBaseURL) {
                out.append(.configSet("OPENAI_BASE_URL", trimmed(openAIBaseURL)))
            }
            return out
        case .ollama:
            guard trimmed(ollamaHost) != trimmed(previous.ollamaHost) || previous.provider != .ollama
            else { return [] }
            return [.configSet("OLLAMA_HOST", trimmed(ollamaHost))]
        }
    }

    /// The Advanced and Diagnostics fields that differ from what was applied, in catalog
    /// order. A cleared field is written empty, which the runtime forwards as nothing —
    /// the api's own default again.
    private func settingCommands(from previous: SetupOptions) -> [RuntimeCommand] {
        SettingsCatalog.all.compactMap { setting in
            if setting.kind == .secret {
                let value = trimmed(secrets[setting.key] ?? "")
                guard !value.isEmpty, value != previous.secrets[setting.key] else { return nil }
                return .configSet(setting.key, value)
            }
            let value = trimmed(settings[setting.key] ?? "")
            guard value != trimmed(previous.settings[setting.key] ?? "") else { return nil }
            return .configSet(setting.key, setting.written(value))
        }
    }
}

extension SetupOptions {
    /// Every field optional, so preferences written before a field existed still come back
    /// whole. A decoder that demanded every key would read them as the defaults, and
    /// Settings would show 03:00 beside a nightly backup that runs at 01:00.
    init(from decoder: Decoder) throws {
        self.init()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        backupEnabled = try c.decodeIfPresent(Bool.self, forKey: .backupEnabled) ?? backupEnabled
        backupAt = try c.decodeIfPresent(String.self, forKey: .backupAt) ?? backupAt
        backupKeep = try c.decodeIfPresent(Int.self, forKey: .backupKeep) ?? backupKeep
        provider = try c.decodeIfPresent(Provider.self, forKey: .provider) ?? provider
        openAIBaseURL = try c.decodeIfPresent(String.self, forKey: .openAIBaseURL) ?? openAIBaseURL
        ollamaHost = try c.decodeIfPresent(String.self, forKey: .ollamaHost) ?? ollamaHost
        startAtLogin = try c.decodeIfPresent(Bool.self, forKey: .startAtLogin) ?? startAtLogin
        addressMode = try c.decodeIfPresent(AddressMode.self, forKey: .addressMode) ?? addressMode
        customHost = try c.decodeIfPresent(String.self, forKey: .customHost) ?? customHost
        port = try c.decodeIfPresent(String.self, forKey: .port) ?? port
        settings = try c.decodeIfPresent([String: String].self, forKey: .settings) ?? settings
    }
}

/// One `waffled-runtime` invocation, split where the runtime's own parser splits it.
///
/// `flags` come straight after the subcommand and `trailing` after `--bundle`/`--data`,
/// because Go's flag package stops at the first non-flag argument: an assignment written
/// before `--data` would send the write to the household's real config.env.
struct RuntimeCommand: Equatable {
    var subcommand: String
    var flags: [String] = []
    var trailing: [String] = []

    static func configSet(_ key: String, _ value: String) -> RuntimeCommand {
        RuntimeCommand(subcommand: "config", flags: ["set"], trailing: ["\(key)=\(value)"])
    }

    /// Moving the data directory. The destination is a flag rather than a trailing word
    /// because the runtime's own parser reads it as one, and `--data` still names the
    /// folder being moved FROM — the app rebuilds its client on the new one afterwards.
    static func move(to destination: URL) -> RuntimeCommand {
        RuntimeCommand(subcommand: "move", flags: ["--to", destination.path])
    }

    /// A write to config.env — every one of which the running api only reads at start.
    var writesConfig: Bool { subcommand == "config" }
}
