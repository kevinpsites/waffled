import XCTest
@testable import Waffled

/// The first-run window is a value: which of the five steps, in what words, with which
/// buttons. Nothing here shows a window, and the window itself renders this and does
/// nothing else.
final class FirstRunPresentationTests: XCTestCase {

    private func status(_ json: String) throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(json))
    }

    /// The window exists for exactly one launch in a household's life. Every other one —
    /// the relaunch at login, the menu someone opened to copy the address — gets nothing.
    func testAnInitializedDataDirectoryShowsNoWindowAtAll() throws {
        let running = try status(Fixtures.fullRunning)

        XCTAssertNil(FirstRunPresentation.make(status: running, isFirstRun: false, setupBegun: false))
        XCTAssertNil(FirstRunPresentation.make(status: running, isFirstRun: false, setupBegun: true))
        XCTAssertNil(FirstRunPresentation.make(status: nil, isFirstRun: false, setupBegun: false,
                                               failure: "the runtime would not run"),
                     "an error on a set-up Mac belongs in the menu, not in a setup window")
    }

    /// The steps, in the order a first run walks through them.
    func testTheStepsFollowTheSetup() throws {
        let fresh = try status(Fixtures.freshDataDirectory)
        let starting = try status(Fixtures.firstStartInProgress)
        let running = try status(Fixtures.fullRunning)

        XCTAssertEqual(FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: false)?.step,
                       .welcome)
        XCTAssertEqual(FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: true)?.step,
                       .starting)
        XCTAssertEqual(FirstRunPresentation.make(status: running, isFirstRun: true, setupBegun: true)?.step,
                       .ready)
        XCTAssertEqual(FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: true,
                                                 failure: "postgres would not start")?.step,
                       .failed)

        // Before the first poll answers there is nothing to say beyond the welcome, which
        // is the step that is waiting for a person anyway.
        XCTAssertEqual(FirstRunPresentation.make(status: nil, isFirstRun: true, setupBegun: false)?.step,
                       .welcome)
        XCTAssertEqual(FirstRunPresentation.make(status: nil, isFirstRun: true, setupBegun: true)?.step,
                       .starting)
    }

    /// The welcome step waits for a server that nothing has started. Someone who runs
    /// `waffled-runtime start` in Terminal while it is on screen gets the progress list,
    /// not a button offering to do what is already happening.
    func testAStartFromAnywhereElseMovesThePersonOnFromTheWelcome() throws {
        let starting = try status(Fixtures.firstStartInProgress)
        XCTAssertEqual(FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: false)?.step,
                       .starting)

        let running = try status(Fixtures.fullRunning)
        XCTAssertEqual(FirstRunPresentation.make(status: running, isFirstRun: true, setupBegun: false)?.step,
                       .ready)
    }

    /// A held failure outranks the step it interrupted, at any point — including before
    /// anyone has clicked, which is what a runtime that could not be located looks like.
    func testAFailureOutranksEveryOtherStep() throws {
        let fresh = try status(Fixtures.freshDataDirectory)

        for begun in [false, true] {
            let p = FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: begun,
                                              failure: "No Waffled runtime is bundled with this build")
            XCTAssertEqual(p?.step, .failed)
            XCTAssertEqual(p?.message, "No Waffled runtime is bundled with this build",
                           "the runtime's own sentence, not one invented here")
            XCTAssertEqual(p?.primaryButton, "Try again")
            XCTAssertEqual(p?.tertiaryButton, "Show logs")
        }
    }

    /// A first start that came up and then fell over is not "still starting": the checklist
    /// would sit there for the rest of the launch while the menu already said what was
    /// wrong. Both surfaces show the runtime's sentence, from one helper.
    func testAStackThatFellOverDuringAFirstRunOffersTheWayOut() throws {
        var unhealthy = try status(Fixtures.firstStartInProgress)
        unhealthy.state = .unhealthy
        unhealthy.lastError = "powersync exited: replication slot is gone\nsee the logs"

        let p = try XCTUnwrap(FirstRunPresentation.make(status: unhealthy, isFirstRun: true,
                                                        setupBegun: true))
        XCTAssertEqual(p.step, .failed)
        XCTAssertEqual(p.message, "powersync exited: replication slot is gone")
        XCTAssertEqual(p.primaryButton, "Try again")
        XCTAssertEqual(p.tertiaryButton, "Show logs")
        XCTAssertEqual(MenuPresentation.make(status: unhealthy).statusLine, p.message,
                       "one sentence, derived once, wherever it is shown")

        var silent = unhealthy
        silent.lastError = ""
        XCTAssertEqual(FirstRunPresentation.make(status: silent, isFirstRun: true, setupBegun: true)?.message,
                       "Waffled needs attention",
                       "and one fallback when the runtime gave us no words of its own")
        XCTAssertEqual(MenuPresentation.make(status: silent).statusLine, "Waffled needs attention")

        XCTAssertEqual(FirstRunPresentation.make(status: unhealthy, isFirstRun: true, setupBegun: true,
                                                 busy: true)?.step,
                       .starting,
                       "a service still coming up under a start in flight is not the end of it")
    }

    /// `Try again` does nothing while a start is still in flight — `startServer` refuses a
    /// second one, and `start` has no timeout — so a `status` that failed mid-start must not
    /// put the window on an error step whose only button is inert.
    func testAFailureWhileAStartIsInFlightStaysOnTheProgressStep() throws {
        let starting = try status(Fixtures.firstStartInProgress)

        let inFlight = FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: true,
                                                 failure: "the runtime did not answer", busy: true)
        XCTAssertEqual(inFlight?.step, .starting)
        XCTAssertNil(inFlight?.primaryButton)

        XCTAssertEqual(FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: true,
                                                 failure: "the runtime did not answer", busy: false)?.step,
                       .failed,
                       "with nothing in flight the button works again, and the error is the window")
    }

    /// The welcome step is the only one with a button that creates anything, and the only
    /// one whose close box means "no thank you" — nothing exists yet to leave behind.
    func testOnlyTheWelcomeStepOffersToStartAndOnlyItsCloseQuits() throws {
        let fresh = try status(Fixtures.freshDataDirectory)
        let welcome = FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: false)

        XCTAssertEqual(welcome?.primaryButton, "Set up Waffled")
        XCTAssertEqual(welcome?.secondaryButton, "Not on this Mac",
                       "the close box's meaning, said out loud")
        XCTAssertTrue(welcome?.closeQuitsApp ?? false)

        // Once the server is on its way up, the window is only a window: closing it
        // stops nothing, and the menu carries on showing the same progress.
        let starting = try status(Fixtures.firstStartInProgress)
        let progress = FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: true)
        XCTAssertNil(progress?.primaryButton)
        XCTAssertFalse(progress?.closeQuitsApp ?? true)
    }

    /// The progress list is the runtime's own service names in the words a household
    /// would use, ticked as each one comes up.
    func testTheProgressListRenamesTheServicesAndTicksWhatIsUp() throws {
        let starting = try status(Fixtures.firstStartInProgress)
        let p = try XCTUnwrap(FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: true))

        XCTAssertEqual(p.services.map(\.label), ["Postgres", "API", "Sync", "Web"])
        XCTAssertEqual(p.services.map(\.isReady), [true, false, false, false])
        XCTAssertEqual(p.services.map(\.detail),
                       ["Database ready", "Starting the Waffled server",
                        "Getting phones and tablets ready to sync", "Opening Waffled on your network"],
                       "present-tense while it is coming, done-tense once it is there")
        XCTAssertEqual(p.progress, 0.25)

        // Nothing is up yet on the welcome step, and the ready step is a goodbye rather
        // than a screen — neither needs the list.
        let fresh = try status(Fixtures.freshDataDirectory)
        XCTAssertEqual(FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: false)?.services,
                       [])
        let running = try status(Fixtures.fullRunning)
        XCTAssertEqual(FirstRunPresentation.make(status: running, isFirstRun: true, setupBegun: true)?.services,
                       [])
    }

    /// The runtime adds services without asking, and its advisory ones (the Bonjour
    /// advertiser) are not something a household can act on while the kettle boils. A row
    /// appears only for a name this table has words for.
    func testAServiceWithNoFriendlyNameIsNotShown() throws {
        var starting = try status(Fixtures.firstStartInProgress)
        starting.services.append(RuntimeStatus.Service(name: "gizmo", state: .running))

        let p = try XCTUnwrap(FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: true))
        XCTAssertEqual(p.services.map(\.label), ["Postgres", "API", "Sync", "Web"])
    }

    /// "Your server is ready" is a screen a person acts on — the address they came for,
    /// and the click that opens it — not a sentence that takes itself away.
    func testTheReadyStepIsAScreenAPersonActsOn() throws {
        let running = try status(Fixtures.fullRunning)
        let ready = try XCTUnwrap(FirstRunPresentation.make(status: running, isFirstRun: true,
                                                            setupBegun: true))

        XCTAssertEqual(ready.step, .ready)
        XCTAssertEqual(ready.primaryButton, "Open Waffled")
        XCTAssertEqual(ready.secondaryButton, "Copy address")
        XCTAssertEqual(ready.address?.host, "192.168.1.5:8080")
        XCTAssertEqual(ready.address?.url, "http://192.168.1.5:8080")
        XCTAssertNotNil(ready.menuBarNote)
        XCTAssertFalse(ready.closeQuitsApp, "the server is up; closing this stops nothing")
    }

    /// The runtime beat the window: a first start here took under five seconds, and a
    /// checklist that appears and vanishes is what "nothing showed" was reported about.
    func testTheSettingUpStepStaysUpForItsMinimum() throws {
        let running = try status(Fixtures.fullRunning)
        let clicked = Date()

        let early = try XCTUnwrap(FirstRunPresentation.make(
            status: running, isFirstRun: true, setupBegun: true,
            setupStartedAt: clicked, now: clicked.addingTimeInterval(1)))
        XCTAssertEqual(early.step, .starting, "a start that beat the floor keeps the checklist up")
        XCTAssertEqual(early.progress, 1, "every row it knows about is ticked by then")

        let late = try XCTUnwrap(FirstRunPresentation.make(
            status: running, isFirstRun: true, setupBegun: true,
            setupStartedAt: clicked,
            now: clicked.addingTimeInterval(FirstRunPresentation.minimumStartingDisplay)))
        XCTAssertEqual(late.step, .ready)
    }

    /// A launch that finds a server someone else started has no click to measure from,
    /// and must not sit on a checklist waiting for a floor nobody is under.
    func testAStartNobodyClickedGoesStraightToReady() throws {
        let running = try status(Fixtures.fullRunning)
        let p = try XCTUnwrap(FirstRunPresentation.make(status: running, isFirstRun: true,
                                                        setupBegun: false, setupStartedAt: nil))
        XCTAssertEqual(p.step, .ready)
    }

    /// The port a household asked for and the port Caddy took can differ, and the runtime
    /// falls forward rather than failing — so the ready step says so, once, quietly.
    func testTheReadyStepSaysWhenThePortMoved() throws {
        let running = try status(Fixtures.fullRunning)

        let moved = FirstRunPresentation.addressCard(running, preferredPort: 8000)
        XCTAssertEqual(moved?.portNote, "Using port 8080 because 8000 was busy on this Mac.")

        let asAsked = FirstRunPresentation.addressCard(running, preferredPort: 8080)
        XCTAssertNil(asAsked?.portNote, "the port that was asked for is not news")
    }

    /// The IP line is the runtime's own answer, and it is only worth a line when it says
    /// something the address above it does not.
    func testTheAlternateAddressIsOnlyShownWhenItIsDifferent() throws {
        let named = try status(Fixtures.readyOnAName)
        XCTAssertEqual(FirstRunPresentation.addressCard(named, preferredPort: 8080)?.host,
                       "kevins-mac-mini.local:8080")
        XCTAssertEqual(FirstRunPresentation.addressCard(named, preferredPort: 8080)?.alternate,
                       "192.168.1.5:8080")

        let onAnIP = try status(Fixtures.fullRunning)
        XCTAssertNil(FirstRunPresentation.addressCard(onAnIP, preferredPort: 8080)?.alternate,
                     "the same address twice is not an alternative")
    }

    /// The welcome step lists what is really in this bundle, from the runtime's manifest —
    /// which `status` answers with every service stopped, so the numbers are real on the
    /// one screen shown before anything has ever run.
    func testTheWelcomeStepListsTheVersionsThatReallyShipped() throws {
        let fresh = try status(Fixtures.freshDataDirectory)
        let welcome = try XCTUnwrap(FirstRunPresentation.make(status: fresh, isFirstRun: true,
                                                              setupBegun: false))
        XCTAssertEqual(welcome.components.map(\.name),
                       ["Postgres", "Waffled server", "Sync", "Web"])
        XCTAssertEqual(welcome.components.map(\.version).filter { !$0.isEmpty }.count, 4,
                       "every row carries the version from the bundle manifest")
        XCTAssertEqual(welcome.promises.count, 3)
        XCTAssertEqual(welcome.tertiaryButton, "Choose where things go…")
        XCTAssertEqual(welcome.secondaryButton, "Not on this Mac")
        XCTAssertTrue(welcome.closeQuitsApp)
    }

    /// The options step is still a person deciding whether Waffled belongs on this Mac:
    /// nothing has been created, so closing it means the same thing the welcome does.
    func testTheOptionsStepIsReachedBeforeAnythingExists() throws {
        let fresh = try status(Fixtures.freshDataDirectory)
        let options = try XCTUnwrap(FirstRunPresentation.make(status: fresh, isFirstRun: true,
                                                              setupBegun: false, showingOptions: true))
        XCTAssertEqual(options.step, .options)
        XCTAssertEqual(options.title, "Where things go")
        XCTAssertEqual(options.primaryButton, "Set up Waffled")
        XCTAssertEqual(options.tertiaryButton, "Back")
        XCTAssertTrue(options.closeQuitsApp)

        // Once something is coming up, the options screen is no longer a thing to show:
        // every setting on it is applied before the start it is now behind.
        let starting = try status(Fixtures.firstStartInProgress)
        XCTAssertEqual(FirstRunPresentation.make(status: starting, isFirstRun: true,
                                                 setupBegun: true, showingOptions: true)?.step,
                       .starting)
    }

    /// The clock is a reassurance that something is happening, not a countdown that could
    /// be wrong.
    func testTheElapsedClockCountsWholeUnits() {
        let start = Date()
        XCTAssertEqual(FirstRunPresentation.elapsedLabel(since: start, now: start), "0 seconds")
        XCTAssertEqual(FirstRunPresentation.elapsedLabel(since: start,
                                                         now: start.addingTimeInterval(1)), "1 second")
        XCTAssertEqual(FirstRunPresentation.elapsedLabel(since: start,
                                                         now: start.addingTimeInterval(45)), "45 seconds")
        XCTAssertEqual(FirstRunPresentation.elapsedLabel(since: start,
                                                         now: start.addingTimeInterval(60)), "1 minute")
        XCTAssertEqual(FirstRunPresentation.elapsedLabel(since: start,
                                                         now: start.addingTimeInterval(81)),
                       "1 minute 21 seconds")
        XCTAssertEqual(FirstRunPresentation.elapsedLabel(since: start,
                                                         now: start.addingTimeInterval(-5)), "0 seconds",
                       "a clock that went backwards is not a negative duration")
    }

    /// A laptop is a server that goes off the network when a lid closes (plan §5). It is
    /// said once, plainly, on the step where a person can still choose a different Mac —
    /// and never again after that, because by then it would only be nagging.
    func testTheLaptopWarningAppearsOnceOnTheWelcomeStep() throws {
        let fresh = try status(Fixtures.freshDataDirectory)

        let onALaptop = FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: false,
                                                  isPortable: true)
        let note = try XCTUnwrap(onALaptop?.portableNote)
        XCTAssertTrue(note.contains("lid"), "the warning has to name what actually happens")
        XCTAssertEqual(onALaptop?.primaryButton, "Set up Waffled",
                       "a warning, not a refusal — setting up here still works")

        XCTAssertNil(FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: false,
                                               isPortable: false)?.portableNote)

        let starting = try status(Fixtures.firstStartInProgress)
        XCTAssertNil(FirstRunPresentation.make(status: starting, isFirstRun: true, setupBegun: true,
                                               isPortable: true)?.portableNote,
                     "the choice has been made; repeating it is nagging")
    }

    /// The copy is the product's voice (docs/product/brand.md): plain, warm, and honest
    /// about where the data lives. It is asserted loosely — the shape of the promise, not
    /// the sentence — so it can be edited without a test edit.
    func testTheWelcomeSaysWhereTheDataStays() throws {
        let fresh = try status(Fixtures.freshDataDirectory)
        let welcome = try XCTUnwrap(FirstRunPresentation.make(status: fresh, isFirstRun: true,
                                                              setupBegun: false))

        XCTAssertTrue(welcome.title.contains("Waffled"))
        XCTAssertTrue(welcome.message.contains("this Mac"))
        XCTAssertTrue(welcome.message.lowercased().contains("network"))
    }
}
