import XCTest
@testable import Waffled

/// Settings' folder change behaves like every other setting on the screen: choosing a
/// folder stages it, and Apply does the work — the settings against the old folder first,
/// then stop, move, start — while the window says what is happening and what finished.
@MainActor
final class StagedMoveTests: XCTestCase {

    private var home: URL!

    override func setUpWithError() throws {
        home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("waffled-staged-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
        for file in ["runtime.json", "config.env"] {
            FileManager.default.createFile(atPath: current.appendingPathComponent(file).path, contents: Data("x".utf8))
        }
        addTeardownBlock { [home] in try? FileManager.default.removeItem(at: home!) }
    }

    private var current: URL { home.appendingPathComponent("Library/Application Support/Waffled") }
    private var destination: URL { home.appendingPathComponent("Documents/Waffled") }

    private func running(at folder: URL) throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning.replacingOccurrences(
            of: "/Users/jerry/Library/Application Support/Waffled", with: folder.path)))
    }

    /// Settings open over a server that is running from `current` — or stopped there.
    private func settingsModel(runner: RuntimeProcessRunning, stopped: Bool = false) throws -> ServerModel {
        let memory = InMemoryDefaults()
        memory.set(current.path, forKey: Setup.dataDirectoryKey)
        let model = ServerModel(environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"],
                                resourceURL: nil, memory: memory, runner: runner,
                                defaultDataDirectory: current)
        var status = try running(at: current)
        if stopped { status.state = .stopped }
        model.pretendFirstRunForTesting(status)
        model.dismissFirstRunWindow()
        model.openSettings()
        return model
    }

    private func screen(_ model: ServerModel) throws -> SettingsPresentation {
        guard case let .settings(screen) = model.windowPresentation else {
            throw XCTSkip("Settings does not own the window")
        }
        return screen
    }

    private func waitUntil(_ what: String, _ condition: () async -> Bool) async {
        for _ in 0..<300 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out waiting for \(what)")
    }

    // MARK: staging

    func testChoosingAFolderIsSomethingToApply() throws {
        let runner = RecordingRunner()
        let model = try settingsModel(runner: runner)
        defer { model.end() }

        XCTAssertNil(model.stageMove(to: destination))
        XCTAssertTrue(runner.calls.isEmpty, "nothing runs until Apply")
        let staged = try screen(model)
        XCTAssertTrue(staged.applyEnabled)
        XCTAssertEqual(staged.primaryAction, .apply)
        XCTAssertEqual(staged.pendingMovePath, destination.path)
        XCTAssertTrue(staged.moveNote?.contains(destination.path) == true)
        XCTAssertTrue(staged.moveNote?.contains("restarts") == true, "a running server will be restarted")
    }

    func testKeepingItWhereItIsDropsTheStagedMove() throws {
        let model = try settingsModel(runner: RecordingRunner())
        defer { model.end() }

        _ = model.stageMove(to: destination)
        model.keepFolderWhereItIs()
        XCTAssertNil(model.pendingMove)
        XCTAssertFalse(try screen(model).applyEnabled)
        XCTAssertNil(try screen(model).moveNote)
    }

    // MARK: Apply

    /// config.env is written in the folder that is about to move, so it travels with it;
    /// the start that follows the move is the restart those settings were waiting for.
    func testApplyWritesSettingsToTheOldFolderThenMovesThenStarts() async throws {
        let runner = RecordingRunner()
        let model = try settingsModel(runner: runner)
        defer { model.end() }

        model.setupOptions.settings["LOG_LEVEL"] = "debug"
        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("Apply finishes") { !model.busy }

        let commands = runner.calls.map { $0.arguments.first ?? "" }
        let config = try XCTUnwrap(commands.firstIndex(of: "config"))
        let stop = try XCTUnwrap(commands.firstIndex(of: "stop"))
        let move = try XCTUnwrap(commands.firstIndex(of: "move"))
        let start = try XCTUnwrap(commands.lastIndex(of: "start"))
        XCTAssertTrue(config < stop && stop < move && move < start, "order was \(commands)")
        XCTAssertEqual(data(runner.calls[config]), current.path)
        XCTAssertEqual(data(runner.calls[start]), destination.path)

        XCTAssertEqual(model.appliedOptions.settings["LOG_LEVEL"], "debug")
        XCTAssertNil(model.pendingMove)
        XCTAssertFalse(model.configAwaitingRestart, "the start after the move already read it")
        XCTAssertEqual(try screen(model).confirmation, "Moved, and Waffled restarted.")
    }

    /// A stopped server is moved as it is: nothing to stop first, and nothing started
    /// after — a person who stopped it did not ask for it back.
    func testAMoveWithTheServerStoppedNeitherStopsNorStartsIt() async throws {
        let runner = RecordingRunner()
        let model = try settingsModel(runner: runner, stopped: true)
        defer { model.end() }

        _ = model.stageMove(to: destination)
        XCTAssertFalse(try screen(model).moveNote?.contains("restarts") == true,
                       "nothing will be restarted")
        model.applySettings()
        await waitUntil("Apply finishes") { !model.busy }

        let commands = runner.calls.map { $0.arguments.first ?? "" }
        XCTAssertTrue(commands.contains("move"), "\(commands)")
        XCTAssertFalse(commands.contains("stop"), "\(commands)")
        XCTAssertFalse(commands.contains("start"), "\(commands)")
        XCTAssertEqual(model.dataDirectory.path, destination.path)
        XCTAssertEqual(try screen(model).confirmation, "Moved.")
    }

    /// The settings really were written, so they are remembered; the move is still wanted,
    /// so it stays staged for another Apply; and the server the move stopped comes back.
    func testAFailedMoveKeepsTheSettingsItWroteAndTheStagedMove() async throws {
        let runner = RecordingRunner()
        runner.refusing["move"] = "the destination already has something in it"
        let model = try settingsModel(runner: runner)
        defer { model.end() }

        model.setupOptions.settings["LOG_LEVEL"] = "debug"
        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("Apply finishes") { !model.busy }

        XCTAssertEqual(model.appliedOptions.settings["LOG_LEVEL"], "debug")
        XCTAssertEqual(model.pendingMove?.path, destination.path)
        let failed = try screen(model)
        XCTAssertTrue(failed.failure?.contains("already has something in it") == true,
                      "the window says why, not only the menu: \(String(describing: failed.failure))")
        XCTAssertTrue(failed.applyEnabled, "Apply stays live for another try")
        let commands = runner.calls.map { $0.arguments.first ?? "" }
        let move = try XCTUnwrap(commands.firstIndex(of: "move"))
        XCTAssertTrue(commands[move...].contains("start"), "the server the move stopped is started again: \(commands)")
    }

    /// The move worked, so it is confirmed — and what it warned about is said beside it,
    /// in the window, rather than dropped with the rest of a successful command's stderr.
    func testAMoveThatWorkedButWarnedSaysSoInTheWindow() async throws {
        let runner = RecordingRunner()
        runner.warning["move"] = """
            ! the nightly backup could not be pointed at \(destination.path): launchctl bootstrap: 5: Input/output error
              re-install it with: waffled-runtime backup --install-schedule --data "\(destination.path)"
            """
        let model = try settingsModel(runner: runner)
        defer { model.end() }

        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("Apply finishes") { !model.busy }

        let after = try screen(model)
        XCTAssertEqual(after.confirmation, "Moved, and Waffled restarted.")
        XCTAssertNil(after.failure, "the move worked")
        XCTAssertTrue(after.warning?.contains("nightly backup could not be pointed at") == true,
                      String(describing: after.warning))

        model.closeSettings()
        model.openSettings()
        XCTAssertNil(try screen(model).warning, "said once, for the move that caused it")
    }

    func testAMoveWithNothingToSayHasNoWarning() async throws {
        let model = try settingsModel(runner: RecordingRunner())
        defer { model.end() }

        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("Apply finishes") { !model.busy }
        XCTAssertNil(try screen(model).warning)
    }

    // MARK: what the window says

    func testTheMoveShowsWhileItRunsAndWhenItIsDone() async throws {
        let runtime = FakeRuntime()
        await runtime.hold("move")
        let model = try settingsModel(runner: runtime)
        defer { model.end() }

        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("the move is under way") { await runtime.isWaiting(for: "move") }

        let during = try screen(model)
        XCTAssertEqual(during.primaryButton, "Moving…")
        XCTAssertFalse(during.applyEnabled)
        XCTAssertNotNil(during.activity)

        await runtime.finish("move")
        await waitUntil("the move finishes") { !model.busy }
        let after = try screen(model)
        XCTAssertNil(after.activity)
        XCTAssertEqual(after.confirmation, "Moved, and Waffled restarted.")
    }

    /// A `status` of the folder being moved lays its subfolders back out and writes its
    /// bundle cache there — so a poll during the copy left the old folder behind, and the
    /// move back to it was then refused as "not empty".
    func testTheMenuBarStopsPollingTheFolderWhileItIsBeingMoved() async throws {
        let runtime = FakeRuntime()
        await runtime.answer(status: Fixtures.fullRunning)
        await runtime.hold("move")
        let model = try settingsModel(runner: runtime)
        defer { model.end() }
        model.begin()
        await waitUntil("the first poll") { await runtime.count(of: "status") > 0 }

        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("the move is under way") { await runtime.isWaiting(for: "move") }
        let polled = await runtime.count(of: "status")
        try await Task.sleep(for: .milliseconds(2600))
        let polledDuringTheMove = await runtime.count(of: "status") - polled
        XCTAssertEqual(polledDuringTheMove, 0, "the old folder was polled while it was being moved")

        await runtime.finish("move")
        await waitUntil("the move finishes") { !model.busy }
    }

    /// The poll sits out a move, so the last status it read — running — would stand for the
    /// whole copy, with Open Waffled offering a server that is down.
    func testTheMenuDoesNotSayRunningWhileAMoveHasTheServerDown() async throws {
        let runtime = FakeRuntime()
        await runtime.hold("move")
        let model = try settingsModel(runner: runtime)
        defer { model.end() }

        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("the move is under way") { await runtime.isWaiting(for: "move") }

        let menu = model.presentation(canCheckForUpdates: false)
        XCTAssertEqual(menu.statusLine, "Moving Waffled's files…")
        XCTAssertFalse(menu.openEnabled)
        XCTAssertFalse(menu.addressEnabled)
        XCTAssertFalse(menu.shareEnabled)

        await runtime.finish("move")
        await waitUntil("the move finishes") { !model.busy }
        XCTAssertNotEqual(model.presentation(canCheckForUpdates: false).statusLine, "Moving Waffled's files…")
    }

    func testAFailedMoveDoesNotLeaveTheMenuSayingMoving() async throws {
        let runner = RecordingRunner()
        runner.refusing["move"] = "the destination already has something in it"
        let model = try settingsModel(runner: runner)
        defer { model.end() }

        _ = model.stageMove(to: destination)
        model.applySettings()
        await waitUntil("Apply finishes") { !model.busy }

        let line = model.presentation(canCheckForUpdates: false).statusLine
        XCTAssertNotEqual(line, "Moving Waffled's files…")
    }

    func testTheMenuDoesNotSayRunningWhileARestartHasTheServerDown() async throws {
        let runtime = FakeRuntime()
        await runtime.hold("start")
        let model = try settingsModel(runner: runtime)
        defer { model.end() }

        model.restartServer()
        await waitUntil("the restart is under way") { await runtime.isWaiting(for: "start") }
        let menu = model.presentation(canCheckForUpdates: false)
        XCTAssertEqual(menu.statusLine, "Restarting Waffled…")
        XCTAssertFalse(menu.openEnabled)

        await runtime.finish("start")
        await waitUntil("the restart finishes") { !model.busy }
        XCTAssertNotEqual(model.presentation(canCheckForUpdates: false).statusLine, "Restarting Waffled…")
    }

    func testARestartShowsWhileItRunsAndWhenItIsDone() async throws {
        let runtime = FakeRuntime()
        await runtime.hold("start")
        let model = try settingsModel(runner: runtime)
        defer { model.end() }

        model.restartServer()
        await waitUntil("the restart is under way") { await runtime.isWaiting(for: "start") }
        XCTAssertEqual(try screen(model).primaryButton, "Restarting…")

        await runtime.finish("start")
        await waitUntil("the restart finishes") { !model.busy }
        XCTAssertEqual(try screen(model).confirmation, "Waffled restarted.")
    }

    func testEveryActivityHasItsOwnButton() throws {
        for (activity, label) in [(SettingsPresentation.Activity.applying, "Applying…"),
                                  (.moving, "Moving…"), (.restarting, "Restarting…")] {
            let screen = SettingsPresentation.make(
                options: SetupOptions(), saved: SetupOptions(), dataDirectory: current,
                status: try running(at: current), busy: true, activity: activity)
            XCTAssertEqual(screen.primaryButton, label)
            XCTAssertNotNil(screen.activity)
            XCTAssertFalse(screen.applyEnabled)
        }
    }

    private func data(_ call: RecordingRunner.Call) -> String? {
        guard let i = call.arguments.firstIndex(of: "--data"), i + 1 < call.arguments.count else { return nil }
        return call.arguments[i + 1]
    }
}
