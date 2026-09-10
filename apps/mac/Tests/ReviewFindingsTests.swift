import XCTest
@testable import Waffled

/// The three Mac-side findings from the review pass on PR #202.
@MainActor
final class ReviewFindingsTests: XCTestCase {

    private func running() throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
    }

    // MARK: 1 · a data directory the environment owns is not ours to move

    /// `WAFFLED_DATA_DIR` decides where the data lives, and `chooseDataDirectory` refuses
    /// to repoint an environment-pinned location on purpose. A move would therefore copy
    /// the household, delete the original, and leave the app pointing at the folder it
    /// had just deleted — with the real data orphaned at the destination.
    func testTheFolderCannotBeMovedWhenTheEnvironmentOwnsIt() throws {
        let screen = SettingsPresentation.make(
            options: SetupOptions(), saved: SetupOptions(),
            dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
            status: try running(), pinned: true)

        XCTAssertFalse(screen.moveEnabled)
        XCTAssertNotNil(screen.moveRefusal, "a dead button with no reason is worse than none")
    }

    func testTheFolderCanBeMovedWhenNothingHasPinnedIt() throws {
        let screen = SettingsPresentation.make(
            options: SetupOptions(), saved: SetupOptions(),
            dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
            status: try running(), pinned: false)

        XCTAssertTrue(screen.moveEnabled)
        XCTAssertNil(screen.moveRefusal)
    }

    /// And the model refuses it too, not just the button — `moveDataDirectory` is reachable
    /// on its own, and the consequence of getting this wrong is a household's data left in
    /// a folder nothing points at.
    func testTheModelRefusesAPinnedMoveEvenIfSomethingAsks() async {
        let model = ServerModel(
            environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime",
                          RuntimeLocator.dataVariable: NSTemporaryDirectory()],
            resourceURL: nil, memory: InMemoryDefaults(), runner: RecordingRunner())
        defer { model.end() }

        XCTAssertTrue(model.dataDirectoryIsPinned, "precondition: the environment set it")
        model.openSettings()
        model.moveDataDirectory(to: URL(fileURLWithPath: "/tmp/somewhere-else"))

        XCTAssertFalse(model.busy, "nothing should have been started")
        XCTAssertNotNil(model.heldFailure, "and the person is told why")
    }

    // MARK: 3 · a button that cannot do anything is not offered

    /// `Back` from the options screen does not discard what was typed, so an invalid port
    /// left there makes `beginSetup` a no-op — and a button that is lit while the click
    /// behind it does nothing is worse than one that is greyed.
    func testTheWelcomeButtonIsOffWhileTheOptionsScreenHasAProblem() {
        let model = ServerModel(
            environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"],
            resourceURL: nil, memory: InMemoryDefaults(), runner: RecordingRunner())
        defer { model.end() }

        model.setupOptions.port = "80"     // below 1024 — refused, and kept on Back
        XCTAssertFalse(model.setupOptions.problems.isEmpty,
                       "precondition: what was typed cannot be applied")
        model.beginSetup()
        XCTAssertFalse(model.busy, "beginSetup is a no-op, which is why the button must be off")
    }

    // MARK: 4 · volume facts about a folder that is really there

    /// `<picked>/Waffled` does not exist yet, and `resourceValues` on a path that is not
    /// there fails — which `facts(for:)` reads as the ordinary case. So the volume rules
    /// have to be asked of a folder that really exists, or a removable drive and a network
    /// share both pass every one of them.
    func testVolumeRulesApplyToAFolderThatHasNotBeenMadeYet() throws {
        let parent = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("waffled-facts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: parent) }

        // The real question this fixes: the answer must come from the parent, which exists
        // and is on a real volume, rather than from a path nothing can be asked about.
        let unmade = parent.appendingPathComponent(Setup.folderName)
        XCTAssertEqual(Setup.nearestExisting(unmade).path, parent.path)
        XCTAssertNil(Setup.refusal(for: unmade), "a writable folder on this Mac is fine")
    }
}
