import Foundation

/// The words `state` can hold — the four documented in
/// `apps/runtime/internal/status` and reported by `waffled-runtime status --json`.
enum RuntimeState: String, Hashable {
    case stopped, starting, running, unhealthy

    /// The contract promises added *fields*, not a closed vocabulary here, so a word this
    /// build has never heard of has to mean something rather than throw. It means
    /// "something is going on that I cannot describe" — which is what `unhealthy` is for,
    /// and it draws the one icon that asks a person to look.
    init(contractValue: String) {
        self = RuntimeState(rawValue: contractValue) ?? .unhealthy
    }
}

/// One `status --json` document.
///
/// Decoding is written by hand rather than synthesised because the contract's central
/// promise — "fields are added, never renamed; `schema` is bumped only for a break" —
/// maps to exactly one rule: **default everything except `schema`**. Blocks the runtime
/// has not learned to write yet decode to their empty selves, so nothing downstream has
/// to unwrap an optional to ask about a port.
struct RuntimeStatus: Equatable {
    struct URLs: Equatable {
        var local = ""
        var lan = ""
        var powersync = ""
    }

    struct Ports: Equatable {
        var `public` = 0
        var powersyncPublic = 0
        var api = 0
        var powersync = 0
        var postgres = 0
    }

    struct Versions: Equatable {
        var waffled = ""
        var node = ""
        var postgres = ""
        var caddy = ""
        var powersync = ""
        var api = ""
        var web = ""
    }

    struct BundleInfo: Equatable {
        var gitSha = ""
        var builtAt = ""
        var arch = ""
        var platform = ""
        var verified = false
        var version = ""
        /// The last version crossing this data went through. Deliberately
        /// direction-neutral in the contract — a rollback is as ordinary as an update —
        /// so anything rendering it must compare the two versions rather than assume.
        var previousVersion = ""
        var versionChangedAt = ""
    }

    struct SupervisorInfo: Equatable {
        var pid = 0
        var running = false
    }

    struct Service: Equatable {
        var name = ""
        var state = RuntimeState.stopped
        var pid = 0
        var port = 0
        var health = ""
        var restarts = 0
        var lastError = ""
        var log = ""
    }

    struct Backups: Equatable {
        var dir = ""
        var lastBackupAt = ""
        var lastPath = ""
        var lastSizeBytes: Int64 = 0
        var lastMigration = ""
        var count = 0
        var lastError = ""
        var lastErrorAt = ""
        var scheduleInstalled = false
    }

    struct Bonjour: Equatable {
        var advertised = false
        var name = ""
        var service = ""
        var port = 0
        var host = ""
        var error = ""
    }

    var schema = 0
    var state = RuntimeState.stopped
    /// Whether this data directory has ever been set up; false is a first run, and the
    /// only launch that shows a window.
    ///
    /// It defaults false like everything else here, which means a runtime too old to
    /// report it reads as a first run. That is safe because the app and the runtime ship
    /// as one unit (plan §6): the only way to see the older half is dev mode, and the
    /// worst outcome there is a welcome screen whose button starts the server anyway.
    var initialized = false
    var dataDir = ""
    var bundleDir = ""
    var urls = URLs()
    var ports = Ports()
    var versions = Versions()
    var bundle = BundleInfo()
    var supervisor = SupervisorInfo()
    var services: [Service] = []
    var backups = Backups()
    var bonjour = Bonjour()
    var lastError = ""
    var generatedAt = ""

    /// The schema this build understands. Anything else is refused rather than guessed at.
    static let supportedSchema = 1

