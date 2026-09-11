import XCTest
@testable import Waffled

/// What Apply says once it has worked, and how the server gets to use it.
///
/// Everything that answers "did that work?" has to be somewhere the person who clicked
/// can see: in the window rather than the menu bar behind it, and still there once the
/// form has settled.
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

    /// `needsRestart` follows what the RUNNING server is missing, not what the form still
    /// has outstanding — those two become equal the moment Apply succeeds, which is
    /// exactly when the warning matters most.
    func testTheRestartNoteSurvivesTheApplyThatCausedIt() throws {
        var changed = SetupOptions()
        changed.addressMode = .name

        let before = screen(options: changed, saved: SetupOptions(), status: try running())
        XCTAssertTrue(before.needsRestart, "precondition: the pending change needs one")

        // After Apply: options and saved agree, and the server still has not been restarted.
        let after = screen(options: changed, saved: changed, status: try running(),
                           awaitingRestart: true)
        XCTAssertTrue(after.needsRestart,
                      "discovery is still handing out the old address — that is when it matters")
        XCTAssertEqual(after.primaryAction, .restart,
                       "nothing left to apply, so the button becomes the thing that is left")
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

    /// The primary button is always the next thing to do. Greying it out the moment Apply
    /// succeeds leaves the only way forward — a restart — in a menu the person is not
    /// looking at, under a note below the fold.
    func testTheButtonBecomesTheRestartOnceThereIsNothingLeftToApply() throws {
        var changed = SetupOptions()
        changed.addressMode = .name

        let pending = screen(options: changed, saved: SetupOptions(), status: try running())
        XCTAssertEqual(pending.primaryAction, .apply, "there is still something to apply")
        XCTAssertEqual(pending.primaryButton, "Apply")

        let applied = screen(options: changed, saved: changed, status: try running(),
                             awaitingRestart: true)
        XCTAssertEqual(applied.primaryAction, .restart)
        XCTAssertEqual(applied.primaryButton, "Restart Waffled")
        XCTAssertTrue(applied.applyEnabled, "and it has to be clickable to be any use")
    }

    /// With nothing pending and nothing to restart, the button is Apply and it is off.
    func testTheButtonIsAQuietApplyWhenThereIsNothingToDo() throws {
        let settled = SetupOptions()
        let quiet = screen(options: settled, saved: settled, status: try running())
        XCTAssertEqual(quiet.primaryAction, .apply)
        XCTAssertFalse(quiet.applyEnabled)
    }

    /// A change still outstanding wins: applying it is the next thing, not restarting for
    /// an earlier one.
    func testAnOutstandingChangeIsAppliedBeforeAnyRestartIsOffered() throws {
        var changed = SetupOptions()
        changed.backupAt = "01:00"
        let both = screen(options: changed, saved: SetupOptions(), status: try running(),
                          awaitingRestart: true)
        XCTAssertEqual(both.primaryAction, .apply)
    }

    /// The window has to say Apply worked: a note posted to the menu bar is invisible
    /// while this window is the thing in front of the person who clicked.
    func testTheWindowSaysWhenSettingsWereApplied() throws {
        let settled = SetupOptions()
        let quiet = screen(options: settled, saved: settled, status: try running())
        XCTAssertNil(quiet.confirmation, "nothing has been applied yet")

        let done = SettingsPresentation.make(
            options: settled, saved: settled,
            dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
            status: try running(), done: .applied)
        XCTAssertNotNil(done.confirmation)
        XCTAssertTrue(done.confirmation?.isEmpty == false)
    }

    /// The screen's own name, title-cased the way macOS names System Settings — and the
    /// way the menu item that opens it is spelled.
    func testTheScreenIsNamedTheWayTheMenuItemNamesIt() throws {
        let settled = SetupOptions()
        XCTAssertEqual(screen(options: settled, saved: settled, status: try running()).title,
                       "Waffled Settings")
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
