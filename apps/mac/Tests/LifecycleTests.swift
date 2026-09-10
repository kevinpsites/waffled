import XCTest
@testable import Waffled

/// The two rules that decide what the app does on its own, kept as pure functions so
/// they can be asserted rather than watched.
final class LifecycleTests: XCTestCase {

    /// A stopped stack is started; an unhealthy one is NOT. The runtime supervises its
    /// own children and restarts what it can — an app that starts on `unhealthy` is the
    /// restart loop the plan forbids.
    func testAutoStartOnlyFromStopped() {
        XCTAssertTrue(Lifecycle.shouldAutoStart(.stopped))
        XCTAssertFalse(Lifecycle.shouldAutoStart(.starting))
        XCTAssertFalse(Lifecycle.shouldAutoStart(.running))
        XCTAssertFalse(Lifecycle.shouldAutoStart(.unhealthy))
    }

    /// The one deferred attempt: the app is allowed to start the server exactly once per
    /// launch, and the first poll that actually answers spends the decision — whatever it
    /// answers. A poll that threw does not spend it (the status call itself can fail before
    /// the runtime is ready), and nothing that happens afterwards revives it: a household
    /// that stops the server from Terminal must find it still stopped.
    func testAutoStartIsDecidedOnceByTheFirstPollThatAnswers() {
        XCTAssertEqual(Lifecycle.autoStartDecision(state: nil, alreadyDecided: false),
                       .keepWaiting,
                       "status itself failed — keep polling rather than spending the attempt")
        XCTAssertEqual(Lifecycle.autoStartDecision(state: .stopped, alreadyDecided: false), .start)

        for state in [RuntimeState.running, .starting, .unhealthy] {
            XCTAssertEqual(Lifecycle.autoStartDecision(state: state, alreadyDecided: false),
                           .standDown,
                           "\(state) is not ours to start")
        }

        for state in [RuntimeState.stopped, .running, .starting, .unhealthy] {
            XCTAssertEqual(Lifecycle.autoStartDecision(state: state, alreadyDecided: true),
                           .standDown,
                           "once spent, never again — this app is not a second supervisor")
        }
        XCTAssertEqual(Lifecycle.autoStartDecision(state: nil, alreadyDecided: true), .standDown)
    }

    /// Whether this data directory has ever been set up is decided the same way as the
    /// auto-start: by the first poll that ANSWERS. A `status` that threw says nothing —
    /// and it is the ordinary cold-start case, because the runtime verifies its bundle
    /// before it can reply — so latching on it would either show the welcome window to a
    /// household that has been running for a year, or never show it at all.
    func testTheFirstRunAnswerComesFromTheFirstPollThatAnswers() {
        XCTAssertEqual(Lifecycle.firstRunDecision(initialized: nil), .keepWaiting)
        XCTAssertEqual(Lifecycle.firstRunDecision(initialized: false), .firstRun)
        XCTAssertEqual(Lifecycle.firstRunDecision(initialized: true), .established)
    }

    /// A first run is the one launch the app does NOT start the server by itself: the
    /// welcome window is asking, and a server that came up while the question was on
    /// screen would have answered it. The one-attempt rule is unchanged — the click
    /// spends it — so this holds the decision open rather than standing it down.
    func testTheWelcomeStepHoldsTheAutoStartOpen() {
        XCTAssertEqual(Lifecycle.autoStartDecision(state: .stopped, alreadyDecided: false,
                                                   awaitingSetup: true),
                       .keepWaiting,
                       "the button on the welcome window is what starts a first run")

        XCTAssertEqual(Lifecycle.autoStartDecision(state: .stopped, alreadyDecided: false,
                                                   awaitingSetup: false),
                       .start,
                       "every later launch is unchanged")

        XCTAssertEqual(Lifecycle.autoStartDecision(state: .stopped, alreadyDecided: true,
                                                   awaitingSetup: true),
                       .standDown,
                       "the click spent the attempt; nothing revives it")
    }

