import XCTest
@testable import Waffled

/// The whole update flow, as a table. Every row is one (phase, event) pair and the phase
/// and effects it produces, so the rules that used to be four booleans scattered through
/// `ServerModel` can be read in one place and asserted without a process or a menu.
final class UpdateFlowTests: XCTestCase {

    private let h1 = InstallHandler {}
    private let h2 = InstallHandler {}

    /// One row of the table.
    private struct Row {
        let phase: UpdateFlow.Phase
        let event: UpdateFlow.Event
        let next: UpdateFlow.Phase
        let effects: [UpdateFlow.Effect]
        let why: String
        let line: UInt

        init(_ phase: UpdateFlow.Phase, _ event: UpdateFlow.Event,
             _ next: UpdateFlow.Phase, _ effects: [UpdateFlow.Effect],
             _ why: String, line: UInt = #line) {
            self.phase = phase
            self.event = event
            self.next = next
            self.effects = effects
            self.why = why
            self.line = line
        }
    }

    private func check(_ rows: [Row]) {
        for row in rows {
            let (next, effects) = UpdateFlow.step(row.phase, row.event)
            XCTAssertEqual(next, row.next, row.why, line: row.line)
            XCTAssertEqual(effects, row.effects, row.why, line: row.line)
        }
    }

    // MARK: an installer Sparkle has prepared

    /// The three ways the app learns an installer exists, and the one that can drive it.
    ///
    /// `didExtractUpdate` carries no block: it says only that Sparkle has extracted and
    /// validated the new app, which is the moment the swap becomes inevitable. Stopping
    /// the server on it would be a stop with nothing to hand off to, followed by a restart,
    /// followed by the postpone hook stopping it again.
    func testAnArmingWithoutABlockLatchesButStopsNothing() {
        check([
            Row(.idle, .installerArmed(handler: nil, canStopNow: true),
                .armed(handler: nil), [],
                "extraction alone arms Sparkle; there is nothing of ours to run yet"),
            Row(.armed(handler: h1), .installerArmed(handler: nil, canStopNow: true),
                .armed(handler: h1), [],
                "a nil arming never replaces a block we are holding"),
            Row(.restartQueued(handler: h1), .installerArmed(handler: nil, canStopNow: true),
                .restartQueued(handler: h1), [],
                "and never discharges a restart we owe"),
            Row(.stoppingForInstall(handler: nil),
                .installerArmed(handler: nil, canStopNow: true),
                .stoppingForInstall(handler: nil), [],
                "nor revives a block whose driver has already gone"),
        ])
    }

    /// The block — from `shouldPostponeRelaunchForUpdate`, from `willInstallUpdateOnQuit`,
    /// or from the menu's own `Install the update now` — is what starts the stop.
    func testTheBlockIsWhatStopsTheServer() {
        check([
            Row(.idle, .installerArmed(handler: h1, canStopNow: true),
                .stoppingForInstall(handler: h1), [.stopServer],
                "the relaunch is postponed until the server is really down"),
            Row(.armed(handler: nil), .installerArmed(handler: h1, canStopNow: true),
                .stoppingForInstall(handler: h1), [.stopServer],
                "extraction armed us; the postpone hook is what can act on it"),
            Row(.armed(handler: h1), .installerArmed(handler: h1, canStopNow: true),
                .stoppingForInstall(handler: h1), [.stopServer],
                "`Install the update now` is the same stop with the block we kept"),
            Row(.restartQueued(handler: h1), .installerArmed(handler: h1, canStopNow: true),
                .stoppingForInstall(handler: h1), [.stopServer],
                "an update that can go ahead beats a restart we were only going to undo"),
        ])
    }

