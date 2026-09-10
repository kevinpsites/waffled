import XCTest
@testable import Waffled

/// What Apply says once it has worked, and how the server gets to use it.
///
/// All three of these were reported from a real install at once: the address was written
/// to config.env correctly, and every sign of that went somewhere the person could not
/// see. Apply greyed itself out, the window said nothing, and the "needs a restart" note
/// vanished at the exact moment it became true.
final class ApplyFeedbackTests: XCTestCase {

    private func running() throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
    }

    private func screen(options: SetupOptions, saved: SetupOptions,
                        status: RuntimeStatus?, awaitingRestart: Bool = false)
        -> SettingsPresentation {
        SettingsPresentation.make(options: options, saved: saved,
                                  dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                  status: status, awaitingRestart: awaitingRestart)
    }

    /// The bug: `needsRestart` compared the pending edits with what was saved, so applying
    /// them made the two equal and the warning disappeared. It has to follow what the
    /// RUNNING server is missing, not what the form still has outstanding.
    func testTheRestartNoteSurvivesTheApplyThatCausedIt() throws {
        var changed = SetupOptions()
        changed.addressMode = .ip

        let before = screen(options: changed, saved: SetupOptions(), status: try running())
        XCTAssertTrue(before.needsRestart, "precondition: the pending change needs one")

        // After Apply: options and saved agree, and the server still has not been restarted.
        let after = screen(options: changed, saved: changed, status: try running(),
                           awaitingRestart: true)
        XCTAssertTrue(after.needsRestart,
                      "the server is still running on the old address — that is when it matters")
        XCTAssertFalse(after.applyEnabled, "there is nothing left to apply")
    }

    func testNoRestartNoteOnceTheServerHasBeenRestarted() throws {
        let settled = SetupOptions()
        XCTAssertFalse(screen(options: settled, saved: settled, status: try running(),
                              awaitingRestart: false).needsRestart)
    }

    /// A stopped server is not running on the old anything: the next start uses the new
    /// value, so there is nothing to warn about.
    func testNoRestartNoteWhenTheServerIsNotRunning() throws {
        let settled = SetupOptions()
        let stopped = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))
        XCTAssertFalse(screen(options: settled, saved: settled, status: stopped,
                              awaitingRestart: true).needsRestart)
    }

    /// The window has to say Apply worked. The menu-bar note it used to post is invisible
    /// while this window is the thing in front of the person who clicked.
    func testTheWindowSaysWhenSettingsWereApplied() throws {
        let settled = SetupOptions()
        let quiet = screen(options: settled, saved: settled, status: try running())
        XCTAssertNil(quiet.confirmation, "nothing has been applied yet")

        let done = SettingsPresentation.make(
            options: settled, saved: settled,
            dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
            status: try running(), applied: true)
        XCTAssertNotNil(done.confirmation)
        XCTAssertTrue(done.confirmation?.isEmpty == false)
    }
}

/// `Restart Waffled` — the way to make a restart-requiring setting take effect without
/// quitting the app, which stops the server and leaves the household with nothing.
final class RestartMenuTests: XCTestCase {

    private func status(_ json: String) throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(json))
    }

    func testRestartIsOfferedWhileTheServerIsRunning() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.fullRunning))
        XCTAssertTrue(menu.showRestart)
        XCTAssertTrue(menu.restartEnabled)
    }

    /// Nothing to restart: `Start Waffled` is the item for that, and showing both would be
    /// two buttons for one job.
    func testRestartIsNotOfferedWhenTheServerIsDown() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.minimalStopped))
        XCTAssertFalse(menu.showRestart)
        XCTAssertTrue(menu.showStart, "the other item covers this case")
    }

    /// A start, stop or backup already holds the one operation slot a restart needs.
    func testRestartWaitsForWhateverIsInFlight() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.fullRunning), busy: true)
        XCTAssertTrue(menu.showRestart, "still the right item, just not yet")
        XCTAssertFalse(menu.restartEnabled)
    }
}
