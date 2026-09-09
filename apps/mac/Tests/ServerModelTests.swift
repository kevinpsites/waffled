import XCTest
@testable import Waffled

/// The model is mostly wiring — the decisions live in `Lifecycle` — but which *channel* a
/// refusal goes down is its own, and getting it wrong changes what the Quit item does.
///
/// Nothing here spawns. The operation's task body is isolated to this same actor, and
/// these tests never await, so it cannot interleave with them; `end()` cancels it.
@MainActor
final class ServerModelTests: XCTestCase {

    private func makeModel() -> ServerModel {
        ServerModel(environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"],
                    resourceURL: nil, memory: InMemoryDefaults())
    }

    /// An update that arrives while a backup is running is a "not now", not a server that
    /// refused to stop — nothing asked it to. Recorded as a stop failure it turned the Quit
    /// item into "Quit anyway (server keeps running)", whose very next click terminates over
    /// a running server and a backup still writing.
    func testAnUpdateThatLandsMidOperationIsANoteRatherThanAFailedStop() {
        let model = makeModel()
        defer { model.end() }

        model.backUpNow()
        XCTAssertTrue(model.busy, "precondition: the backup holds the one operation slot")

        var installed = false
        model.stopBeforeUpdate { installed = true }

        XCTAssertNil(model.stopFailure, "nothing tried to stop the server, so nothing refused")
        XCTAssertEqual(model.presentation(canCheckForUpdates: false).quitTitle, "Quit Waffled",
                       "Quit must still ask, rather than offering to leave the server running")
        XCTAssertFalse(installed, "the swap waits for a stop that has not happened")
        XCTAssertNotNil(model.transient, "the click still gets an answer")
    }
}
