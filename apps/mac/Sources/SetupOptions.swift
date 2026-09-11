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

    /// Which provider the optional smart suggestions use. The key goes into config.env
    /// under that provider's own variable, which is what the api already reads.
    enum Provider: String, CaseIterable, Equatable, Codable {
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

    /// What is written down between launches, so `Settings…` knows what it is comparing
    /// against. Two are deliberately absent: `providerKey`, because a secret belongs in
    /// owner-only config.env and not in the app's preferences file, and `dataDirectory`,
    /// which already has a key of its own and would only get a chance to disagree with it.
    private enum CodingKeys: String, CodingKey {
        case backupEnabled, backupAt, provider, startAtLogin, addressMode, customHost, port
    }

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
            out.append("A port is a number between \(Self.lowestPort) and 65535 — ports "
                + "below \(Self.lowestPort) need an administrator.")
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
        // The address is always written: `name` is a choice even when it is the default
        // one, and the runtime reads an ABSENT setting as "keep the address this install
        // has always had" — which is right for an upgrade and wrong for a first run.
        var out: [RuntimeCommand] = [.configSet("WAFFLED_PUBLIC_HOST", publicHost)]
        // The port is not. An assignment nobody asked for is a preference on record that a
        // household never expressed, and the port they end up on is the same either way.
        if let chosen = Self.portNumber(port), chosen != Self.defaultPort {
            out.append(.configSet("HTTP_PORT", String(chosen)))
        }
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
        guard problems.isEmpty else { return [] }
        var out: [RuntimeCommand] = []

        if publicHost != previous.publicHost {
            out.append(.configSet("WAFFLED_PUBLIC_HOST", publicHost))
        }
        // An empty field means "I did not change it", never "delete my key": the key is
        // never read back out of config.env, so the field starts empty every time this
        // screen opens, and treating that as a deletion would turn the suggestions off for
        // anyone who came to change the backup time.
        let key = providerKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty, key != previous.providerKey || provider != previous.provider {
            out.append(.configSet(provider.configKey, key))
        }
        if !isDevMode {
            if backupEnabled, !previous.backupEnabled || backupAt != previous.backupAt {
                out.append(RuntimeCommand(subcommand: "backup",
                                          flags: ["--install-schedule", "--at", backupAt]))
            } else if !backupEnabled, previous.backupEnabled {
                out.append(RuntimeCommand(subcommand: "backup", flags: ["--uninstall-schedule"]))
            }
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

    /// Moving the data directory. The destination is a flag rather than a trailing word
    /// because the runtime's own parser reads it as one, and `--data` still names the
    /// folder being moved FROM — the app rebuilds its client on the new one afterwards.
    static func move(to destination: URL) -> RuntimeCommand {
        RuntimeCommand(subcommand: "move", flags: ["--to", destination.path])
    }
}
