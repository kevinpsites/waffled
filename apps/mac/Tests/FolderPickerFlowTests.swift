import XCTest
@testable import Waffled

/// The folder picker end to end, short of the panel itself: what a click resolves to, and
/// the exact `--data` / `move --to` the runtime is then handed. The panel opens BESIDE the
/// folder Waffled is using, so the likeliest clicks are that folder and its parent —
/// which is where #202 went wrong in both directions (nesting Waffled/Waffled, and a
/// database scattered through Documents).
@MainActor
final class FolderPickerFlowTests: XCTestCase {

    private var home: URL!

    override func setUpWithError() throws {
        home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("waffled-picker-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        addTeardownBlock { [home] in try? FileManager.default.removeItem(at: home!) }
    }

    private var applicationSupport: URL { home.appendingPathComponent("Library/Application Support") }
    private var current: URL { applicationSupport.appendingPathComponent("Waffled") }
    private var documents: URL { home.appendingPathComponent("Documents") }

    private func makeDirectory(_ url: URL, with files: [String] = []) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        for file in files {
            FileManager.default.createFile(atPath: url.appendingPathComponent(file).path, contents: Data("x".utf8))
        }
    }

    /// The standard folder is this scratch home's, never the real one, so no test here can
    /// hand the runtime a path under the real ~/Library.
    private func makeModel(runner: RecordingRunner, memory: InMemoryDefaults = InMemoryDefaults(),
                           at folder: URL? = nil, environment: [String: String] = [:]) -> ServerModel {
        memory.set((folder ?? current).path, forKey: Setup.dataDirectoryKey)
        return ServerModel(environment: environment.merging([RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"]) { a, _ in a },
                           resourceURL: nil, memory: memory, runner: runner,
                           standardDataDirectory: current)
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool) async {
        for _ in 0..<300 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out waiting for \(what)")
    }

    private func dataArgument(_ call: RecordingRunner.Call) -> String? {
        guard let i = call.arguments.firstIndex(of: "--data"), i + 1 < call.arguments.count else { return nil }
        return call.arguments[i + 1]
    }

    // MARK: the first run

    /// `~/Documents`, on a Mac that has a `~/Documents/backups` of its own: Waffled gets a
    /// folder inside it, and every setup call is pointed there — never at Documents.
    func testAFirstRunInDocumentsWritesOnlyIntoAWaffledFolderThere() async throws {
        try makeDirectory(documents.appendingPathComponent("backups"))
        let runner = RecordingRunner()
        let model = makeModel(runner: runner)
        defer { model.end() }

        model.chooseDataDirectory(Setup.dataDirectory(forChosen: documents, current: model.dataDirectory))
        model.beginSetup()
        await waitUntil("setup finishes") { !model.busy }

        let configCalls = runner.calls.filter { $0.arguments.first == "config" }
        XCTAssertFalse(configCalls.isEmpty)
        for call in configCalls {
            XCTAssertEqual(dataArgument(call), documents.appendingPathComponent("Waffled").path)
        }
    }

    /// The panel opens in Application Support with Waffled's folder right there. Clicking
    /// Choose straight away, or picking that folder, both mean "leave it where it is".
    func testAFirstRunThatKeepsTheDefaultNestsNothing() async throws {
        try makeDirectory(current.appendingPathComponent("postgres"))
        let runner = RecordingRunner()
        let model = makeModel(runner: runner)
        defer { model.end() }

        for picked in [applicationSupport, current] {
            XCTAssertEqual(Setup.dataDirectory(forChosen: picked, current: model.dataDirectory).path,
                           current.path, "picking \(picked.lastPathComponent) moved Waffled")
        }
    }

    // MARK: Settings → Move…

    /// Picking the folder Waffled is already in is not a failure, and it stops nothing.
    /// It used to be reported as "inside itself" — the wrong words, and in the menu bar.
    func testMovingToTheFolderWaffledIsAlreadyInIsNotAFailure() async throws {
        try makeDirectory(current, with: ["runtime.json", "config.env"])
        let runner = RecordingRunner()
        let model = makeModel(runner: runner)
        defer { model.end() }
        model.openSettings()

        for picked in [applicationSupport, current] {
            model.moveDataDirectory(to: Setup.dataDirectory(forChosen: picked, current: model.dataDirectory))
            XCTAssertNil(model.heldFailure, "picking \(picked.lastPathComponent) was reported as a failure")
            XCTAssertFalse(model.busy)
            // Said in the drawer that was clicked: the menu's note is behind this window.
            XCTAssertEqual(model.folderNote, SettingsPresentation.Copy.alreadyThere)
        }
        XCTAssertFalse(runner.calls.contains { ["stop", "move"].contains($0.arguments.first) },
                       "nothing should have been stopped or moved")
    }

    /// A real move: the destination is the Waffled folder inside the pick, `--data` names
    /// the folder being moved FROM, and the next launch is pointed at the new one.
    func testMovingToDocumentsMovesIntoAWaffledFolderThere() async throws {
        try makeDirectory(current, with: ["runtime.json", "config.env"])
        try makeDirectory(documents.appendingPathComponent("media"))
        let memory = InMemoryDefaults()
        let runner = RecordingRunner()
        let model = makeModel(runner: runner, memory: memory)
        defer { model.end() }
        model.openSettings()

        let destination = Setup.dataDirectory(forChosen: documents, current: model.dataDirectory)
        model.moveDataDirectory(to: destination)
        await waitUntil("the move finishes") { !model.busy }

        let move = try XCTUnwrap(runner.calls.first { $0.arguments.first == "move" })
        XCTAssertEqual(Array(move.arguments.prefix(3)),
                       ["move", "--to", documents.appendingPathComponent("Waffled").path])
        XCTAssertEqual(dataArgument(move), current.path)
        XCTAssertEqual(memory.string(forKey: Setup.dataDirectoryKey),
                       documents.appendingPathComponent("Waffled").path)
    }

    /// A folder inside the one being moved is still refused, before anything is stopped.
    func testMovingIntoItselfIsStillRefused() throws {
        try makeDirectory(current.appendingPathComponent("media"), with: [])
        try makeDirectory(current, with: ["runtime.json"])
        let runner = RecordingRunner()
        let model = makeModel(runner: runner)
        defer { model.end() }
        model.openSettings()

        model.moveDataDirectory(to: current.appendingPathComponent("media/Waffled"))
        XCTAssertEqual(model.heldFailure, SettingsPresentation.Copy.folderInsideItself)
        XCTAssertTrue(runner.calls.isEmpty)
    }

    // MARK: back to the standard folder

    /// ~/Library is hidden, so no open panel shows Application Support: once Waffled is
    /// anywhere else, this is the only way back.
    func testTheStandardFolderIsOfferedOnlyWhenWaffledIsElsewhere() {
        let atStandard = makeModel(runner: RecordingRunner())
        defer { atStandard.end() }
        XCTAssertFalse(atStandard.offersStandardFolder)

        let elsewhere = makeModel(runner: RecordingRunner(), at: documents.appendingPathComponent("Waffled"))
        defer { elsewhere.end() }
        XCTAssertTrue(elsewhere.offersStandardFolder)
    }

    func testAPinnedFolderIsNeverOfferedAWayOut() {
        let pinned = documents.appendingPathComponent("Waffled")
        let model = makeModel(runner: RecordingRunner(), at: pinned,
                              environment: [RuntimeLocator.dataVariable: pinned.path])
        defer { model.end() }
        XCTAssertFalse(model.offersStandardFolder)
    }

    func testAFirstRunCanGoBackToTheStandardFolder() {
        let model = makeModel(runner: RecordingRunner())
        defer { model.end() }
        model.chooseDataDirectory(documents.appendingPathComponent("Waffled"))
        XCTAssertTrue(model.offersStandardFolder)

        model.useStandardFolder()
        XCTAssertEqual(model.dataDirectory.path, current.path)
        XCTAssertFalse(model.offersStandardFolder)
    }

    func testSettingsMovesBackToTheStandardFolder() async throws {
        let elsewhere = documents.appendingPathComponent("Waffled")
        try makeDirectory(elsewhere, with: ["runtime.json", "config.env"])
        let memory = InMemoryDefaults()
        let runner = RecordingRunner()
        let model = makeModel(runner: runner, memory: memory, at: elsewhere)
        defer { model.end() }
        model.openSettings()

        model.useStandardFolder()
        await waitUntil("the move finishes") { !model.busy }

        let move = try XCTUnwrap(runner.calls.first { $0.arguments.first == "move" })
        XCTAssertEqual(Array(move.arguments.prefix(3)), ["move", "--to", current.path])
        XCTAssertEqual(dataArgument(move), elsewhere.path)
        XCTAssertEqual(memory.string(forKey: Setup.dataDirectoryKey), current.path)
    }
}
