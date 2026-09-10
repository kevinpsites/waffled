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
    /// True when `WAFFLED_DATA_DIR` named the directory. The setup screen may not move a
    /// data directory the environment pinned: that is the dev-mode recipe, and a choice
    /// saved on a household's Mac must never redirect it.
    var dataDirIsFromEnvironment = false
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

    /// - Parameter chosenDataDirectory: a folder the household picked on the setup screen,
    ///   used only when the environment named none.
    static func locate(environment: [String: String], resourceURL: URL?,
                       chosenDataDirectory: URL? = nil) -> RuntimeLocation? {
        let fromEnvironment = environment[dataVariable].flatMap(directory)
        let dataDir = fromEnvironment ?? chosenDataDirectory
        let pinned = fromEnvironment != nil

        if let binary = environment[binaryVariable], !binary.isEmpty {
            return RuntimeLocation(
                binary: URL(fileURLWithPath: binary),
                bundleDir: environment[bundleVariable].flatMap(directory),
                dataDir: dataDir,
                dataDirIsFromEnvironment: pinned,
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
        return RuntimeLocation(binary: binary, bundleDir: bundleDir, dataDir: dataDir,
                               dataDirIsFromEnvironment: pinned, isDevMode: false)
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

/// A thin wrapper over the six subcommands this app needs. Everything the GUI does is
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

    /// One of the setup screen's writes — a `config set`, or the nightly schedule. They
    /// are values (`RuntimeCommand`) rather than methods so the argv the app would really
    /// have used is asserted without spawning anything, and so nothing that logs a
    /// failure can reach the value a `config set` carried.
    func apply(_ command: RuntimeCommand) async throws {
        _ = try await run(command.subcommand, extra: command.flags, trailing: command.trailing)
    }

    // MARK: -

    private func run(_ command: String, extra: [String] = [],
                     trailing: [String] = []) async throws -> RuntimeProcessResult {
        let result: RuntimeProcessResult
        do {
            result = try await runner.run(
                executable: location.binary,
                arguments: arguments(for: command, extra: extra, trailing: trailing))
        } catch {
            throw RuntimeClientError.cannotRunRuntime(
                path: location.binary.path,
                reason: (error as NSError).localizedDescription)
        }
        guard result.exitCode == 0 else {
            throw RuntimeClientError.commandFailed(
                command: command,
                exitCode: result.exitCode,
                message: Self.failureMessage(result.standardError))
        }
        return result
    }

    /// The subcommand, then its own flags, then the common ones, then any positional
    /// argument. Go's `flag` package stops parsing at the first non-flag argument, so the
    /// subcommand has to come first and `config set`'s assignment has to come last.
    func arguments(for command: String, extra: [String] = [], trailing: [String] = []) -> [String] {
        var argv = [command] + extra
        if let bundleDir = location.bundleDir {
            argv += ["--bundle", bundleDir.path]
        }
        if let dataDir = location.dataDir {
            argv += ["--data", dataDir.path]
        }
        return argv + trailing
    }

    /// What a failed command actually said, out of everything it wrote to stderr.
    ///
    /// The runtime narrates as it works and prints its refusal to the same stream, so the
    /// raw text opens with "bundle verified …" and buries the reason below. Taken whole,
    /// the error window and the menu both led with an INFO line.
    ///
    /// The refusal is marked with "✗ " and its detail follows underneath, so that mark is
    /// the cut. Without one — a panic, or a bundled tool's own stderr — the narration is
    /// dropped by shape instead. A stream that is nothing BUT narration is kept as it is:
    /// a blank window says even less than the wrong line.
    static func failureMessage(_ stderr: String) -> String {
        let lines = stderr
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }

        if let mark = lines.firstIndex(where: { $0.hasPrefix("\u{2717} ") }) {
            var kept = Array(lines[mark...])
            kept[0].removeFirst(2)
            return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let withoutNarration = lines.filter { !Self.isLogLine($0) }
        guard withoutNarration.contains(where: { !$0.isEmpty }) else {
            return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return withoutNarration.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The runtime's own log shape: `2026-09-10 09:33:11 info  …`. Matched rather than
    /// parsed — this only has to decide whether a line is narration.
    private static func isLogLine(_ line: String) -> Bool {
        let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
        guard parts.count >= 3 else { return false }
        return parts[0].count == 10 && parts[0].filter { $0 == "-" }.count == 2
            && parts[1].contains(":")
            && ["info", "warn", "error", "debug"].contains(String(parts[2]))
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
