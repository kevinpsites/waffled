import XCTest
@testable import Waffled

/// The setup click, which is the one place this app changes a Mac rather than reading it:
/// it writes settings, registers a login item, and starts a server. The ORDER is the part
/// worth pinning — and none of it may be asserted by really registering anything, so the
/// login item's own closures are the seam.
@MainActor
final class BeginSetupTests: XCTestCase {

    /// Records what the login item was asked to do, and what the runtime had already been
    /// asked to do by the time it was asked.
    private final class Recorder {
        var registered: [Bool] = []
        var commandsBefore: [[String]] = []

        @MainActor func item(watching runner: RecordingRunner) -> LoginItem {
            LoginItem(
                status: { .notRegistered },
                register: { [self] in
                    commandsBefore.append(runner.calls.map { $0.arguments.first ?? "" })
                    registered.append(true)
                },
                unregister: { [self] in
                    commandsBefore.append(runner.calls.map { $0.arguments.first ?? "" })
                    registered.append(false)
                })
        }
    }

    /// `WAFFLED_RUNTIME_BIN` is what turns dev mode on; without it a resource URL gives an
    /// ordinary production location. `locate` does no existence check, so neither path
    /// needs a runtime to be there — nothing here ever runs one.
    private func makeModel(runner: RecordingRunner, loginItem: LoginItem,
                           devMode: Bool) -> ServerModel {
        ServerModel(
            environment: devMode ? [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"] : [:],
            resourceURL: devMode ? nil : URL(fileURLWithPath: "/nonexistent/Resources"),
            memory: InMemoryDefaults(), runner: runner, loginItem: loginItem)
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out waiting for \(what)")
    }

    /// launchd's label is global — one Mac holds exactly one nightly backup — and the
    /// login item would register whichever build is running to start the household's Mac
    /// at every boot. A dev run touches neither.
    func testADevRunRegistersNoLoginItemAndInstallsNoSchedule() async {
        let runner = RecordingRunner()
        let recorder = Recorder()
        let model = makeModel(runner: runner, loginItem: recorder.item(watching: runner),
                              devMode: true)
        defer { model.end() }

        model.setupOptions.startAtLogin = true
        model.beginSetup()
        await waitUntil("the setup click finishes") { !model.busy }

        XCTAssertTrue(recorder.registered.isEmpty,
                      "a dev run must not register the household's login item")
        XCTAssertFalse(runner.calls.contains { $0.arguments.contains("--install-schedule") },
                       "nor take over the one nightly backup this Mac can hold")
    }

    /// The login item goes on AFTER the config writes and before the start. A screen that
    /// could not be applied must not leave a login item pointing at a Waffled that was
    /// never set up — the one thing here that `Try again` would not redo.
    func testTheLoginItemIsRegisteredAfterTheConfigWrites() async {
        let runner = RecordingRunner()
        let recorder = Recorder()
        let model = makeModel(runner: runner, loginItem: recorder.item(watching: runner),
                              devMode: false)
        defer { model.end() }

        model.setupOptions.startAtLogin = true
        model.beginSetup()
        await waitUntil("the setup click finishes") { !model.busy }

        XCTAssertEqual(recorder.registered, [true], "exactly one registration")
        guard let before = recorder.commandsBefore.first else {
            return XCTFail("the login item was never touched")
        }
        XCTAssertTrue(before.contains("config"),
                      "the settings should already be written, got \(before)")
        XCTAssertFalse(before.contains("start"),
                       "the server must not be starting yet, got \(before)")
        XCTAssertTrue(runner.calls.contains { $0.arguments.first == "start" },
                      "and then the start really happens")
    }

    /// A `config set` that refuses stops the whole click rather than being started around.
    func testASettingThatCouldNotBeWrittenLeavesNoLoginItemAndNoStart() async {
        let runner = RecordingRunner()
        runner.thrownError = RuntimeClientError.cannotRunRuntime(path: "/nonexistent", reason: "no")
        let recorder = Recorder()
        let model = makeModel(runner: runner, loginItem: recorder.item(watching: runner),
                              devMode: false)
        defer { model.end() }

        model.setupOptions.startAtLogin = true
        model.beginSetup()
        await waitUntil("the setup click finishes") { !model.busy }

        XCTAssertTrue(recorder.registered.isEmpty,
                      "no login item for a Waffled that was never set up")
        XCTAssertFalse(runner.calls.contains { $0.arguments.first == "start" },
                       "and nothing was started around the refusal")
        XCTAssertNotNil(model.heldFailure, "the person is told why")
    }
}
