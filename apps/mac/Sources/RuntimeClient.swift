import Foundation

struct RuntimeProcessResult: Equatable {
    var exitCode: Int32
    var standardOutput: Data
    var standardError: String
}

/// Every runtime invocation goes through this one seam, so the tests assert the argv the
/// app would really have used without spawning anything.
protocol RuntimeProcessRunning: Sendable {
    func run(executable: URL, arguments: [String]) async throws -> RuntimeProcessResult
}

/// Where the runtime is, and which directories to hand it.
///
/// `bundleDir` and `dataDir` are optional because the runtime has good defaults for both
/// (the directory above the binary, and `~/Library/Application Support/Waffled`), and
/// passing an empty string is not the same as not passing the flag.
struct RuntimeLocation: Equatable {
    var binary: URL
    var bundleDir: URL?
    var dataDir: URL?
    /// True when the environment pointed us somewhere, which the menu says out loud —
    /// a dev run against a scratch data directory should never be mistaken for the
    /// household's real server.
    var isDevMode: Bool
}

enum RuntimeLocator {
    /// The environment overrides, documented in README.md. `WAFFLED_RUNTIME_BIN` and
    /// `WAFFLED_RUNTIME_BUNDLE` point the app at a runtime it did not ship with — that is
    /// dev mode, and it is how this app was useful before anything was embedded in it.
    ///
    /// `WAFFLED_DATA_DIR` is **not** one of those: it moves the data, not the code, and it
    /// applies to the embedded runtime too. That is what lets CI boot the assembled `.app`
    /// (and anyone try a build) without writing into the household's real data directory —
    /// a thing you want most for the runtime you actually shipped.
    static let binaryVariable = "WAFFLED_RUNTIME_BIN"
    static let bundleVariable = "WAFFLED_RUNTIME_BUNDLE"
    static let dataVariable = "WAFFLED_DATA_DIR"

    static func locate(environment: [String: String], resourceURL: URL?) -> RuntimeLocation? {
        let dataDir = environment[dataVariable].flatMap(directory)

        if let binary = environment[binaryVariable], !binary.isEmpty {
            return RuntimeLocation(
                binary: URL(fileURLWithPath: binary),
                bundleDir: environment[bundleVariable].flatMap(directory),
                dataDir: dataDir,
                isDevMode: true)
        }

        // Production: the runtime ships at
        // Waffled.app/Contents/Resources/runtime/bin/waffled-runtime. `--bundle` would
        // default to the directory above the binary anyway; passing it explicitly means
        // the app and the CLI agree even if that default ever moves.
        //
        // Deliberately no existence check: this is path arithmetic, which is why it can be
        // tested at all. A binary that is not there surfaces as `cannotRunRuntime` naming
        // the full path — a far better answer than a nil that has to be explained.
        guard let resourceURL else { return nil }
        let bundleDir = resourceURL.appendingPathComponent("runtime")
        let binary = bundleDir.appendingPathComponent("bin/waffled-runtime")
        return RuntimeLocation(binary: binary, bundleDir: bundleDir, dataDir: dataDir, isDevMode: false)
    }

    private static func directory(_ path: String) -> URL? {
        path.isEmpty ? nil : URL(fileURLWithPath: path)
    }
}

enum RuntimeClientError: Error, Equatable {
    /// The runtime ran and refused. Its own sentence is the most useful thing we have.
    case commandFailed(command: String, exitCode: Int32, message: String)
    /// We could not run it at all — almost always a `WAFFLED_RUNTIME_BIN` typo. This is
    /// deliberately not reported as "the server is stopped", which would be a lie.
    case cannotRunRuntime(path: String, reason: String)
    /// It exited 0 and said something that is not the contract.
    case unreadableStatus(String)

    /// What the status line shows. One line, because the menu has one line.
    var firstLine: String {
        switch self {
        case let .commandFailed(_, exitCode, message):
            return message.firstLine ?? "the runtime exited with status \(exitCode)"
        case let .cannotRunRuntime(path, reason):
            return "cannot run \(path): \(reason)"
        case let .unreadableStatus(detail):
            return "cannot read the runtime's status: \(detail)"
        }
    }
}