    /// The quiet relaunch (plan §2 step 6). The browser is for the two moments someone is
    /// waiting for it: the first run, and a click on `Start Waffled`. Everything else —
    /// the login-item start at every boot, a server that was already up when the menu
    /// appeared — leaves the screen alone.
    ///
    /// Why it is narrower than "any start this app made": docs/product/native-mac-plan.md,
    /// Phase 3 item 3, "The relaunch rule".
    func testTheBrowserOpensForAFirstRunOrAClickAndNothingElse() {
        XCTAssertTrue(Lifecycle.shouldOpenBrowser(
            newState: .running, trigger: .person, isFirstRun: false, alreadyOpened: false),
            "a person clicked Start Waffled and is waiting for something to happen")

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, trigger: .person, isFirstRun: true, alreadyOpened: false),
            "a first run ends on the ready step, whose Open Waffled button is the click")

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, trigger: .app, isFirstRun: false, alreadyOpened: false),
            "the auto-start at login must not pop a browser at every boot")

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, trigger: .notUs, isFirstRun: false, alreadyOpened: false),
            "already running when we launched — do not steal the screen")

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, trigger: .person, isFirstRun: true, alreadyOpened: true),
            "once per process, not once per poll")

        for state in [RuntimeState.stopped, .starting, .unhealthy] {
            XCTAssertFalse(Lifecycle.shouldOpenBrowser(
                newState: state, trigger: .person, isFirstRun: true, alreadyOpened: false),
                "\(state) is not a server anyone can open yet")
        }
    }

    /// Quitting stops the household's server, so a `stop` that refuses must not be
    /// swallowed on the way out: the app stays, says why, and the quit item asks a second
    /// question — whose answer is the next click on it.
    func testAFailedStopTurnsQuitIntoAQuestionRatherThanAnExit() {
        XCTAssertEqual(Lifecycle.outcomeAfterStop(error: nil), .proceed)
        XCTAssertEqual(Lifecycle.outcomeAfterStop(error: "postgres would not shut down"),
                       .refused("postgres would not shut down"))

        XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: false), .confirmThenStop)
        XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: true),
                       .quitWithoutStopping,
                       "the changed menu item is the second confirmation")
    }

    /// The one case where "Quit anyway" is not a way out. Once Sparkle's installer has
    /// extracted and validated the new app it listens for this process to exit and finishes
    /// the swap whenever that happens, whatever the reason (`Autoupdate/AppInstaller.m`) —
    /// so quitting over a server that would not stop replaces Waffled.app, runtime bundle
    /// and all, under the old binaries still running it. The item says what has to happen
    /// first, and `Install the update now` stays the retry.
    ///
    /// It turns on the flow's phase rather than on an install block the app happens to be
    /// holding: `Install on Quit` and an abort after stage 1 both leave the app holding
    /// nothing while Sparkle is still armed.
    func testQuitWillNotHandAPreparedUpdateAServerThatIsStillRunning() {
        for phase in [UpdateFlow.Phase.armed(handler: nil),
                      .stoppingForInstall(handler: nil),
                      .restartQueued(handler: nil)] {
            XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: true, phase: phase),
                           .stopTheServerFirst, "\(phase) is an armed installer")
            XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: false, phase: phase),
                           .confirmThenStop,
                           "nothing refused: quit stops the server first, and that is what makes the swap safe")
        }

        XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: true, phase: .handedOff),
                       .quitWithoutStopping,
                       "the swap is already Sparkle's, and the server is already down")

        XCTAssertEqual(Lifecycle.QuitAction.confirmThenStop.title, "Quit Waffled")
        XCTAssertEqual(Lifecycle.QuitAction.quitWithoutStopping.title,
                       "Quit anyway (server keeps running)")
        XCTAssertEqual(Lifecycle.QuitAction.stopTheServerFirst.title,
                       "Quit — stop the server first (an update will install on quit)")
    }

    /// The relaunch waits for the stop, and a stop that refuses holds it back rather than
    /// pressing on — why, in `docs/product/native-mac-plan.md` Phase 3 item 6.
    func testTheUpdateRelaunchWaitsForTheServerToStop() {
        XCTAssertEqual(Lifecycle.outcomeAfterStop(error: nil), .proceed)
        XCTAssertEqual(Lifecycle.outcomeAfterStop(error: "postgres would not shut down"),
                       .refused("postgres would not shut down"),
                       "the swap would land on a server still running the old bundle")
    }

    /// The note is said once — but "once" has to mean *once there is something to say*.
    ///
    /// The two facts arrive on different polls after an update. `bundle.version` comes from
    /// the manifest and is there from the first status, while the server is still stopped;
    /// `previousVersion` is written by the runtime when it **starts** against the existing
    /// data, which on a relaunched app is the auto-start, several polls later. A latch spent
    /// on the first status that carried a version would therefore be spent on the one poll
    /// that could not possibly know about the crossing.
    func testThePollBeforeTheAutoStartDoesNotSpendTheUpdateNote() {
        var noted: String?

        // Poll 1: the new bundle, but nothing has started against the data yet.
        var line = Lifecycle.updateNote(previous: "", current: "0.15.0",
                                        changedAt: "", lastNoted: noted)
        XCTAssertNil(line)
        XCTAssertNil(noted, "nothing was said, so nothing is remembered")

        // The auto-start records the crossing; the next poll carries it.
        line = Lifecycle.updateNote(previous: "0.14.3", current: "0.15.0",
                                    changedAt: "2026-09-08T03:00:00Z", lastNoted: noted)
        XCTAssertEqual(line, "Updated to 0.15.0")
        noted = "2026-09-08T03:00:00Z"

        XCTAssertNil(Lifecycle.updateNote(previous: "0.14.3", current: "0.15.0",
                                          changedAt: "2026-09-08T03:00:00Z", lastNoted: noted),
                     "said once, not on every poll for the rest of the process")
    }

    /// And once for the life of the data directory, not once per launch. The crossing it
    /// describes is a permanent fact about that directory — `previousVersion` stays where
    /// it is until the next update — so the app remembers the moment it announced, and
    /// every later launch reads the same one and says nothing.
    func testACrossingIsAnnouncedOnceEvenAcrossLaunches() {
        XCTAssertNil(Lifecycle.updateNote(previous: "0.14.3", current: "0.15.0",
                                          changedAt: "2026-09-08T03:00:00Z",
                                          lastNoted: "2026-09-08T03:00:00Z"),
                     "this launch was not the one that updated")

        XCTAssertEqual(Lifecycle.updateNote(previous: "0.15.0", current: "0.15.1",
                                            changedAt: "2026-09-09T03:00:00Z",
                                            lastNoted: "2026-09-08T03:00:00Z"),
                       "Updated to 0.15.1",
                       "a different moment is a different crossing, and news again")
    }

    /// The icon is the only thing a person sees without opening the menu, so a failed
    /// stop — the one situation that needs a person — has to reach it, exactly as a
    /// failed start does.
    func testTheIconShowsAFailedStopAsWellAsAFailedStart() {
        XCTAssertEqual(Lifecycle.iconState(reported: .running, failure: nil, stopFailure: nil), .running)
        XCTAssertEqual(Lifecycle.iconState(reported: .stopped, failure: "start refused", stopFailure: nil), .unhealthy)
        XCTAssertEqual(Lifecycle.iconState(reported: .running, failure: nil, stopFailure: "postgres would not shut down"),
                       .unhealthy, "a server that would not stop is a fault the icon must show")
        XCTAssertEqual(Lifecycle.iconState(reported: nil, failure: nil, stopFailure: nil), .stopped)
    }

    /// A failed stop describes a server that is still running. Once a poll says it is
    /// not — someone stopped it from Terminal, or it fell over — the message is stale,
    /// and keeping it would show "Start Waffled" beside "Could not stop Waffled".
    func testAFailedStopIsForgottenOnceTheServerIsNoLongerRunning() {
        XCTAssertTrue(Lifecycle.stopFailureStillApplies(reported: .running))
        XCTAssertTrue(Lifecycle.stopFailureStillApplies(reported: .unhealthy),
                      "part of the stack is still up; the refusal still describes it")
        XCTAssertFalse(Lifecycle.stopFailureStillApplies(reported: .stopped))
        XCTAssertFalse(Lifecycle.stopFailureStillApplies(reported: .starting),
                       "a start after a failed stop is a new story")
    }

    /// The app holds two failures that are forgotten on opposite rules. A `start` that
    /// refused describes a server that is not there, so `stopped` does not disprove it and
    /// only `running` does. A poll that could not reach the runtime describes that poll
    /// alone — the next one that answers has disproved it, whatever it answers.
    func testAPollThatAnswersClearsItsOwnErrorButNotARefusedStart() {
        let refused = "port 8080 is in use"

        XCTAssertEqual(
            Lifecycle.failuresAfterPoll(reported: .stopped, startFailure: refused, transportError: nil),
            .init(start: refused, poll: nil),
            "a refused start leaves nothing running, so `stopped` is what it predicted")
        XCTAssertEqual(
            Lifecycle.failuresAfterPoll(reported: .running, startFailure: refused, transportError: nil),
            .init(start: nil, poll: nil))
        XCTAssertEqual(
            Lifecycle.failuresAfterPoll(reported: nil, startFailure: refused,
                                        transportError: "the runtime did not answer"),
            .init(start: refused, poll: "the runtime did not answer"))
    }

    /// Two slots, one status line: whichever exists, with the refusal a person provoked
    /// ahead of the transport error underneath it.
    func testTheHeldSentenceIsWhicheverFailureExists() {
        XCTAssertEqual(Lifecycle.HeldFailures(start: "port 8080 is in use", poll: "no answer").message,
                       "port 8080 is in use")
        XCTAssertEqual(Lifecycle.HeldFailures(start: nil, poll: "no answer").message, "no answer")
        XCTAssertNil(Lifecycle.HeldFailures().message)
    }

    /// The setting-up step has a floor under it: a first start here took under five
    /// seconds, and a checklist that appears and vanishes is a window that "never showed".
    func testTheSettingUpDisplayHasAFloorUnderIt() {
        let clicked = Date()
        XCTAssertFalse(Lifecycle.startingDisplayHasElapsed(
            since: clicked, now: clicked.addingTimeInterval(1)))
        XCTAssertTrue(Lifecycle.startingDisplayHasElapsed(
            since: clicked,
            now: clicked.addingTimeInterval(FirstRunPresentation.minimumStartingDisplay)))

        XCTAssertTrue(Lifecycle.startingDisplayHasElapsed(since: nil, now: clicked),
                      "a start nobody clicked has no floor to wait out")
    }

    /// Polling is cheap but not free (it spawns a process), so it slows down once the
    /// answer stops changing.
    func testPollingIsFasterWhileSomethingIsHappening() {
        XCTAssertEqual(Lifecycle.pollInterval(for: .starting), 1)
        XCTAssertEqual(Lifecycle.pollInterval(for: .running), 2)
        XCTAssertEqual(Lifecycle.pollInterval(for: .stopped), 2)
        XCTAssertEqual(Lifecycle.pollInterval(for: .unhealthy), 2)
        XCTAssertEqual(Lifecycle.pollInterval(for: nil), 2)
    }
}

