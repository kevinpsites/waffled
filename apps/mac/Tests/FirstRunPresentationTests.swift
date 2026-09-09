import XCTest
@testable import Waffled

/// The first-run window is a value: which of the four steps, in what words, with which
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

    /// The four steps, in the order a first run walks through them.
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
            XCTAssertEqual(p?.secondaryButton, "Show logs")
        }
    }

    /// The welcome step is the only one with a button that creates anything, and the only
    /// one whose close box means "no thank you" — nothing exists yet to leave behind.
    func testOnlyTheWelcomeStepOffersToStartAndOnlyItsCloseQuits() throws {
        let fresh = try status(Fixtures.freshDataDirectory)
        let welcome = FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: false)

        XCTAssertEqual(welcome?.primaryButton, "Set up Waffled")
        XCTAssertNil(welcome?.secondaryButton)
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
        XCTAssertEqual(p.message, "First start takes about a minute.")

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

    /// "Your server is ready" is a sentence, not a screen: the browser is already opening
    /// behind it, so the window takes itself away.
    func testTheReadyStepClosesItself() throws {
        let running = try status(Fixtures.fullRunning)
        let ready = try XCTUnwrap(FirstRunPresentation.make(status: running, isFirstRun: true, setupBegun: true))

        XCTAssertEqual(ready.closesAfter, 2)
        XCTAssertNil(ready.primaryButton, "there is nothing left to do")

        let fresh = try status(Fixtures.freshDataDirectory)
        XCTAssertNil(FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: false)?.closesAfter,
                     "a window waiting for a person must not close itself")
        XCTAssertNil(FirstRunPresentation.make(status: fresh, isFirstRun: true, setupBegun: true,
                                               failure: "boom")?.closesAfter)
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