    /// An update that lands on a busy app is a "not now", never a server that refused to
    /// stop — nothing asked it to. The block is kept all the same: it is the only way this
    /// update can ever be installed.
    func testABusySlotKeepsTheBlockAndSaysSo() {
        check([
            Row(.idle, .installerArmed(handler: h1, canStopNow: false),
                .armed(handler: h1), [.note(UpdateFlow.busyNote)],
                "the item becomes `Install the update now`, disabled until the slot frees"),
            Row(.restartQueued(handler: nil), .installerArmed(handler: h1, canStopNow: false),
                .restartQueued(handler: h1), [.note(UpdateFlow.busyNote)],
                "the restart is still owed, and now there is a block to keep too"),
        ])
    }

    /// A second arming while our stop is already running adopts the newer block rather than
    /// starting a second stop — there is one operation slot, so there is one stop.
    func testAnArmingDuringOurStopOnlyUpdatesTheBlock() {
        check([
            Row(.stoppingForInstall(handler: h1), .installerArmed(handler: h2, canStopNow: true),
                .stoppingForInstall(handler: h2), [],
                "the stop in flight is the one that will hand off"),
            Row(.handedOff, .installerArmed(handler: h2, canStopNow: true),
                .handedOff, [],
                "Sparkle has the app; nothing here starts another stop"),
        ])
    }

    // MARK: our stop coming back

    func testTheStopDecidesBetweenHandingOffAndPuttingTheServerBack() {
        check([
            Row(.stoppingForInstall(handler: h1), .stopSucceeded,
                .handedOff, [.invoke(h1)],
                "the server is down, so the swap is Sparkle's now"),
            Row(.stoppingForInstall(handler: nil), .stopSucceeded,
                .restartQueued(handler: nil), [],
                "the cycle that asked for this stop is gone — the server is down for nothing"),
            Row(.armed(handler: h1), .stopSucceeded, .armed(handler: h1), [],
                "no stop of ours was running"),
        ])
    }

    /// A refused stop holds the relaunch and keeps the block: having postponed, Sparkle's
    /// session stays in progress and a fresh `checkForUpdates` does nothing at all, so the
    /// block is the only way on.
    func testARefusedStopKeepsTheBlockForTheRetry() {
        check([
            Row(.stoppingForInstall(handler: h1), .stopFailed("postgres would not shut down"),
                .armed(handler: h1), [.recordStopFailure("postgres would not shut down")],
                "`Install the update now` tries the same stop again"),
            Row(.stoppingForInstall(handler: nil), .stopFailed("postgres would not shut down"),
                .armed(handler: nil), [.recordStopFailure("postgres would not shut down")],
                "the server is still up, so there is nothing to put back either"),
        ])
    }

    // MARK: a cycle that ends without installing anything

    func testACycleEndingNeverDisarmsAndOnlyRestartsWhatWeStopped() {
        check([
            Row(.idle, .cycleEnded(error: "no update"), .idle, [],
                "the ordinary daily check that found nothing stopped nothing"),
            Row(.armed(handler: h1), .cycleEnded(error: nil), .armed(handler: nil), [],
                "the block's driver is gone, but Sparkle's installer is not"),
            Row(.stoppingForInstall(handler: h1),
                .cycleEnded(error: "The update is improperly signed.\nDetail"),
                .stoppingForInstall(handler: nil),
                [.note("Update not installed: The update is improperly signed.")],
                "the stop is still running; its completion now has nothing to invoke"),
            Row(.stoppingForInstall(handler: nil), .cycleEnded(error: nil),
                .stoppingForInstall(handler: nil), [],
                "Sparkle reports one abort twice — the second says nothing new"),
            Row(.handedOff, .cycleEnded(error: nil),
                .restartQueued(handler: nil), [.note("Update not installed")],
                "we stopped the server for a swap that is not coming"),
            Row(.restartQueued(handler: nil), .cycleEnded(error: nil),
                .restartQueued(handler: nil), [],
                "already owed; the second report adds nothing"),
        ])
    }

    // MARK: the one operation slot

