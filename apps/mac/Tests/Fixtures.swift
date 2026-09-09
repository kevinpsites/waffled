import Foundation
@testable import Waffled

/// Fixture documents for the `status --json` contract (apps/runtime/README.md, section
/// "`status --json`"). They are string literals rather than bundle resources so a test
/// reads the document it is asserting about without a detour through the test bundle.
enum Fixtures {
    /// The README's worked example, including the additive `backups` and `bonjour` blocks.
    static let fullRunning = """
    {
      "schema": 1,
      "state": "running",
      "dataDir": "/Users/jerry/Library/Application Support/Waffled",
      "bundleDir": "/Applications/Waffled.app/Contents/Resources/runtime",
      "initialized": true,
      "urls":     { "local": "http://127.0.0.1:8080", "lan": "http://192.168.1.5:8080",
                    "powersync": "http://192.168.1.5:8081" },
      "ports":    { "public": 8080, "powersyncPublic": 8081, "api": 3000,
                    "powersync": 8082, "postgres": 5432 },
      "versions": { "waffled": "0.14.3", "node": "24.19.0", "postgres": "16.14",
                    "caddy": "2.11.4", "powersync": "1.22.0", "api": "0.14.3", "web": "0.14.3" },
      "bundle":   { "gitSha": "a506c352", "builtAt": "2026-09-04T23:48:42.438Z",
                    "arch": "arm64", "platform": "darwin", "verified": true,
                    "version": "0.14.3", "previousVersion": "0.14.2",
                    "versionChangedAt": "2026-09-08T03:00:00Z" },
      "supervisor": { "pid": 4242, "running": true },
      "services": [
        { "name": "postgres", "state": "running", "pid": 101, "port": 5432,
          "health": "ok", "restarts": 0, "lastError": "", "log": "/tmp/logs/postgres.log" },
        { "name": "api", "state": "running", "pid": 102, "port": 3000,
          "health": "ok", "restarts": 0, "lastError": "", "log": "/tmp/logs/api.log" }
      ],
      "backups": {
        "dir": "/Users/jerry/Library/Application Support/Waffled/backups",
        "lastBackupAt": "2026-09-08T03:00:00Z",
        "lastPath": "/Users/jerry/Library/Application Support/Waffled/backups/waffled-20260908-030000.dump",
        "lastSizeBytes": 4823104,
        "lastMigration": "0099_rhythm_book_within",
        "count": 14,
        "lastError": "", "lastErrorAt": "",
        "scheduleInstalled": true
      },
      "bonjour": {
        "advertised": true,
        "name": "The Seinfelds",
        "service": "_waffled._tcp",
        "port": 8080,
        "host": "kevins-mac-mini.local",
        "error": ""
      },
      "lastError": "",
      "generatedAt": "2026-09-08T16:20:00Z"
    }
    """

    /// A future runtime: an unknown top-level key and an unknown field inside a service.
    /// The contract says fields are added without bumping `schema`, so this must decode.
    static let withUnknownFields = """
    {
      "schema": 1,
      "state": "starting",
      "dataDir": "/tmp/waffled",
      "bundleDir": "/tmp/bundle",
      "telemetry": { "enabled": false, "endpoint": "https://example.invalid" },
      "urls": { "local": "http://127.0.0.1:8090", "lan": "", "powersync": "" },
      "ports": { "public": 8090, "powersyncPublic": 8091, "api": 3000,
                 "powersync": 8082, "postgres": 5432 },
      "services": [
        { "name": "postgres", "state": "running", "pid": 101, "port": 5432,
          "health": "ok", "restarts": 0, "lastError": "", "log": "/tmp/logs/postgres.log",
          "cgroup": "waffled.postgres", "startedAt": "2026-09-08T16:19:00Z" }
      ],
      "lastError": "",
      "generatedAt": "2026-09-08T16:20:00Z"
    }
    """

    /// A breaking change we must refuse rather than guess at.
    static let schemaTwo = """
    { "schema": 2, "state": "running", "urls": { "local": "http://127.0.0.1:8080" } }
    """

    /// Everything optional omitted: only the two fields the app genuinely needs.
    static let minimalStopped = """
    { "schema": 1, "state": "stopped" }
    """

    /// A state word this build has never heard of.
    static let unknownState = """
    { "schema": 1, "state": "quiescing" }
    """

    /// No LAN URL, but Bonjour knows the host — the Mac-mini-on-the-shelf case.
    static let bonjourOnly = """
    {
      "schema": 1, "state": "running",
      "urls": { "local": "http://127.0.0.1:8090", "lan": "", "powersync": "" },
      "ports": { "public": 8090, "powersyncPublic": 8091, "api": 3000,
                 "powersync": 8082, "postgres": 5432 },
      "bonjour": { "advertised": true, "name": "The Seinfelds", "service": "_waffled._tcp",
                   "port": 0, "host": "kevins-mac-mini.local", "error": "" }
    }
    """

    /// Running, but nothing reachable from another device: no LAN URL, no advertisement.
    static let noAddress = """
    {
      "schema": 1, "state": "running",
      "urls": { "local": "http://127.0.0.1:8090", "lan": "", "powersync": "" },
      "ports": { "public": 8090, "powersyncPublic": 0, "api": 0,
                 "powersync": 0, "postgres": 0 },
      "bonjour": { "advertised": false, "name": "", "service": "_waffled._tcp",
                   "port": 0, "host": "", "error": "dns-sd is not available" }
    }
    """

