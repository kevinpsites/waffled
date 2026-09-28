import XCTest
@testable import Waffled

/// The menu's `Settings…` item. Like everything else the menu draws, it is a value — the
/// one case worth the test is that it cannot be opened while the first-run window has the
/// app's single window, because an `LSUIElement` app has nowhere to put a second one.
final class SettingsMenuItemTests: XCTestCase {

    private func status(_ json: String) throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(json))
    }

    func testSettingsIsOfferedOnAnOrdinaryLaunch() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.fullRunning))
        XCTAssertTrue(menu.settingsEnabled)
    }

    /// The first-run window IS the app's one window. Opening settings over it would either
    /// replace what a household is reading or build a second window there is no room for.
    ///
    /// It stays taken for the whole of that launch — the setting-up and ready steps too,
    /// not only while the welcome step waits — because that is when the window is really
    /// on screen, and an item that is offered while the click behind it is refused is
    /// worse than one that is greyed.
    func testSettingsIsOffWhileTheFirstRunWindowIsUp() throws {
        let waiting = MenuPresentation.make(status: try status(Fixtures.freshDataDirectory),
                                            awaitingSetup: true, windowTaken: true)
        XCTAssertFalse(waiting.settingsEnabled)

        let starting = MenuPresentation.make(status: try status(Fixtures.firstStartInProgress),
                                             awaitingSetup: false, windowTaken: true)
        XCTAssertFalse(starting.settingsEnabled, "the window is still on screen")
    }

    /// Every one of these writes through `waffled-runtime`, so with no runtime to run
    /// there is nothing the screen could apply.
    func testSettingsIsOffWithNoRuntimeToRun() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.fullRunning),
                                         runtimeAvailable: false)
        XCTAssertFalse(menu.settingsEnabled)
    }

    /// Unlike `Start Waffled`, this one stays available while the server is stopped: the
    /// backup time and the address are exactly what someone fixes before starting again.
    func testSettingsIsOfferedWhileTheServerIsStopped() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.minimalStopped))
        XCTAssertTrue(menu.settingsEnabled)
    }

    /// A start, stop or backup holds the one operation slot, and Apply needs it.
    func testSettingsIsOffWhileSomethingIsInFlight() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.fullRunning), busy: true)
        XCTAssertFalse(menu.settingsEnabled)
    }
}