    /// A restart is an operation, so it waits for the slot — and then only starts a server
    /// that is actually down. Starting a second one is the supervisor fight the plan forbids.
    func testTheQueuedRestartWaitsForTheSlotAndOnlyStartsAServerThatIsDown() {
        check([
            Row(.restartQueued(handler: h1), .operationSlotFreed(serverState: .stopped),
                .armed(handler: h1), [.restartServer],
                "the server this app stopped a moment ago, put back"),
            Row(.restartQueued(handler: h1), .operationSlotFreed(serverState: nil),
                .armed(handler: h1), [.restartServer],
                "a status that would not answer is not evidence the server came back"),
            Row(.restartQueued(handler: h1), .operationSlotFreed(serverState: .running),
                .armed(handler: h1), [],
                "something already started it — a second start hits the runtime's pidfile guard"),
            Row(.restartQueued(handler: h1), .operationSlotFreed(serverState: .starting),
                .armed(handler: h1), [], "and one on its way up is not ours to start again"),
            Row(.restartQueued(handler: h1), .operationSlotFreed(serverState: .unhealthy),
                .armed(handler: h1), [], "the runtime supervises its own children"),
            Row(.armed(handler: h1), .operationSlotFreed(serverState: .stopped),
                .armed(handler: h1), [], "nothing of ours is down"),
            Row(.handedOff, .operationSlotFreed(serverState: .stopped), .handedOff, [],
                "the server is down because Sparkle is about to replace the app"),
        ])
    }

    func testAPersonsOwnStartDischargesTheRestartWeOwed() {
        check([
            Row(.restartQueued(handler: h1), .startClicked, .armed(handler: h1), [],
                "the household's server is back; queueing a second start would slash the icon"),
            Row(.armed(handler: h1), .startClicked, .armed(handler: h1), [],
                "an ordinary start changes nothing about a prepared installer"),
        ])
    }

    // MARK: quitting

    /// Quit is the other end of the same rule. Once Sparkle's installer is prepared it
    /// finishes the swap when this process exits, for any reason at all, so with one armed
    /// there is no such thing as "Quit anyway (server keeps running)".
    func testQuitIsRefusedWheneverAnInstallerIsArmed() {
        check([
            Row(.armed(handler: nil), .quitRequested(stopHasFailed: true),
                .armed(handler: nil), [.refuseQuit(UpdateFlow.refusedQuitNote)],
                "`Install on Quit` left an installer armed with no block for us to drive"),
            Row(.stoppingForInstall(handler: h1), .quitRequested(stopHasFailed: true),
                .stoppingForInstall(handler: h1), [.refuseQuit(UpdateFlow.refusedQuitNote)],
                "a stop that refused during the update is exactly this case"),
            Row(.restartQueued(handler: h1), .quitRequested(stopHasFailed: true),
                .restartQueued(handler: h1), [.refuseQuit(UpdateFlow.refusedQuitNote)],
                "an abort does not disarm the installer, so it does not re-enable Quit"),
            Row(.idle, .quitRequested(stopHasFailed: true), .idle, [.terminate],
                "nothing is prepared to swap — leaving is a person's call"),
            Row(.idle, .quitRequested(stopHasFailed: false), .idle, [],
                "the ordinary quit: ask, stop the server, then go"),
            Row(.armed(handler: h1), .quitRequested(stopHasFailed: false),
                .armed(handler: h1), [],
                "nothing refused, so the ordinary quit stops the server first — which is what makes the swap safe"),
        ])
    }

    // MARK: the invariant

