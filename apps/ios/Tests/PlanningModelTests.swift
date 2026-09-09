import Foundation
import Testing
@testable import Waffled

// Weekly Planning — the session shell's model, driven against a fake feed (same shape as
// `FamilyNightModelTests`). It locks the loading contract, a crumb that must not follow you
// onto the next step, and "Leave for now" actually leaving.

private enum PlanningCallFailure: Error { case rejected }

// MARK: - Fixtures

private func handoff(_ id: String, _ note: String, byline: String? = nil) -> WaffledAPI.PlanningStepHandoff {
    WaffledAPI.PlanningStepHandoff(id: id, note: note, byline: byline)
}

/// One catalog step. `number` is the CATALOG index the server sends (1-based over all
/// ten), deliberately not the runnable position — the model computes that itself.
private func step(
    _ key: String,
    number: Int,
    act: String = "Frame the week",
    title: String? = nil,
    requiresModule: String? = nil,
    available: Bool = true,
    status: String = "pending",
    parked: [WaffledAPI.PlanningStepHandoff]? = []
) -> WaffledAPI.PlanningStep {
    WaffledAPI.PlanningStep(
        key: key,
        number: number,
        title: title ?? key.capitalized,
        ask: "What about \(key)?",
        primary: "Done",
        act: act,
        requiresModule: requiresModule,
        available: available,
        status: status,
        data: [:],
        decidedAt: nil,
        parked: parked)
}

private func session(
    id: String = "session-1",
    weekStart: String = "2026-09-06",
    status: String = "active",
    currentStep: String? = "looseEnds",
    completedAt: String? = nil
) -> WaffledAPI.PlanningSession {
    WaffledAPI.PlanningSession(
        id: id,
        weekStart: weekStart,
        status: status,
        currentStep: currentStep,
        driverPersonId: nil,
        startedAt: "2026-09-06T17:00:00.000Z",
        completedAt: completedAt)
}

private func defaultSteps() -> [WaffledAPI.PlanningStep] {
    [
        step("looseEnds", number: 1, act: "Intake"),
        step("calendar", number: 2, act: "Frame the week"),
        step("meals", number: 3, act: "Run the household", requiresModule: "meals", available: false),
        step("recap", number: 4, act: "Close"),
    ]
}

// MARK: - The feed

@MainActor
private final class PlanningFeed {
    var steps: [WaffledAPI.PlanningStep] = defaultSteps()
    var currentSession: WaffledAPI.PlanningSession?
    var weekStart = "2026-09-06"
    var defaultWeekStart = "2026-09-06"
    var minWeekStart = "2026-08-30"
    var config = WaffledAPI.WeeklyPlanningConfig(
        dayOfWeek: 0, time: "17:00", steps: [:], showOnToday: true)

    var fetchFails = false
    var decideFails = false

    var fetchCount = 0
    var fetchedWeeks: [String?] = []
    var starts: [String?] = []
    var patches: [(id: String, currentStep: String?, status: String?)] = []
    var decisions: [(sessionId: String, stepKey: String, status: String, data: [String: JSONValue]?)] = []
    var completes: [String] = []
    var discards: [String] = []
    var resolves: [(kind: String, id: String, action: String, sessionId: String?)] = []
    var configSaves: [(dayOfWeek: Int?, time: String?, showOnToday: Bool?, steps: [String: Bool]?, lists: [String: Bool]?)] = []
    var listCandidates: [WaffledAPI.PlanningListCandidate] = [
        .init(id: "l1", name: "Repairs", emoji: "🔧", relevant: true),
        .init(id: "l2", name: "Someday", emoji: "💭", relevant: true),
    ]

    init(session: WaffledAPI.PlanningSession? = nil) {
        currentSession = session
    }

    var snapshot: WaffledAPI.WeeklyPlanningView {
        WaffledAPI.WeeklyPlanningView(
            config: config,
            weekStart: weekStart,
            defaultWeekStart: defaultWeekStart,
            minWeekStart: minWeekStart,
            session: currentSession,
            steps: steps)
    }