/// Dev mode is how this app is run before anything is embedded, so its precedence is
/// worth pinning down.
final class RuntimeLocatorTests: XCTestCase {
    private let resources = URL(fileURLWithPath: "/Applications/Waffled.app/Contents/Resources")

    func testProductionLooksInsideTheAppBundle() throws {
        let l = try XCTUnwrap(RuntimeLocator.locate(environment: [:], resourceURL: resources))

        XCTAssertEqual(l.binary.path,
                       "/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime")
        XCTAssertEqual(l.bundleDir?.path,
                       "/Applications/Waffled.app/Contents/Resources/runtime")
        XCTAssertNil(l.dataDir, "production uses the runtime's own default data directory")
        XCTAssertFalse(l.isDevMode)
    }

    func testDevModeOverridesAllThree() throws {
        let env = [
            "WAFFLED_RUNTIME_BIN": "/tmp/bin/waffled-runtime",
            "WAFFLED_RUNTIME_BUNDLE": "/tmp/runtime",
            "WAFFLED_DATA_DIR": "/tmp/mac-data",
        ]
        let l = try XCTUnwrap(RuntimeLocator.locate(environment: env, resourceURL: resources))

        XCTAssertEqual(l.binary.path, "/tmp/bin/waffled-runtime")
        XCTAssertEqual(l.bundleDir?.path, "/tmp/runtime")
        XCTAssertEqual(l.dataDir?.path, "/tmp/mac-data")
        XCTAssertTrue(l.isDevMode)
    }

