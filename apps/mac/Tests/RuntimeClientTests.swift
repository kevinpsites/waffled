import XCTest
@testable import Waffled

/// A runner that records what it was asked to run and answers from a script, so the tests
/// never spawn a process — and the argv the app would really have used is asserted, which
/// is the part that silently breaks dev mode.
final class RecordingRunner: RuntimeProcessRunning, @unchecked Sendable {
    struct Call: Equatable {
        let executable: String
        let arguments: [String]
    }

    private(set) var calls: [Call] = []
    var result: RuntimeProcessResult
    var thrownError: Error?
    /// Subcommands that exit 1 with this sentence, the way the runtime refuses.
    var refusing: [String: String] = [:]

    init(result: RuntimeProcessResult = .init(exitCode: 0, standardOutput: Data(), standardError: "")) {
        self.result = result
    }

    func run(executable: URL, arguments: [String]) async throws -> RuntimeProcessResult {
        calls.append(Call(executable: executable.path, arguments: arguments))
        if let thrownError { throw thrownError }
        if let refusal = refusing[arguments.first ?? ""] {
            return .init(exitCode: 1, standardOutput: Data(), standardError: refusal)
        }
        return result
    }
}

final class RuntimeClientTests: XCTestCase {
    private let binary = URL(fileURLWithPath: "/tmp/bin/waffled-runtime")

    private func client(bundle: String?, data: String?, runner: RecordingRunner) -> RuntimeClient {
        RuntimeClient(
            location: RuntimeLocation(
                binary: binary,
                bundleDir: bundle.map { URL(fileURLWithPath: $0) },
                dataDir: data.map { URL(fileURLWithPath: $0) },
                isDevMode: true),
            runner: runner)
    }

    func testStatusPassesBothDevModeDirectories() async throws {
        let runner = RecordingRunner(result: .init(
            exitCode: 0, standardOutput: Fixtures.data(Fixtures.fullRunning), standardError: ""))
        let c = client(bundle: "/tmp/runtime", data: "/tmp/data", runner: runner)

        let status = try await c.status()

        XCTAssertEqual(status.state, .running)
        XCTAssertEqual(runner.calls, [.init(
            executable: "/tmp/bin/waffled-runtime",
            arguments: ["status", "--json", "--bundle", "/tmp/runtime", "--data", "/tmp/data"])])
    }

    /// `--data` is optional in dev mode; omitting it must leave the runtime free to use
    /// its own default rather than being handed an empty string.
    func testAnUnsetDataDirectoryIsOmittedEntirely() async throws {
        let runner = RecordingRunner(result: .init(
            exitCode: 0, standardOutput: Fixtures.data(Fixtures.minimalStopped), standardError: ""))
        let c = client(bundle: "/tmp/runtime", data: nil, runner: runner)

        _ = try await c.status()

        XCTAssertEqual(runner.calls.first?.arguments,
                       ["status", "--json", "--bundle", "/tmp/runtime"])
    }

    func testProductionPassesNeitherFlag() async throws {
        let runner = RecordingRunner(result: .init(
            exitCode: 0, standardOutput: Fixtures.data(Fixtures.minimalStopped), standardError: ""))
        let c = client(bundle: nil, data: nil, runner: runner)

        _ = try await c.status()

        XCTAssertEqual(runner.calls.first?.arguments, ["status", "--json"])
    }

    /// `start` without `--foreground` detaches and returns once the stack is green — the
    /// menu-bar app wants exactly that, and must never pass `--foreground`.
    func testStartStopAndBackupUseTheDocumentedSubcommands() async throws {
        let runner = RecordingRunner(result: .init(
            exitCode: 0,
            standardOutput: Data("/tmp/data/backups/waffled-20260908-030000.dump\n".utf8),
            standardError: ""))
        let c = client(bundle: "/tmp/runtime", data: "/tmp/data", runner: runner)

        try await c.start()
        try await c.stop()
        let dump = try await c.backup(keep: 30)

        XCTAssertEqual(runner.calls.map(\.arguments), [
            ["start", "--bundle", "/tmp/runtime", "--data", "/tmp/data"],
            ["stop", "--bundle", "/tmp/runtime", "--data", "/tmp/data"],
            ["backup", "--keep", "30", "--bundle", "/tmp/runtime", "--data", "/tmp/data"],
        ])
        XCTAssertEqual(dump, "/tmp/data/backups/waffled-20260908-030000.dump")
        XCTAssertFalse(runner.calls.contains { $0.arguments.contains("--foreground") })
    }

    /// The runtime prints its refusals to stderr with a leading "✗ ". That sentence is
    /// the most useful thing the app can put in the status line, so it becomes the error.
    func testANonZeroExitSurfacesTheRuntimesOwnStderr() async {
        let runner = RecordingRunner(result: .init(
            exitCode: 1, standardOutput: Data(),
            standardError: "✗ postgres refused to start: initdb failed\n"))
        let c = client(bundle: "/tmp/runtime", data: "/tmp/data", runner: runner)

        do {
            try await c.start()
            XCTFail("a non-zero exit must not read as success")
        } catch let error as RuntimeClientError {
            XCTAssertEqual(error, .commandFailed(
                command: "start", exitCode: 1,
                message: "postgres refused to start: initdb failed"))
            XCTAssertEqual(error.firstLine, "postgres refused to start: initdb failed")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    /// The first thing that goes wrong in dev mode is a WAFFLED_RUNTIME_BIN that does not
    /// point at a runnable binary, and "the server is stopped" would be a lie.
    func testAnUnrunnableBinaryIsItsOwnError() async {
        let runner = RecordingRunner()
        runner.thrownError = CocoaError(.fileNoSuchFile)
        let c = client(bundle: nil, data: nil, runner: runner)

        do {
            _ = try await c.status()
            XCTFail("a runtime we cannot run must not read as a status")
        } catch let error as RuntimeClientError {
            guard case .cannotRunRuntime = error else {
                return XCTFail("expected .cannotRunRuntime, got \(error)")
            }
            XCTAssertTrue(error.firstLine.contains("/tmp/bin/waffled-runtime"),
                          "the message must name the path that did not work")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    /// A zero exit whose stdout is not the document we expect is a bug in our reading of
    /// the contract, and must not be papered over as "stopped".
    func testUnparseableStatusOutputIsAnError() async {
        let runner = RecordingRunner(result: .init(
            exitCode: 0, standardOutput: Data("Waffled 0.14.3 — running\n".utf8), standardError: ""))
        let c = client(bundle: nil, data: nil, runner: runner)

        do {
            _ = try await c.status()
            XCTFail("the human rendering is not the JSON contract")
        } catch {
            // any error is fine; silently succeeding is not
        }
    }
}