    /// A service fell over while the others kept running.
    static let unhealthy = """
    {
      "schema": 1, "state": "unhealthy",
      "urls": { "local": "http://127.0.0.1:8090", "lan": "http://192.168.1.5:8090",
                "powersync": "" },
      "ports": { "public": 8090, "powersyncPublic": 8091, "api": 3000,
                 "powersync": 8082, "postgres": 5432 },
      "services": [
        { "name": "postgres", "state": "running", "pid": 101, "port": 5432,
          "health": "ok", "restarts": 0, "lastError": "", "log": "/tmp/logs/postgres.log" },
        { "name": "api", "state": "unhealthy", "pid": 0, "port": 3000,
          "health": "fail", "restarts": 3, "lastError": "exited with status 1",
          "log": "/tmp/logs/api.log" }
      ],
      "lastError": "api exited with status 1\\nsee logs/api.log",
      "generatedAt": "2026-09-08T16:20:00Z"
    }
    """

    /// A data directory nobody has set up yet: every service down, and `initialized`
    /// false — the one document that puts the first-run window on screen.
    static let freshDataDirectory = """
    {
      "schema": 1, "state": "stopped", "initialized": false,
      "dataDir": "/tmp/waffled-fresh", "bundleDir": "/tmp/bundle",
      "urls": { "local": "", "lan": "", "powersync": "" },
      "services": [
        { "name": "postgres", "state": "stopped", "pid": 0, "port": 5432, "log": "/tmp/logs/postgres.log" },
        { "name": "api", "state": "stopped", "pid": 0, "port": 3000, "log": "/tmp/logs/api.log" },
        { "name": "powersync", "state": "stopped", "pid": 0, "port": 8082, "log": "/tmp/logs/powersync.log" },
        { "name": "caddy", "state": "stopped", "pid": 0, "port": 8080, "log": "/tmp/logs/caddy.log" }
      ]
    }
    """

    /// Halfway up a first start: the cluster exists now, Postgres is green, the api is
    /// still coming up and the last two have not been reached.
    static let firstStartInProgress = """
    {
      "schema": 1, "state": "starting", "initialized": true,
      "dataDir": "/tmp/waffled-fresh", "bundleDir": "/tmp/bundle",
      "urls": { "local": "http://127.0.0.1:8080", "lan": "", "powersync": "" },
      "services": [
        { "name": "postgres", "state": "running", "pid": 101, "port": 5432, "health": "ok",
          "log": "/tmp/logs/postgres.log" },
        { "name": "api", "state": "starting", "pid": 102, "port": 3000, "log": "/tmp/logs/api.log" },
        { "name": "powersync", "state": "stopped", "pid": 0, "port": 8082, "log": "/tmp/logs/powersync.log" },
        { "name": "caddy", "state": "stopped", "pid": 0, "port": 8080, "log": "/tmp/logs/caddy.log" }
      ]
    }
    """

    static func data(_ json: String) -> Data { Data(json.utf8) }
}

/// A `waffled-runtime` that never spawns: it answers every subcommand from here, records
/// what it was asked for, and can hold one open until the test lets it return — which is
/// how a test gets to be *inside* an operation that has not finished yet.
///
/// An actor rather than a class with a lock: `RuntimeClient.run` is a nonisolated `async`
/// call, so it lands off the main actor while the test is still poking at this from on it.
actor FakeRuntime: RuntimeProcessRunning {
    /// What `status` answers with. Stopped, so nothing here looks like a running server
    /// unless a test says so.
    var statusDocument = Fixtures.minimalStopped

    private var commands: [String] = []
    private var held: Set<String> = []
    private var waiting: [String: CheckedContinuation<Void, Never>] = [:]

    /// What the next `status` answers with — a stack that came up while a test was holding
    /// something open, say.
    func answer(status document: String) { statusDocument = document }

    /// Make `command` wait inside `run` until `finish(_:)` is called.
    func hold(_ command: String) { held.insert(command) }

    func isWaiting(for command: String) -> Bool { waiting[command] != nil }

    func finish(_ command: String) { waiting.removeValue(forKey: command)?.resume() }

    func count(of command: String) -> Int { commands.filter { $0 == command }.count }

    func run(executable: URL, arguments: [String]) async throws -> RuntimeProcessResult {
        let command = arguments.first ?? ""
        commands.append(command)
        if held.contains(command) {
            await withCheckedContinuation { waiting[command] = $0 }
        }
        return RuntimeProcessResult(
            exitCode: 0,
            standardOutput: command == "status" ? Fixtures.data(statusDocument) : Data(),
            standardError: "")
    }
}

/// `UpdateMemory` as a dictionary. Every `ServerModel` a test builds gets one of these:
/// the real store is the app's own defaults domain, and a suite that wrote it would eat
/// the update note the household running the tests was owed.
final class InMemoryDefaults: UpdateMemory {
    private var values: [String: Any] = [:]

    func string(forKey key: String) -> String? { values[key] as? String }
    func set(_ value: Any?, forKey key: String) { values[key] = value }
}