    func setStatus(_ key: String, _ status: String) {
        steps = steps.map { s in
            guard s.key == key else { return s }
            return WaffledAPI.PlanningStep(
                key: s.key, number: s.number, title: s.title, ask: s.ask, primary: s.primary,
                act: s.act, requiresModule: s.requiresModule, available: s.available,
                status: status, data: s.data, decidedAt: "2026-09-06T17:05:00.000Z", parked: s.parked)
        }
    }
}

@MainActor
private func makeModel(_ feed: PlanningFeed, defaults: UserDefaults) -> PlanningModel {
    PlanningModel(
        fetchView: { week in
            feed.fetchCount += 1
            feed.fetchedWeeks.append(week)
            if feed.fetchFails { throw PlanningCallFailure.rejected }
            return feed.snapshot
        },
        fetchConfig: {
            WaffledAPI.WeeklyPlanningConfigView(
                config: feed.config, steps: [], lists: feed.listCandidates)
        },
        saveConfig: { dayOfWeek, time, showOnToday, steps, lists in
            feed.configSaves.append((dayOfWeek, time, showOnToday, steps, lists))
            return feed.config
        },
        startSession: { week in
            feed.starts.append(week)
            let started = session(weekStart: week ?? feed.defaultWeekStart)
            feed.currentSession = started
            return started
        },
        patchSession: { id, currentStep, status in
            feed.patches.append((id, currentStep, status))
            let updated = session(
                id: id,
                weekStart: feed.weekStart,
                status: status ?? feed.currentSession?.status ?? "active",
                currentStep: currentStep ?? feed.currentSession?.currentStep,
                completedAt: feed.currentSession?.completedAt)
            feed.currentSession = updated
            return updated
        },
        decideStep: { sessionId, stepKey, status, data in
            feed.decisions.append((sessionId, stepKey, status, data))
            if feed.decideFails { throw PlanningCallFailure.rejected }
            feed.setStatus(stepKey, status)
            return feed.steps
        },
        completeSession: { id in
            feed.completes.append(id)
            let done = session(
                id: id, weekStart: feed.weekStart, status: "completed",
                currentStep: feed.currentSession?.currentStep,
                completedAt: "2026-09-06T17:32:00.000Z")
            feed.currentSession = done
            return WaffledAPI.WeeklyPlanningCompletion(session: done, steps: feed.steps)
        },
        discardSession: { id in
            feed.discards.append(id)
            feed.currentSession = nil
        },
        resolveLooseEnd: { kind, id, action, sessionId in
            feed.resolves.append((kind, id, action, sessionId))
        },
        defaults: defaults)
}

