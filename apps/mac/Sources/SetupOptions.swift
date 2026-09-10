import Foundation

/// What the "Where things go" screen collects, and the runtime calls it owes.
///
/// It is a value for the same reason the menu and the window are: the argv the app would
/// really have used can be asserted without spawning anything, and every rule about what
/// a household may type lives in one place rather than in five controls.
///
/// Everything here is applied BEFORE the first `start`, so the first boot already uses
/// the folder, the port and the name that were chosen.
struct SetupOptions: Equatable {
    /// How other devices address this Mac. The two reserved words are the runtime's
    /// (`WAFFLED_PUBLIC_HOST`); `custom` carries a name the household set up themselves.
    enum AddressMode: String, CaseIterable, Equatable {
        case name, ip, custom
    }

    /// Which provider the optional smart suggestions use. The key goes into config.env
    /// under that provider's own variable, which is what the api already reads.
    enum Provider: String, CaseIterable, Equatable {
        case anthropic, openai

        var configKey: String {
            switch self {
            case .anthropic: return "ANTHROPIC_API_KEY"
            case .openai: return "OPENAI_API_KEY"
            }
        }

        var label: String {
            switch self {
            case .anthropic: return "Anthropic"
            case .openai: return "OpenAI"
            }
        }
    }

    /// nil means the default, `~/Library/Application Support/Waffled`.
    var dataDirectory: URL?
    var backupEnabled = true
    var backupAt = SetupOptions.defaultBackupAt
    var provider = Provider.anthropic
    var providerKey = ""
    var startAtLogin = true
    var addressMode = AddressMode.name
    var customHost = ""
    var port = String(SetupOptions.defaultPort)

    static let defaultBackupAt = "03:00"
    static let defaultPort = 8080
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

    // MARK: what a person may type

    /// The reasons this screen cannot be applied yet, in the words the rows show. Empty
    /// means "Set up Waffled" is a working button.
    var problems: [String] {
        var out: [String] = []
        if addressMode == .custom, !Self.isHostname(customHost.trimmingCharacters(in: .whitespaces)) {
            out.append("That is not a name — use something like waffled.home, with no http:// and no port.")
        }
        if Self.portNumber(port) == nil {
            out.append("A port is a number between 1 and 65535.")
        }
        return out
    }

    static func portNumber(_ raw: String) -> Int? {
        guard let n = Int(raw.trimmingCharacters(in: .whitespaces)), (1...65535).contains(n) else {
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

    // MARK: what the runtime is asked to do

    /// The value `WAFFLED_PUBLIC_HOST` takes.
    var publicHost: String {
        switch addressMode {
        case .name: return "name"
        case .ip: return "ip"
        case .custom: return customHost.trimmingCharacters(in: .whitespaces)
        }
    }

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
        var out: [RuntimeCommand] = [
            .configSet("WAFFLED_PUBLIC_HOST", publicHost),
            .configSet("HTTP_PORT", String(Self.portNumber(port) ?? Self.defaultPort)),
        ]
        let key = providerKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty {
            out.append(.configSet(provider.configKey, key))
        }
        if backupEnabled, !isDevMode {
            out.append(RuntimeCommand(subcommand: "backup",
                                      flags: ["--install-schedule", "--at", backupAt]))
        }
        return out
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

    /// What the menu may show about a command that failed, with no value in it: these
    /// carry provider keys.
    var describedForPeople: String {
        trailing.first.flatMap { $0.split(separator: "=").first.map(String.init) }
            ?? ([subcommand] + flags).joined(separator: " ")
    }
}