    static func decode(_ data: Data) throws -> RuntimeStatus {
        let root = try JSONSerialization.jsonObject(with: data)
        guard let object = root as? [String: Any] else {
            throw RuntimeStatusError.malformed("the document is not a JSON object")
        }
        // `schema` is the one field with no sensible default: without it there is nothing
        // to check compatibility against, so there is no basis for reading the rest.
        guard let schema = object["schema"] as? Int else {
            throw RuntimeStatusError.malformed("the document has no `schema`")
        }
        guard schema == supportedSchema else {
            throw RuntimeStatusError.unsupportedSchema(schema)
        }

        var s = RuntimeStatus()
        s.schema = schema
        s.state = RuntimeState(contractValue: object.string("state"))
        s.initialized = object.bool("initialized")
        s.dataDir = object.string("dataDir")
        s.bundleDir = object.string("bundleDir")
        s.lastError = object.string("lastError")
        s.generatedAt = object.string("generatedAt")

        let urls = object.object("urls")
        s.urls = URLs(local: urls.string("local"),
                      lan: urls.string("lan"),
                      powersync: urls.string("powersync"))

        let ports = object.object("ports")
        s.ports = Ports(public: ports.int("public"),
                        powersyncPublic: ports.int("powersyncPublic"),
                        api: ports.int("api"),
                        powersync: ports.int("powersync"),
                        postgres: ports.int("postgres"))

        let versions = object.object("versions")
        s.versions = Versions(waffled: versions.string("waffled"),
                              node: versions.string("node"),
                              postgres: versions.string("postgres"),
                              caddy: versions.string("caddy"),
                              powersync: versions.string("powersync"),
                              api: versions.string("api"),
                              web: versions.string("web"))

        let bundle = object.object("bundle")
        s.bundle = BundleInfo(gitSha: bundle.string("gitSha"),
                              builtAt: bundle.string("builtAt"),
                              arch: bundle.string("arch"),
                              platform: bundle.string("platform"),
                              verified: bundle.bool("verified"),
                              version: bundle.string("version"),
                              previousVersion: bundle.string("previousVersion"),
                              versionChangedAt: bundle.string("versionChangedAt"))

        let supervisor = object.object("supervisor")
        s.supervisor = SupervisorInfo(pid: supervisor.int("pid"),
                                      running: supervisor.bool("running"))

        s.services = (object["services"] as? [[String: Any]] ?? []).map { raw in
            Service(name: raw.string("name"),
                    state: RuntimeState(contractValue: raw.string("state")),
                    pid: raw.int("pid"),
                    port: raw.int("port"),
                    health: raw.string("health"),
                    restarts: raw.int("restarts"),
                    lastError: raw.string("lastError"),
                    log: raw.string("log"))
        }

        let backups = object.object("backups")
        s.backups = Backups(dir: backups.string("dir"),
                            lastBackupAt: backups.string("lastBackupAt"),
                            lastPath: backups.string("lastPath"),
                            lastSizeBytes: Int64(backups.int("lastSizeBytes")),
                            lastMigration: backups.string("lastMigration"),
                            count: backups.int("count"),
                            lastError: backups.string("lastError"),
                            lastErrorAt: backups.string("lastErrorAt"),
                            scheduleInstalled: backups.bool("scheduleInstalled"))

        let bonjour = object.object("bonjour")
        s.bonjour = Bonjour(advertised: bonjour.bool("advertised"),
                            name: bonjour.string("name"),
                            service: bonjour.string("service"),
                            port: bonjour.int("port"),
                            host: bonjour.string("host"),
                            error: bonjour.string("error"))

        return s
    }

    /// The `host:port` to hand a phone or the kiosk tablet — what the §2 mock-up copies.
    ///
    /// `urls.lan` first because it is the address that certainly works: the runtime built
    /// it from an interface it can see. The Bonjour host is second because it is nicer to
    /// read and to type but depends on multicast DNS reaching the other device. When the
    /// advertisement is stale its own port can be 0, so the public port stands in — it is
    /// the same port either way, and the only one another device should reach.
    var serverAddress: String? {
        if !urls.lan.isEmpty {
            if let stripped = Self.hostAndPort(fromURL: urls.lan) { return stripped }
        }
        guard !bonjour.host.isEmpty else { return nil }
        let port = bonjour.port > 0 ? bonjour.port : ports.public
        guard port > 0 else { return nil }
        return "\(bonjour.host):\(port)"
    }

    private static func hostAndPort(fromURL raw: String) -> String? {
        guard let components = URLComponents(string: raw), let host = components.host else {
            return nil
        }
        guard let port = components.port else { return host }
        return "\(host):\(port)"
    }
}

enum RuntimeStatusError: Error, Equatable {
    /// A break we were told about. Refusing is the whole reason `schema` exists.
    case unsupportedSchema(Int)
    /// Not the document at all — the human rendering, a truncated pipe, someone else's
    /// binary on `WAFFLED_RUNTIME_BIN`.
    case malformed(String)
}

// MARK: - Reading a field without letting a wrong type become a decoding failure

/// A runtime that wrote `"port": "8080"` would be a bug in the runtime, but it must not
/// take the menu down with it: every accessor falls back to the zero value.
private extension [String: Any] {
    func string(_ key: String) -> String { self[key] as? String ?? "" }
    func bool(_ key: String) -> Bool { self[key] as? Bool ?? false }
    func object(_ key: String) -> [String: Any] { self[key] as? [String: Any] ?? [:] }

    func int(_ key: String) -> Int {
        if let i = self[key] as? Int { return i }
        if let n = self[key] as? NSNumber { return n.intValue }
        return 0
    }
}
