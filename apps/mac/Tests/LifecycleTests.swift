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

    /// Finding a server already running is a relaunch, not a first start: it re-opens the
    /// existing server (plan §2 step 6) without stealing the screen.
    func testBrowserOpensOnlyForAStartThisAppInitiated() {
        XCTAssertTrue(Lifecycle.shouldOpenBrowser(
            newState: .running, startWasAppInitiated: true, alreadyOpened: false))

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, startWasAppInitiated: false, alreadyOpened: false),
            "already running when we launched — do not steal the screen")

        XCTAssertFalse(Lifecycle.shouldOpenBrowser(
            newState: .running, startWasAppInitiated: true, alreadyOpened: true),
            "once per process, not once per poll")

        for state in [RuntimeState.stopped, .starting, .unhealthy] {
            XCTAssertFalse(Lifecycle.shouldOpenBrowser(
                newState: state, startWasAppInitiated: true, alreadyOpened: false))
        }
    }

    /// Quitting stops the household's server, so a `stop` that refuses must not be
    /// swallowed on the way out: the app stays, says why, and the quit item asks a second
    /// question — whose answer is the next click on it.
    func testAFailedStopTurnsQuitIntoAQuestionRatherThanAnExit() {
        XCTAssertEqual(Lifecycle.outcomeAfterStop(error: nil), .terminate)
        XCTAssertEqual(Lifecycle.outcomeAfterStop(error: "postgres would not shut down"),
                       .report("postgres would not shut down"))

        XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: false), .confirmThenStop)
        XCTAssertEqual(Lifecycle.quitAction(stopHasFailed: true), .quitWithoutStopping,
                       "the changed menu item is the second confirmation")
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