    /// `armed` is latched the first time the app hears of a prepared installer and is never
    /// cleared by anything except handing the app over. Sparkle will finish the swap on any
    /// termination, so from this side it is irreversible.
    func testArmedIsIrreversibleUntilTheHandOff() {
        let survives: [UpdateFlow.Event] = [
            .cycleEnded(error: nil),
            .cycleEnded(error: "You cancelled the update."),
            .stopFailed("postgres would not shut down"),
            .startClicked,
            .operationSlotFreed(serverState: .running),
            .quitRequested(stopHasFailed: true),
        ]
        for event in survives {
            var flow = UpdateFlow()
            _ = flow.send(.installerArmed(handler: nil, canStopNow: true))
            XCTAssertTrue(flow.phase.installerArmed, "precondition")
            _ = flow.send(event)
            XCTAssertTrue(flow.phase.installerArmed,
                          "\(event) must not tell the app the swap has been called off")
        }

        var flow = UpdateFlow()
        _ = flow.send(.installerArmed(handler: h1, canStopNow: true))
        _ = flow.send(.stopSucceeded)
        XCTAssertEqual(flow.phase, .handedOff)
        XCTAssertFalse(flow.phase.installerArmed,
                       "the one way out: we stopped the server and handed the app over")
    }

    // MARK: the four scenarios the review named

    /// `Install on Quit` ends Sparkle's cycle with no error and leaves the installer armed.
    /// Quitting after a stop that refused would then swap the app — runtime bundle and all —
    /// under the server still running the old one.
    func testInstallOnQuitThenARefusedStopThenQuitIsRefused() {
        var flow = UpdateFlow()

        _ = flow.send(.installerArmed(handler: nil, canStopNow: true))   // didExtractUpdate
        _ = flow.send(.cycleEnded(error: nil))                           // Install on Quit
        XCTAssertEqual(flow.phase, .armed(handler: nil))

        // Someone clicks Quit; the stop refuses, so the app stays.
        XCTAssertEqual(flow.send(.quitRequested(stopHasFailed: true)),
                       [.refuseQuit(UpdateFlow.refusedQuitNote)])
        XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: true, phase: flow.phase),
                       .stopTheServerFirst)
    }

    /// The abort-then-restart path, with a person getting there first. The restart used to
    /// fire from the freed slot regardless, and the second `start` hit the runtime's pidfile
    /// guard and slashed the icon.
    func testAnAbortThenAPersonsStartDoesNotDoubleStart() {
        var flow = UpdateFlow()

        _ = flow.send(.installerArmed(handler: h1, canStopNow: true))
        _ = flow.send(.stopSucceeded)                       // handed off
        _ = flow.send(.cycleEnded(error: "The update is improperly signed."))
        XCTAssertEqual(flow.phase, .restartQueued(handler: nil))

        _ = flow.send(.startClicked)                        // the person got there first
        XCTAssertEqual(flow.send(.operationSlotFreed(serverState: .running)), [],
                       "the household's server is already back")
    }

    /// `stop` can take two and a half minutes and Sparkle can abort at any point in them.
    /// The block that the stop was going to invoke has lost its driver by the time it runs.
    func testACycleThatEndsDuringOurStopRestartsInsteadOfInstalling() {
        var flow = UpdateFlow()

        _ = flow.send(.installerArmed(handler: h1, canStopNow: true))
        XCTAssertEqual(flow.phase, .stoppingForInstall(handler: h1))

        _ = flow.send(.cycleEnded(error: "You cancelled the update."))
        XCTAssertEqual(flow.send(.stopSucceeded), [],
                       "nothing to invoke — the driver that would have installed it is gone")
        XCTAssertEqual(flow.phase, .restartQueued(handler: nil))
        XCTAssertEqual(flow.send(.operationSlotFreed(serverState: .stopped)), [.restartServer])
    }

    /// An update that arrives while a backup is writing keeps its block and waits for the
    /// slot; the menu item is the retry, disabled until then.
    func testTheBusyBranchKeepsTheBlockForTheRetry() {
        var flow = UpdateFlow()

        XCTAssertEqual(flow.send(.installerArmed(handler: h1, canStopNow: false)),
                       [.note(UpdateFlow.busyNote)])
        XCTAssertEqual(flow.phase, .armed(handler: h1))
        XCTAssertEqual(flow.phase.installHandler, h1, "the only way this update can land")

        // The retry, once the slot is free.
        XCTAssertEqual(flow.send(.installerArmed(handler: h1, canStopNow: true)), [.stopServer])
    }
}
