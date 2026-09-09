import XCTest
@testable import Waffled

/// `UpdateFlow` decides what an update does; this is the other half — that the model runs
/// the effects it is handed, against a runtime that answers.
///
/// Nothing here spawns. The operation's task body is isolated to this same actor, so it
/// cannot interleave with a test that never awaits; `end()` cancels it.
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

    /// The busy branch: `.note`, and no stop. Recorded as a stop failure it turned the Quit
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
        XCTAssertFalse(installed, "the swap waits for a stop that has not happened")
        XCTAssertEqual(model.transient, UpdateFlow.busyNote, "the click still gets an answer")

        let menu = model.presentation(canCheckForUpdates: false)
        XCTAssertEqual(menu.quitTitle, "Quit Waffled",
                       "Quit must still ask, rather than offering to leave the server running")
        XCTAssertEqual(menu.checkForUpdatesLabel, "Install the update now")
        XCTAssertFalse(menu.checkForUpdatesEnabled, "until the backup gives the slot back")
    }

    /// `.stopServer` and `.recordStopFailure` both reach the model: the stop really runs,
    /// and a refusal lands in the channel that changes the Quit item rather than in the
    /// one a poll would wipe.
    func testAStopThatRefusesIsHeldAndLeavesTheRetryOffered() async {
        let model = makeModel()   // the binary does not exist, so `stop` cannot succeed
        defer { model.end() }

        var installs = 0
        model.stopBeforeUpdate { installs += 1 }
        XCTAssertTrue(model.busy, "the stop is the effect the flow asked for")

        await waitUntil("the stop comes back") { !model.busy }
        XCTAssertNotNil(model.stopFailure, "the channel the Quit item reads")
        XCTAssertEqual(installs, 0, "the swap must not land on a server that is still up")
        XCTAssertEqual(model.presentation(canCheckForUpdates: false).checkForUpdatesLabel,
                       "Install the update now", "the block we kept is the way on")

        // The retry is the same stop, with that block.
        model.installPendingUpdate()
        XCTAssertTrue(model.busy)
    }

    /// `.invoke`: a stop that succeeds hands the app over, and nothing puts the server back.
    func testAStopThatSucceedsRunsSparklesBlock() async {
        let runtime = FakeRuntime()
        let model = makeModel(runtime)
        defer { model.end() }

        var installs = 0
        model.stopBeforeUpdate { installs += 1 }
        await waitUntil("the stop comes back") { !model.busy }

        XCTAssertEqual(installs, 1)
        XCTAssertEqual(model.updatePhase, .handedOff)
        XCTAssertEqual(model.status?.state, .stopped, "every stop ends in a fresh read")
        let starts = await runtime.count(of: "start")
        XCTAssertEqual(starts, 0, "the server stays down for the swap")
    }

    /// The status a restart is decided on. A stop of ours makes every poll before it wrong,
    /// and the hand-off path takes no new one: read as `running`, the restart an abort owes
    /// is dropped and the household is left with no server at all.
    func testAnAbortRestartsEvenWhenTheLastPollBeforeTheStopSaidRunning() async {
        let runtime = FakeRuntime()
        await runtime.answer(status: Fixtures.fullRunning)
        let model = makeModel(runtime)
        defer { model.end() }

        model.startServer(trigger: .app)
        await waitUntil("the start comes back") { !model.busy }
        XCTAssertEqual(model.status?.state, .running, "precondition: what the app last saw")

        model.stopBeforeUpdate {}
        await waitUntil("the stop comes back") { !model.busy }
        XCTAssertEqual(model.updatePhase, .handedOff, "precondition: the hand-off path")

        model.updateCycleEnded(error: "You cancelled the update.")
        await waitUntil("the server we stopped comes back") { await runtime.count(of: "start") == 2 }
    }

    /// `.restartServer`, and the slot it waits for. A restart is an operation, so it lost
    /// to whatever already held the one slot: `startServer` returned at its guard, under a
    /// note saying the update had been dealt with, and the household's server stayed down.
    func testTheRestartAfterAnAbortWaitsForTheOperationSlot() async {
        let runtime = FakeRuntime()
        await runtime.hold("backup")
        let model = makeModel(runtime)
        defer { model.end() }

        model.stopBeforeUpdate {}
        await waitUntil("the stop comes back") { !model.busy }
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

    /// The same restart when the slot was free all along: nothing else announces a slot
    /// that never had to be given back, so the model asks.
    func testAnAbortWithTheSlotFreeRestartsStraightAway() async {
        let runtime = FakeRuntime()
        let model = makeModel(runtime)
        defer { model.end() }

        model.stopBeforeUpdate {}
        await waitUntil("the stop comes back") { !model.busy }

        model.updateCycleEnded(error: "The update is improperly signed.")
        XCTAssertEqual(model.transient, "Update not installed: The update is improperly signed.")
        await waitUntil("the server we stopped comes back") { await runtime.count(of: "start") == 1 }

        // Sparkle reports one abort twice; the second has nothing left to put back.
        model.updateCycleEnded(error: nil)
        await waitUntil("the start comes back") { !model.busy }
        let starts = await runtime.count(of: "start")
        XCTAssertEqual(starts, 1)
    }

    /// The abort landing while a person's own `Start Waffled` is the operation in the way.
    /// The queued restart used to fire from the freed slot regardless, and that second
    /// `start` hit the runtime's pidfile guard and slashed the icon until the next poll.
    func testTheQueuedRestartDoesNotStartAServerSomebodyElseBroughtBack() async {
        let runtime = FakeRuntime()
        await runtime.hold("start")
        let model = makeModel(runtime)
        defer { model.end() }

        model.stopBeforeUpdate {}
        await waitUntil("the stop comes back") { !model.busy }

        model.startServer()   // a person puts the server back before Sparkle says anything
        await waitUntil("the start reaches the runtime") { await runtime.isWaiting(for: "start") }
        await runtime.answer(status: Fixtures.fullRunning)

        model.updateCycleEnded(error: "You cancelled the update.")
        await runtime.finish("start")
        await waitUntil("the start comes back") { !model.busy }

        let starts = await runtime.count(of: "start")
        XCTAssertEqual(starts, 1, "the household's server is already up")
    }

    /// A cycle that ends while our stop is still running. `stop` can take two and a half
    /// minutes and Sparkle can abort at any point in them, so the block the stop was going
    /// to invoke has lost its driver by the time it comes back.
    func testAStopThatOutlivesItsUpdateCycleRestartsInsteadOfInstalling() async {
        let runtime = FakeRuntime()
        await runtime.hold("stop")
        let model = makeModel(runtime)
        defer { model.end() }

        var installs = 0
        model.stopBeforeUpdate { installs += 1 }
        await waitUntil("the stop reaches the runtime") { await runtime.isWaiting(for: "stop") }

        model.updateCycleEnded(error: "You cancelled the update.")
        await runtime.finish("stop")

        await waitUntil("the server is started again") { await runtime.count(of: "start") == 1 }
        XCTAssertEqual(installs, 0, "the driver that would have installed it is gone")
    }

    /// What the menu says while a stop that lost its cycle runs on. The abort's own line
    /// clears itself after a few seconds, so saying it here would wipe the persistent
    /// "Stopping for the update…" and leave the menu disabled and unexplained for up to two
    /// and a half minutes.
    func testAnAbortDuringOurStopKeepsTheStoppingLineUntilTheStopComesBack() async {
        let runtime = FakeRuntime()
        await runtime.hold("stop")
        let model = makeModel(runtime)
        defer { model.end() }

        model.stopBeforeUpdate {}
        await waitUntil("the stop reaches the runtime") { await runtime.isWaiting(for: "stop") }

        model.updateCycleEnded(error: "You cancelled the update.")
        XCTAssertEqual(model.transient, "Stopping for the update…",
                       "the stop is still running, and the menu is disabled for all of it")

        await runtime.finish("stop")
        await waitUntil("the stop explains itself") { model.transient == "Update not installed" }
    }

    /// Quitting while an installer is armed is refused wherever the click came from — the
    /// item is disabled, so this is the update that landed between drawing and clicking.
    func testQuitIsRefusedRatherThanSilentWhileAnInstallerIsArmed() async {
        let model = makeModel()
        defer { model.end() }

        model.stopBeforeUpdate {}
        await waitUntil("the stop refuses") { !model.busy }
        XCTAssertNotNil(model.stopFailure, "precondition")

        model.confirmAndQuit()
        XCTAssertEqual(model.transient, UpdateFlow.refusedQuitNote,
                       "a Quit that did nothing at all would read as a broken menu")
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
}
