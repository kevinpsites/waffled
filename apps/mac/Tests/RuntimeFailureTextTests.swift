import XCTest
@testable import Waffled

/// What a failed runtime command actually says.
///
/// The runtime narrates to stderr as it works and then prints its refusal there too, so
/// the raw stream opens with "bundle verified" and buries the reason further down. Taken
/// whole, the error window and the menu both led with an INFO line — a real first run
/// failed here and reported "bundle verified (cached) — waffled 0.14.3 …" as the problem.
final class RuntimeFailureTextTests: XCTestCase {

    /// Exactly what the runtime wrote when the nightly backup could not be scheduled.
    private let realRefusal = """
        2026-09-10 09:33:11 info  bundle verified (cached) — waffled 0.14.3 · node 24.19.0
        ✗ launchctl bootstrap /Users/sam/Library/LaunchAgents/app.waffled.backup.plist: exit status 5
        Bootstrap failed: 5: Input/output error
        Try re-running the command as root for richer errors.
        """

    func testTheNarrationIsDroppedAndTheRefusalKept() {
        let message = RuntimeClient.failureMessage(realRefusal)

        XCTAssertFalse(message.contains("bundle verified"),
                       "the log line the runtime opened with is not the problem")
        XCTAssertTrue(message.hasPrefix("launchctl bootstrap"),
                      "the refusal leads, got \(message)")
        XCTAssertTrue(message.contains("Bootstrap failed: 5"),
                      "and the detail under it is kept, got \(message)")
    }

    /// The menu has one line, and it must be the one that says what went wrong.
    func testTheOneLineTheMenuShowsIsTheRefusal() {
        XCTAssertEqual(RuntimeClient.failureMessage(realRefusal).firstLine,
                       "launchctl bootstrap /Users/sam/Library/LaunchAgents/app.waffled.backup.plist: exit status 5")
    }

    /// Not every refusal carries the mark — a Go panic or a tool's own stderr will not —
    /// so log lines are dropped by shape as well.
    func testTimestampedNarrationIsDroppedEvenWithNoMark() {
        let message = RuntimeClient.failureMessage("""
            2026-09-10 09:33:11 info  bundle verified (cached) — waffled 0.14.3
            2026-09-10 09:33:12 warn  something worth saying
            pg_ctl: could not start server
            """)
        XCTAssertEqual(message, "pg_ctl: could not start server")
    }

    /// A stream that is nothing BUT narration still has to say something: dropping every
    /// line would leave the window blank, which is what "it failed and there were no
    /// logs" looks like from the outside.
    func testNarrationOnlyIsKeptRatherThanLeavingNothing() {
        let onlyLogs = "2026-09-10 09:33:11 info  bundle verified (cached) — waffled 0.14.3"
        XCTAssertEqual(RuntimeClient.failureMessage(onlyLogs), onlyLogs)
    }

    func testTheMarkIsStrippedFromTheSentenceItLeads() {
        XCTAssertEqual(RuntimeClient.failureMessage("✗ it went wrong"), "it went wrong")
    }

    func testAnEmptyStreamStaysEmpty() {
        XCTAssertEqual(RuntimeClient.failureMessage("   \n  "), "")
    }
}
