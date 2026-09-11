import XCTest
@testable import Waffled

/// The app has one window, and two screens want it. These are the rules that keep them
/// from wanting it at the same time — asserted on the model, without ever showing one.
@MainActor
final class SettingsWindowTests: XCTestCase {

    private func makeModel() -> ServerModel {
        ServerModel(environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"],
                    resourceURL: nil, memory: InMemoryDefaults(), runner: SubprocessRunner())
    }

    /// The bug a real install hit. `isFirstRun` is latched for the whole process, so once
    /// setup had finished and the ready window was dismissed the app still believed a
    /// first-run window held the app's one window — and `Settings…` stayed greyed out for
    /// the rest of that launch. A dismissed window is not an occupied one.
    func testSettingsIsUsableOnceTheFirstRunWindowHasBeenDismissed() throws {
        let model = makeModel()
        defer { model.end() }

        model.pretendFirstRunForTesting(
            try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning)))
        XCTAssertNotNil(model.windowPresentation, "precondition: the ready step is on screen")
        XCTAssertFalse(model.presentation(canCheckForUpdates: false).settingsEnabled,
                       "while it is up, the window is taken")

        model.dismissFirstRunWindow()

        XCTAssertTrue(model.presentation(canCheckForUpdates: false).settingsEnabled,
                      "the window is free once it has been dismissed")
        model.openSettings()
        guard case .settings = model.windowPresentation else {
            return XCTFail("Settings should own the window now, not the finished first run")
        }
    }

    func testNoWindowUntilSomethingAsksForOne() {
        let model = makeModel()
        defer { model.end() }
        XCTAssertNil(model.windowPresentation)
    }

    func testSettingsPutsTheOptionsScreenInTheWindow() {
        let model = makeModel()
        defer { model.end() }

        model.openSettings()
        guard case .settings = model.windowPresentation else {
            return XCTFail("Settings should own the window once it is opened")
        }
    }

    func testClosingSettingsTakesTheWindowAway() {
        let model = makeModel()
        defer { model.end() }

        model.openSettings()
        model.closeSettings()
        XCTAssertNil(model.windowPresentation)
    }

    /// The provider key is never read back out of config.env, so the field opens blank —
    /// and a blank field means "I did not change it", which is what makes that safe.
    func testTheKeyFieldOpensBlank() {
        let model = makeModel()
        defer { model.end() }

        model.setupOptions.providerKey = "sk-left-over"
        model.openSettings()
        XCTAssertTrue(model.setupOptions.providerKey.isEmpty)
    }

    /// A screen nobody has changed has nothing to apply, so Apply is off before it is
    /// touched — the click that does nothing is worse than the button that says so.
    func testApplyIsOffUntilSomethingChanges() {
        let model = makeModel()
        defer { model.end() }

        model.openSettings()
        guard case let .settings(before) = model.windowPresentation else {
            return XCTFail("Settings should own the window")
        }
        XCTAssertFalse(before.applyEnabled)

        model.setupOptions.backupAt = "01:00"
        guard case let .settings(after) = model.windowPresentation else {
            return XCTFail("Settings should still own the window")
        }
        XCTAssertTrue(after.applyEnabled)
    }

    /// `moveDataDirectory` needs the screen open — it is that screen's button — and it
    /// must not be reachable any other way, because it stops the server to do its work.
    func testTheFolderIsNotMovedFromAClosedScreen() {
        let model = makeModel()
        defer { model.end() }

        model.moveDataDirectory(to: URL(fileURLWithPath: "/tmp/somewhere"))
        XCTAssertFalse(model.busy, "nothing should have been started")
    }

    func testApplyDoesNothingFromAClosedScreen() {
        let model = makeModel()
        defer { model.end() }

        model.setupOptions.backupAt = "01:00"
        model.applySettings()
        XCTAssertFalse(model.busy)
    }
}
