import AppKit
import XCTest
@testable import Waffled

/// Everything the menu shows is a pure function of the last status document, so all of it
/// can be asserted without a menu, a process, or a run loop.
final class MenuPresentationTests: XCTestCase {

    // MARK: icon

    func testEachStateHasItsOwnIconAndSpokenLabel() {
        let stopped = IconAppearance.forState(.stopped)
        let starting = IconAppearance.forState(.starting)
        let running = IconAppearance.forState(.running)
        let unhealthy = IconAppearance.forState(.unhealthy)

        // Only `starting` moves: the waffle cooks one hole at a time, six holes, then
        // starts again. Every other state is a single drawing.
        XCTAssertEqual(stopped.frameCount, 1)
        XCTAssertEqual(running.frameCount, 1)
        XCTAssertEqual(unhealthy.frameCount, 1)
        XCTAssertEqual(starting.frameCount, WaffleIronIcon.holeCount)

        XCTAssertFalse(stopped.isAnimated)
        XCTAssertFalse(running.isAnimated)
        XCTAssertFalse(unhealthy.isAnimated)
        XCTAssertTrue(starting.isAnimated)

        XCTAssertEqual(stopped.accessibilityLabel, "Waffled is stopped")
        XCTAssertEqual(starting.accessibilityLabel, "Waffled is starting")
        XCTAssertEqual(running.accessibilityLabel, "Waffled is running")
        XCTAssertEqual(unhealthy.accessibilityLabel, "Waffled needs attention")
    }

    /// The cooking animation: one more hole filled each tick, wrapping around, and never
    /// an empty pan — the six frames are 1…6, not 0…5.
    func testStartingFillsOneHoleAtATimeAndWrapsAround() {
        let starting = IconAppearance.forState(.starting)

        XCTAssertEqual((0..<6).map { starting.fillCount(frame: $0) }, [1, 2, 3, 4, 5, 6])
        XCTAssertEqual(starting.fillCount(frame: 6), 1, "wraps rather than stopping")
        XCTAssertEqual(starting.fillCount(frame: 13), 2)

        // A state that does not animate has no half-cooked frames at all.
        for state in [RuntimeState.stopped, .running, .unhealthy] {
            let icon = IconAppearance.forState(state)
            XCTAssertEqual(icon.fillCount(frame: 3), 0, "\(state) does not cook")
        }
    }

    /// The mark is drawn, not a symbol, so the thing worth asserting is that the four
    /// states really do look different — that is the whole job of a menu-bar icon.
    @MainActor func testTheFourStatesDrawFourDifferentImages() throws {
        let images = try [RuntimeState.stopped, .starting, .running, .unhealthy].map { state in
            let icon = IconAppearance.forState(state)
            return try XCTUnwrap(
                WaffleIronIcon.image(state: state, fillCount: icon.fillCount(frame: 2),
                                     pointSize: 18).tiffRepresentation)
        }
        XCTAssertEqual(Set(images).count, 4, "two states that draw the same say nothing")
    }

    /// Template, or macOS will not recolour it for a dark menu bar and it disappears.
    @MainActor func testTheImageIsATemplateSizedInPoints() {
        let image = WaffleIronIcon.image(state: .running, fillCount: 0, pointSize: 18)

        XCTAssertTrue(image.isTemplate)
        XCTAssertEqual(image.size, NSSize(width: 18, height: 18))
    }

    /// Redrawn on every poll it would be a needless allocation twice a second, so the
    /// frames are drawn once and handed back.
    @MainActor func testRenderedFramesAreCached() {
        let first = WaffleIronIcon.image(state: .starting, fillCount: 2, pointSize: 18)
        let second = WaffleIronIcon.image(state: .starting, fillCount: 2, pointSize: 18)
        let other = WaffleIronIcon.image(state: .starting, fillCount: 3, pointSize: 18)

        XCTAssertTrue(first === second, "same state, same frame, same image")
        XCTAssertFalse(first === other)
    }