/// A thin wrapper over the four subcommands the menu needs. Everything the GUI does is
/// available in Terminal, by construction — this type does not know how to do anything
/// the CLI cannot.
struct RuntimeClient {
    var location: RuntimeLocation
    var runner: RuntimeProcessRunning

    func status() async throws -> RuntimeStatus {
        let result = try await run("status", extra: ["--json"])
        do {
            return try RuntimeStatus.decode(result.standardOutput)
        } catch {
            throw RuntimeClientError.unreadableStatus(String(describing: error))
        }
    }

    /// Plain `start`, never `--foreground`: it re-execs itself in a new session and
    /// returns once the public port answers, which is exactly the "green or tell me why"
    /// the menu wants. It can take minutes on a fresh data directory (initdb, then
    /// migrations), so nothing here imposes a timeout of its own.
    func start() async throws {
        _ = try await run("start")
    }

    /// Synchronous by contract: when it returns, the stack is down.
    func stop() async throws {
        _ = try await run("stop")
    }

    /// Prints the dump path on stdout. Works while the server is stopped — `backup`
    /// starts Postgres for itself and puts it back — which is when the question is asked.
    @discardableResult
    func backup() async throws -> String {
        let result = try await run("backup")
        let out = String(decoding: result.standardOutput, as: UTF8.self)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: -

    private func run(_ command: String, extra: [String] = []) async throws -> RuntimeProcessResult {
        let result: RuntimeProcessResult
        do {
            result = try await runner.run(
                executable: location.binary,
                arguments: arguments(for: command, extra: extra))
        } catch {
            throw RuntimeClientError.cannotRunRuntime(
                path: location.binary.path,
                reason: (error as NSError).localizedDescription)
        }
        guard result.exitCode == 0 else {
            throw RuntimeClientError.commandFailed(
                command: command,
                exitCode: result.exitCode,
                message: Self.cleaned(result.standardError))
        }
        return result
    }

    /// The subcommand, then its own flags, then the common ones. Go's `flag` package stops
    /// parsing at the first non-flag argument, so the subcommand has to come first.
    func arguments(for command: String, extra: [String] = []) -> [String] {
        var argv = [command] + extra
        if let bundleDir = location.bundleDir {
            argv += ["--bundle", bundleDir.path]
        }
        if let dataDir = location.dataDir {
            argv += ["--data", dataDir.path]
        }
        return argv
    }

    /// The runtime prefixes its refusals with "✗ ". That mark is for a terminal; in a
    /// menu it is noise in front of the sentence someone needs to read.
    private static func cleaned(_ stderr: String) -> String {
        stderr
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                var line = String(line)
                if line.hasPrefix("✗ ") { line.removeFirst(2) }
                return line.trimmingCharacters(in: .whitespaces)
            }
            .joined(separator: "\n")
    }
}

/// The real runner. Kept apart from `RuntimeClient` so nothing in the tests can reach a
/// `Process` by accident.
struct SubprocessRunner: RuntimeProcessRunning {
    func run(executable: URL, arguments: [String]) async throws -> RuntimeProcessResult {
        try await withCheckedThrowingContinuation { continuation in
            // Off the main thread: `start` blocks for as long as a first initdb and a
            // migration take, and the menu bar must stay alive throughout.
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = executable
                process.arguments = arguments
                let out = Pipe()
                let err = Pipe()
                process.standardOutput = out
                process.standardError = err
                do {
                    try process.run()
                } catch {
                    return continuation.resume(throwing: error)
                }
                // Read before waiting: a child that fills a 64 KB pipe buffer while we
                // wait for it to exit deadlocks with us.
                let outData = out.fileHandleForReading.readDataToEndOfFile()
                let errData = err.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                continuation.resume(returning: RuntimeProcessResult(
                    exitCode: process.terminationStatus,
                    standardOutput: outData,
                    standardError: String(decoding: errData, as: UTF8.self)))
            }
        }
    }
}
