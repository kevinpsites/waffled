import XCTest
@testable import Waffled

/// The model is mostly wiring — the decisions live in `Lifecycle` — but which *channel* a
/// refusal goes down is its own, and getting it wrong changes what the Quit item does.
///
/// Nothing here spawns. The operation's task body is isolated to this same actor, and
/// these tests never await, so it cannot interleave with them; `end()` cancels it.
@MainActor
final class ServerModelTests: XCTestCase {

    /// - Parameter runtime: a runtime that answers, for the tests that need an operation
    ///   to still be running. Without one the binary does not exist, so every call fails
    ///   at once — which is what the refusal tests want.
    private func makeModel(_ runtime: FakeRuntime? = nil) -> ServerModel {
        ServerModel(environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"],
                    resourceURL: nil, memory: InMemoryDefaults(),
                    runner: runtime ?? SubprocessRunner())
    }

    /// An update that arrives while a backup is running is a "not now", not a server that
    /// refused to stop — nothing asked it to. Recorded as a stop failure it turned the Quit
    /// item into "Quit anyway (server keeps running)", whose very next click terminates over
    /// a running server and a backup still writing.
    ///
    /// "Not now" still has to keep the handler: Sparkle's session stays open around it, so
    /// dropping it leaves the item a dead `Checking for updates…` for the rest of the
    /// process and the downloaded update with no way to be installed at all.
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
        XCTAssertTrue(model.hasPendingUpdate, "the handler is the only way this update lands")

        let menu = model.presentation(canCheckForUpdates: false)
        XCTAssertEqual(menu.checkForUpdatesLabel, "Install the update now")
        XCTAssertFalse(menu.checkForUpdatesEnabled, "until the backup gives the slot back")
    }

    /// A stop that refuses holds the relaunch — and Sparkle's install handler with it. That
    /// handler is the only way the update ever happens: having postponed the relaunch, its
    /// session stays in progress and a fresh `checkForUpdates` is a silent no-op. So the
    /// model keeps it, and the menu item runs it again.
    func testAHeldUpdateKeepsTheInstallHandlerForTheRetry() async {
        let model = makeModel()   // the binary does not exist, so `stop` cannot succeed
        defer { model.end() }

        var installs = 0
        model.stopBeforeUpdate { installs += 1 }
        XCTAssertTrue(model.hasPendingUpdate, "taken the moment Sparkle hands it over")

        await settle(model)
        XCTAssertNotNil(model.stopFailure, "precondition: this stop refused")
        XCTAssertEqual(installs, 0, "the swap must not land on a server that is still up")
        XCTAssertTrue(model.hasPendingUpdate, "nothing else can install it now")

        // The retry is the same stop, with the handler we kept.
        model.installPendingUpdate()
        XCTAssertTrue(model.busy)
    }

    /// The other way a held update ends: not a retry that works, but the cycle it belonged
    /// to finishing without us. The handler cannot install anything once its driver is
    /// gone, and the item has to go back to an ordinary check — which works again, because
    /// the session that was blocking it has ended too.
    func testTheHeldHandlerGoesWithTheCycleThatOwnedIt() async {
        let model = makeModel()
        defer { model.end() }

        model.stopBeforeUpdate {}
        await settle(model)
        XCTAssertTrue(model.hasPendingUpdate, "precondition: the stop refused and we kept it")

        model.updateCycleEnded(error: "You cancelled the update.")

        XCTAssertFalse(model.hasPendingUpdate)
        XCTAssertEqual(model.presentation(canCheckForUpdates: true).checkForUpdatesLabel,
                       "Check for updates…")
    }

    /// An update that aborts after our stop is a restart — and a restart is an operation,
    /// so it lost to whatever already held the one slot: `startServer` returned at its
    /// guard, under a note saying the update had been dealt with, and the household's
    /// server stayed down for the rest of the process.
    func testTheRestartAfterAnAbortWaitsForTheOperationSlot() async {
        let runtime = FakeRuntime()
        await runtime.hold("stop")
        await runtime.hold("backup")
        let model = makeModel(runtime)
        defer { model.end() }

        model.stopBeforeUpdate {}
        await waitUntil("the stop reaches the runtime") { await runtime.isWaiting(for: "stop") }
        await runtime.finish("stop")
        await settle(model)
        var starts = await runtime.count(of: "start")
        XCTAssertEqual(starts, 0, "precondition: nothing has started")

        // Back up now stays enabled while the server is stopped, which is exactly when
        // someone asks for one — so it is the operation most likely to be in the way.
        model.backUpNow()
        await waitUntil("the backup reaches the runtime") { await runtime.isWaiting(for: "backup") }

        model.updateCycleEnded(error: "You cancelled the update.")
        starts = await runtime.count(of: "start")
        XCTAssertEqual(starts, 0, "the backup holds the slot; the restart has to wait for it")

        await runtime.finish("backup")
        await waitUntil("the queued restart fires") { await runtime.count(of: "start") == 1 }
    }

    /// Polls a condition until it holds, bounded rather than blocking: everything these
    /// tests drive is deterministic, but it lands across task boundaries.
    private func waitUntil(_ what: String, _ condition: () async -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)")
    }

    /// Waits out the one operation the model has in flight. It is stopping a runtime that
    /// is not there, so every call fails immediately — this is bounded by the failure, not
    /// by the sleep.
    private func settle(_ model: ServerModel) async {
        let deadline = Date().addingTimeInterval(5)
        while model.busy, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(model.busy, "the operation never came back")
    }
}