    /// The data directory is the optional one: a dev run against the real default is a
    /// legitimate thing to want, even though this repo's agents must never do it.
    func testDevModeDataDirectoryIsOptional() throws {
        let env = [
            "WAFFLED_RUNTIME_BIN": "/tmp/bin/waffled-runtime",
            "WAFFLED_RUNTIME_BUNDLE": "/tmp/runtime",
        ]
        let l = try XCTUnwrap(RuntimeLocator.locate(environment: env, resourceURL: resources))

        XCTAssertEqual(l.binary.path, "/tmp/bin/waffled-runtime")
        XCTAssertNil(l.dataDir)
        XCTAssertTrue(l.isDevMode)
    }

    /// The embedded runtime with only the data directory pointed elsewhere: how CI's smoke
    /// boot runs the assembled app, and how anyone tries a build without letting it touch
    /// the household's real data. It is **not** dev mode — the app is running the runtime
    /// it shipped with, which is the only thing dev mode is about.
    func testDataDirectoryOverridesTheEmbeddedRuntimeWithoutDevMode() throws {
        let env = ["WAFFLED_DATA_DIR": "/tmp/mac-data"]

        let l = try XCTUnwrap(RuntimeLocator.locate(environment: env, resourceURL: resources))

        XCTAssertEqual(l.binary.path,
                       "/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime")
        XCTAssertEqual(l.bundleDir?.path,
                       "/Applications/Waffled.app/Contents/Resources/runtime")
        XCTAssertEqual(l.dataDir?.path, "/tmp/mac-data")
        XCTAssertFalse(l.isDevMode, "an embedded runtime is not a dev runtime, wherever its data lives")
    }

    /// An empty value is not an override. `--data ""` is not the same as omitting the flag,
    /// and the runtime's own default is the right answer for both.
    func testEmptyDataDirectoryIsNotAnOverride() throws {
        let l = try XCTUnwrap(RuntimeLocator.locate(environment: ["WAFFLED_DATA_DIR": ""],
                                                    resourceURL: resources))

        XCTAssertNil(l.dataDir)
    }

    /// Nothing embedded yet and no dev envs set: there is no runtime to talk to, and the
    /// menu has to say so rather than report a stopped server.
    func testNoBundleAndNoEnvironmentLocatesNothing() {
        XCTAssertNil(RuntimeLocator.locate(environment: [:], resourceURL: nil))
    }
}
