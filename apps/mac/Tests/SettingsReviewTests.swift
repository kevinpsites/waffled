import XCTest
@testable import Waffled

/// Findings from the local review of the Settings redesign.
@MainActor
final class SettingsReviewTests: XCTestCase {

    /// Remembered options seed the first-run form, but a key never is remembered. A
    /// provider that needs one arriving without it — preferences from an earlier attempt,
    /// or from the build whose default provider was Anthropic — would disable
    /// "Set up Waffled" on the welcome step, which shows no reason why.
    func testARememberedProviderWithNoKeyDoesNotBlockAFirstRun() {
        let memory = InMemoryDefaults()
        var remembered = SetupOptions()
        remembered.provider = .anthropic
        remembered.backupAt = "01:00"
        Setup.remember(remembered, in: memory)

        let model = ServerModel(environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"],
                                resourceURL: nil, memory: memory, runner: RecordingRunner())
        defer { model.end() }

        XCTAssertTrue(model.setupOptions.problems.isEmpty,
                      "the first run is blocked by \(model.setupOptions.problems)")
        XCTAssertEqual(model.setupOptions.backupAt, "01:00", "the rest of what was remembered stays")
        // Settings still shows what was applied.
        model.openSettings()
        XCTAssertEqual(model.setupOptions.provider, .anthropic)
    }

    /// Start at login is the app's own business rather than the runtime's, so it writes no
    /// command — which left Apply off when it was the only change, and the switch dead.
    func testStartAtLoginAloneCanBeApplied() {
        var changed = SetupOptions()
        changed.startAtLogin = false
        let screen = SettingsPresentation.make(options: changed, saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/W"),
                                               status: nil)
        XCTAssertTrue(screen.applyEnabled)
        XCTAssertNil(screen.confirmation, "an unapplied change is not 'Settings applied.'")
    }

    func testStartAtLoginNeedsNoRestart() throws {
        var changed = SetupOptions()
        changed.startAtLogin = false
        let screen = SettingsPresentation.make(options: changed, saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/W"),
                                               status: try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning)))
        XCTAssertFalse(screen.needsRestart)
    }
}