/// A `UserDefaults` nobody else writes — the pause intent is a real persisted key, and a
/// test that used `.standard` would leak it into the simulator and into the next test.
@MainActor
private func scratchDefaults() -> UserDefaults {
    let name = "waffled.planning.tests.\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}

// MARK: - Tests

@MainActor
@Suite struct PlanningModelTests {

    // MARK: loading

    @Test func failedRefreshKeepsTheLastGoodViewAndStaysLoaded() async {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        #expect(model.runnable.count == 3)

        feed.fetchFails = true
        await model.load()

        #expect(model.loaded)
        #expect(model.runnable.count == 3)
        #expect(model.view?.weekStart == "2026-09-06")
    }

    @Test func aFirstFetchThatFailsStillCountsAsLoaded() async {
        let feed = PlanningFeed()
        feed.fetchFails = true
        let model = makeModel(feed, defaults: scratchDefaults())

        await model.load()

        #expect(model.loaded)
        #expect(model.view == nil)
    }

    @Test func theCounterSkipsAStepWhoseModuleIsOff() async {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        #expect(model.stepNumbers["looseEnds"] == 1)
        #expect(model.stepNumbers["calendar"] == 2)
        #expect(model.stepNumbers["meals"] == nil)
        #expect(model.stepNumbers["recap"] == 3)
        #expect(model.runnable.count == 3)
    }

    @Test func actsGroupInCatalogOrder() async {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        #expect(model.actGroups.map(\.act) == ["Intake", "Frame the week", "Close"])
    }

    // MARK: starting

    @Test func startingAsksForTheWeekOnScreenAndLandsOnTheSessionPointer() async {
        let feed = PlanningFeed()
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        await model.start()

        #expect(feed.starts == ["2026-09-06"])
        #expect(model.askedStep == "looseEnds")
        #expect(model.session?.id == "session-1")
    }

    // MARK: answering

    @Test func answeringSendsTheCrumbThenMovesTheSessionPointerOn() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        model.setDecisionData(["autofilled": .int(3)])

        await model.answer("done")

        let decision = try #require(feed.decisions.first)
        #expect(feed.decisions.count == 1)
        #expect(decision.sessionId == "session-1")
        #expect(decision.stepKey == "looseEnds")
        #expect(decision.status == "done")
        #expect(decision.data == ["autofilled": .int(3)])

        let patch = try #require(feed.patches.first)
        #expect(patch.currentStep == "calendar")
        #expect(patch.status == nil)
        #expect(model.askedStep == "calendar")
        #expect(feed.completes.isEmpty)
    }

    @Test func skippingIsARealAnswer() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        await model.answer("skipped")

        #expect(try #require(feed.decisions.first).status == "skipped")
        #expect(model.askedStep == "calendar")
    }

    @Test func aCrumbIsNotCarriedOntoTheNextStepsAnswer() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        model.setDecisionData(["autofilled": .int(3)])

        await model.answer("done")   // looseEnds → calendar
        await model.answer("done")   // calendar, with no crumb of its own

        #expect(feed.decisions.count == 2)
        #expect(feed.decisions[1].stepKey == "calendar")
        #expect(feed.decisions[1].data == nil)
    }

    @Test func aCrumbSetOnOneStepIsIgnoredOnceAnotherIsOnScreen() async {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        model.setDecisionData(["autofilled": .int(3)])

        await model.jump(to: "calendar")

        #expect(model.crumbForCurrentStep == nil)
    }

    @Test func answeringTheLastStepCompletesInsteadOfPatching() async {
        let feed = PlanningFeed(session: session(currentStep: "recap"))
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        #expect(model.current?.key == "recap")

        await model.answer("done")

        #expect(feed.completes == ["session-1"])
        #expect(feed.patches.isEmpty)
        #expect(model.askedStep == nil)
        #expect(model.showsRecord)
        #expect(model.savedAtLabel != nil)
    }

    // MARK: the record yields to a step you ask for by name

    @Test func askingForAStepByNameLeavesTheRecord() async {
        let feed = PlanningFeed(session: session(status: "completed",
                                                 completedAt: "2026-09-04T21:50:00.000Z"))
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        #expect(model.showsRecord)

        model.show("calendar")

        #expect(model.showsRecord == false)
        #expect(model.current?.key == "calendar")
        #expect(feed.patches.isEmpty)
    }

    @Test func aPointerAtAStepThatCannotRunKeepsYouOnTheRecord() async {
        // Asking for an unavailable step must NOT leave the record: `resolveCurrent` would fall
        // back to the first runnable step, which is indistinguishable from losing your place.
        let feed = PlanningFeed(session: session(status: "completed",
                                                 completedAt: "2026-09-04T21:50:00.000Z"))
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        model.show("meals")

        #expect(model.showsRecord)
    }

    @Test func leavingPutsYouBackOnTheRecordRatherThanThePausedScreen() async {
        let feed = PlanningFeed(session: session(status: "completed",
                                                 completedAt: "2026-09-04T21:50:00.000Z"))
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        model.show("calendar")
        #expect(model.showsRecord == false)

        model.leave()

        // `isPaused` must NOT win here: it requires an ACTIVE session, and this one is finished.
        #expect(model.showsRecord)
        #expect(model.isPaused == false)
    }

    @Test func aFailedAnswerDoesNotMoveTheSessionOn() async {
        let feed = PlanningFeed(session: session())
        feed.decideFails = true
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        await model.answer("done")

        #expect(feed.decisions.count == 1)
        #expect(feed.patches.isEmpty)
        #expect(feed.completes.isEmpty)
        #expect(model.errorMessage != nil)
        #expect(!model.busy)
    }

    // MARK: the agenda sheet

    @Test func jumpingMovesTheSessionPointerSoAnotherDeviceResumesHere() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        await model.jump(to: "recap")

        #expect(model.askedStep == "recap")
        #expect(model.current?.key == "recap")
        let patch = try #require(feed.patches.first)
        #expect(patch.currentStep == "recap")
        #expect(patch.status == nil)
    }

    @Test func discardingDeletesTheSessionAndNothingElse() async {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        model.leave()

        await model.discard()

        #expect(feed.discards == ["session-1"])
        #expect(feed.decisions.isEmpty)
        #expect(feed.completes.isEmpty)
        #expect(model.askedStep == nil)
        #expect(model.pausedSessionId == nil)
        #expect(model.session == nil)
    }

    // MARK: the record

    @Test func reopeningSendsOnlyTheStatus() async throws {
        let feed = PlanningFeed(
            session: session(status: "completed", currentStep: "calendar", completedAt: "2026-09-06T17:32:00.000Z"))
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        #expect(model.showsRecord)

        await model.reopen()

        let patch = try #require(feed.patches.first)
        #expect(patch.status == "active")
        // The pointer must be left alone: sending `null` to mean "no change" is a 400.
        #expect(patch.currentStep == nil)
        #expect(model.askedStep == "calendar")
    }

    // MARK: leaving, and coming back

    @Test func leavingWritesNothingToTheServer() async {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        let fetchesBefore = feed.fetchCount

        model.leave()

        #expect(feed.discards.isEmpty)
        #expect(feed.decisions.isEmpty)
        #expect(feed.patches.isEmpty)
        #expect(feed.completes.isEmpty)
        #expect(feed.fetchCount == fetchesBefore)
        #expect(model.isPaused)
        #expect(model.session?.isActive == true)
    }

    @Test func thePauseIntentSuppressesAutoResumeOnAFreshScreen() async {
        let defaults = scratchDefaults()
        let feed = PlanningFeed(session: session())
        let first = makeModel(feed, defaults: defaults)
        await first.load()
        first.leave()

        let second = makeModel(feed, defaults: defaults)
        await second.load()

        #expect(second.pausedSessionId == "session-1")
        #expect(second.isPaused)
    }

    @Test func anExplicitlyAskedForStepOverridesThePause() async {
        let defaults = scratchDefaults()
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: defaults)
        await model.load()
        model.leave()
        #expect(model.isPaused)

        await model.jump(to: "calendar")

        #expect(!model.isPaused)
        #expect(model.current?.key == "calendar")
        #expect(model.pausedSessionId == "session-1")
    }

    @Test func resumingClearsThePauseAndLandsOnTheSessionsOwnPointer() async {
        let defaults = scratchDefaults()
        let feed = PlanningFeed(session: session(currentStep: "calendar"))
        let model = makeModel(feed, defaults: defaults)
        await model.load()
        model.leave()

        model.resume()

        #expect(!model.isPaused)
        #expect(model.pausedSessionId == nil)
        #expect(defaults.string(forKey: "waffled.planning.pausedSession") == nil)
        #expect(model.askedStep == "calendar")
    }

    @Test func aPauseLeftBehindByADiscardedSessionIsInert() async {
        let defaults = scratchDefaults()
        defaults.set("session-from-last-week", forKey: "waffled.planning.pausedSession")
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: defaults)

        await model.load()

        #expect(!model.isPaused)
    }

    @Test func completingClearsThePauseSoTheRecordIsNotShadowed() async {
        let defaults = scratchDefaults()
        let feed = PlanningFeed(session: session(currentStep: "recap"))
        let model = makeModel(feed, defaults: defaults)
        await model.load()
        model.leave()
        await model.jump(to: "recap")

        await model.answer("done")

        #expect(model.pausedSessionId == nil)
        #expect(model.showsRecord)
    }

    // MARK: the week stepper

    @Test func steppingToAnotherWeekDropsTheStepAndAsksForThatWeek() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        await model.jump(to: "calendar")

        feed.weekStart = "2026-09-13"
        await model.goNextWeek()

        #expect(model.askedStep == nil)
        #expect(model.requestedWeek == "2026-09-13")
        // `#require` peels the outer optional off `Array.last`; the element is itself a
        // `String?`, and `last == nil` would be true for an empty log too.
        #expect(try #require(feed.fetchedWeeks.last) == "2026-09-13")
    }

    @Test func steppingBackToTheDefaultWeekStopsPinningAWeek() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()
        feed.weekStart = "2026-09-13"
        await model.goNextWeek()
        #expect(model.requestedWeek == "2026-09-13")

        feed.weekStart = "2026-09-06"
        await model.goPreviousWeek()

        #expect(model.requestedWeek == nil)
        #expect(try #require(feed.fetchedWeeks.last) == nil)
    }

    @Test func theStepperFloorsAtTheHouseholdsCurrentWeek() async {
        let feed = PlanningFeed(session: session())
        feed.weekStart = "2026-08-30"
        feed.minWeekStart = "2026-08-30"
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        #expect(!model.canGoBack)
        await model.goPreviousWeek()
        #expect(feed.fetchedWeeks.count == 1)   // no second fetch: the arrow does nothing
    }

    // MARK: parked notes

    @Test func settlingAParkedNoteResolvesItAgainstThisSession() async throws {
        let feed = PlanningFeed(session: session())
        feed.steps = [
            step("looseEnds", number: 1, act: "Intake"),
            step("calendar", number: 2, parked: [handoff("note-1", "Book the dentist")]),
            step("recap", number: 3, act: "Close"),
        ]
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        let ok = await model.resolveParked(id: "note-1", action: "done")

        #expect(ok)
        let resolve = try #require(feed.resolves.first)
        #expect(resolve.kind == "parked")
        #expect(resolve.id == "note-1")
        #expect(resolve.action == "done")
        #expect(resolve.sessionId == "session-1")
    }

    // MARK: config

    @Test func savingOneStepToggleSendsOnlyThatStep() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        await model.saveConfig(steps: ["calendar": false])

        let save = try #require(feed.configSaves.first)
        #expect(save.steps == ["calendar": false])
        // Everything else omitted — the server merges, and a full map would clobber opt-outs
        // this client never saw.
        #expect(save.dayOfWeek == nil)
        #expect(save.time == nil)
        #expect(save.showOnToday == nil)
    }

    @Test func rulingOneListOutSendsOnlyThatList() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        await model.saveConfig(lists: ["l2": false])

        let save = try #require(feed.configSaves.first)
        #expect(save.lists == ["l2": false])
        #expect(save.steps == nil)
        #expect(save.dayOfWeek == nil)
        #expect(save.time == nil)
        #expect(save.showOnToday == nil)
    }

    // Which lists are even askable is the server's rule (the `custom` allowlist), so names
    // arrive with the config rather than being re-derived off the lists module.
    @Test func theConfigReadCarriesTheListsItCouldAskAbout() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())

        await model.loadListCandidates()

        #expect(model.listCandidates.map(\.name) == ["Repairs", "Someday"])
    }

    // Absent from the map means RELEVANT — the reason the setting can ship without changing
    // what any existing household sees.
    @Test func aListNobodyHasRuledOnIsStillAskedAbout() {
        let ruled = WaffledAPI.WeeklyPlanningConfig(
            dayOfWeek: 0, time: "17:00", steps: [:], showOnToday: true, lists: ["l2": false])
        #expect(ruled.asksAbout("l2") == false)
        #expect(ruled.asksAbout("l1"))
        let silent = WaffledAPI.WeeklyPlanningConfig(
            dayOfWeek: 0, time: "17:00", steps: [:], showOnToday: true, lists: nil)
        #expect(silent.asksAbout("l1"))
    }

    @Test func savingTheDayLeavesTheStepMapAlone() async throws {
        let feed = PlanningFeed(session: session())
        let model = makeModel(feed, defaults: scratchDefaults())
        await model.load()

        await model.saveConfig(dayOfWeek: 4)

        let save = try #require(feed.configSaves.first)
        #expect(save.dayOfWeek == 4)
        #expect(save.steps == nil)
    }
}