    /// Colour belongs to the status line, never the icon: menu-bar icons are template
    /// images and macOS recolours them for the menu bar's own appearance.
    func testStatusTintIsPerStateAndLivesInTheMenuNotTheIcon() {
        XCTAssertEqual(StatusTint.forState(.running), .running)
        XCTAssertEqual(StatusTint.forState(.starting), .starting)
        XCTAssertEqual(StatusTint.forState(.stopped), .idle)
        XCTAssertEqual(StatusTint.forState(.unhealthy), .fault)
    }

    // MARK: server address

    func testServerAddressPrefersTheLanURL() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        XCTAssertEqual(s.serverAddress, "192.168.1.5:8080")
    }

    /// No LAN URL but an advertisement: the mock-up's `kevins-mac-mini.local:8080` form.
    /// The Bonjour block's own port can be 0 (nothing advertising right now), so the
    /// public port stands in — it is the same port either way.
    func testServerAddressFallsBackToBonjourHostAndThePublicPort() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.bonjourOnly))
        XCTAssertEqual(s.serverAddress, "kevins-mac-mini.local:8090")
    }

    func testServerAddressIsNilWhenNothingIsReachableFromAnotherDevice() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.noAddress))
        XCTAssertNil(s.serverAddress)
    }

    // MARK: the menu's enabled/disabled table

    func testRunningEnablesEverythingItCan() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "Waffled is running")
        XCTAssertEqual(m.statusTint, .running)
        XCTAssertTrue(m.openEnabled)
        XCTAssertEqual(m.addressLine, "Server address: 192.168.1.5:8080")
        XCTAssertTrue(m.addressEnabled)
        XCTAssertTrue(m.backupEnabled)
        XCTAssertFalse(m.showLogs)
        // Present but inert until Phase 3 item 6 ships the appcast.
        XCTAssertFalse(m.checkForUpdatesEnabled)
    }

    func testStartingDisablesTheActionsThatNeedAServer() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.withUnknownFields))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "Waffled is starting…")
        XCTAssertEqual(m.statusTint, .starting)
        XCTAssertFalse(m.openEnabled)
        XCTAssertFalse(m.addressEnabled)
        XCTAssertFalse(m.showLogs)
    }

    /// Backup is enabled while stopped on purpose: `waffled-runtime backup` starts
    /// Postgres for itself, and "am I protected?" is asked exactly when nothing is up.
    func testStoppedStillAllowsABackup() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "Waffled is stopped")
        XCTAssertEqual(m.statusTint, .idle)
        XCTAssertFalse(m.openEnabled)
        XCTAssertEqual(m.addressLine, "Server address: —")
        XCTAssertFalse(m.addressEnabled)
        XCTAssertTrue(m.backupEnabled)
        XCTAssertFalse(m.showLogs)
    }

    func testUnhealthyShowsTheRuntimesOwnFirstLineAndOffersTheLogs() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.unhealthy))
        let m = MenuPresentation.make(status: s)

        XCTAssertEqual(m.statusLine, "api exited with status 1")
        XCTAssertEqual(m.statusTint, .fault)
        XCTAssertFalse(m.openEnabled)
        XCTAssertFalse(m.addressEnabled, "an address nothing is answering on is not an address")
        XCTAssertTrue(m.showLogs)
    }

    /// The one thing the menu was missing: a way back. Auto-start gets a single attempt,
    /// so a stopped server — or a start that refused — has to be startable by hand.
    func testStartIsOfferedWheneverThereIsSomethingToStart() throws {
        let stopped = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))
        let running = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let starting = try RuntimeStatus.decode(Fixtures.data(Fixtures.withUnknownFields))

        let idle = MenuPresentation.make(status: stopped)
        XCTAssertTrue(idle.showStart)
        XCTAssertTrue(idle.startEnabled)

        for status in [running, starting] {
            XCTAssertFalse(MenuPresentation.make(status: status).showStart,
                           "nothing to start")
        }

        // A `start` that refused leaves nothing running, so the document says `stopped`
        // while the app holds the reason. That is exactly when Start has to be there.
        let failed = MenuPresentation.make(status: stopped, failure: "port 8080 is in use")
        XCTAssertTrue(failed.showStart)
        XCTAssertTrue(failed.startEnabled)

        // Offered but not clickable while an operation is already in flight.
        let busy = MenuPresentation.make(status: stopped, busy: true)
        XCTAssertTrue(busy.showStart)
        XCTAssertFalse(busy.startEnabled)

        // Before the first poll answers there is nothing to say about starting.
        XCTAssertFalse(MenuPresentation.make(status: nil).showStart)

        // No runtime to run: the menu already says so, and a Start button that cannot
        // work is worse than no button.
        let noRuntime = MenuPresentation.make(
            status: nil, failure: "No Waffled runtime is bundled with this build",
            runtimeAvailable: false)
        XCTAssertFalse(noRuntime.showStart)
    }

    /// A failed `start` is reported by the app, not by a status document: the runtime
    /// exited, so `state` may still read `stopped`.
    func testAFailureOverridesTheStatusLineAndRevealsTheLogs() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))
        let m = MenuPresentation.make(
            status: s,
            failure: "postgres refused to start\ninitdb: could not create directory")

        XCTAssertEqual(m.statusLine, "postgres refused to start")
        XCTAssertEqual(m.statusTint, .fault)
        XCTAssertTrue(m.showLogs)
        XCTAssertFalse(m.openEnabled)
    }

    /// A `stop` that refused during quit: the app is still here, the server is still
    /// running, and the menu has to say both. The quit item becomes the second question.
    func testAFailedStopIsReportedAndChangesTheQuitItem() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let m = MenuPresentation.make(status: s, stopFailure: "postgres would not shut down")

        XCTAssertEqual(m.statusLine, "Could not stop Waffled: postgres would not shut down")
        XCTAssertEqual(m.statusTint, .fault)
        XCTAssertTrue(m.showLogs, "a stop that failed is exactly a logs question")
        XCTAssertEqual(m.quitTitle, "Quit anyway (server keeps running)")
        XCTAssertFalse(m.showStart, "the server never stopped — there is nothing to start")

        let ordinary = MenuPresentation.make(status: s)
        XCTAssertEqual(ordinary.quitTitle, "Quit Waffled")
    }

    /// While the stop is in flight the status line says so and the actions are off: it
    /// can take two and a half minutes, and a menu that looks idle invites a second click.
    func testStoppingIsShownAndTheActionsAreDisabled() throws {
        // A stopped document, so that `startEnabled` would be true if `busy` were not
        // holding it off — against a running one this asserts nothing about `busy`.
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))
        let idle = MenuPresentation.make(status: s)
        XCTAssertTrue(idle.startEnabled, "precondition: start is offered while stopped")

        let m = MenuPresentation.make(status: s, transient: "Stopping…", busy: true)

        XCTAssertEqual(m.statusLine, "Stopping…")
        XCTAssertFalse(m.backupEnabled)
        XCTAssertFalse(m.startEnabled, "busy holds the actions off, whatever the state")
    }

    /// "Back up now" and the address click both answer in the status line for a few
    /// seconds. A transient message wins over everything, including a failure.
    func testATransientMessageTakesTheStatusLine() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let m = MenuPresentation.make(status: s, transient: "Backed up (4.6 MB)")

        XCTAssertEqual(m.statusLine, "Backed up (4.6 MB)")
        XCTAssertTrue(m.openEnabled, "a transient note changes the words, never the actions")
    }

    /// Before the first poll comes back there is no document at all.
    func testNoStatusYetReadsAsChecking() {
        let m = MenuPresentation.make(status: nil)

        XCTAssertEqual(m.statusLine, "Checking…")
        XCTAssertFalse(m.openEnabled)
        XCTAssertFalse(m.addressEnabled)
        XCTAssertFalse(m.backupEnabled, "nothing to back up until we know a runtime answers")
    }

    /// While a start, stop or backup is in flight, the actions that would collide with it
    /// are off — the runtime serialises them anyway, but a menu that lets you click twice
    /// is a menu that looks broken.
    func testAnOperationInFlightDisablesTheActions() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        let m = MenuPresentation.make(status: s, busy: true)

        XCTAssertFalse(m.backupEnabled)
        XCTAssertTrue(m.openEnabled, "opening a browser cannot collide with anything")
    }
}
