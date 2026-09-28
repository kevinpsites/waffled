import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 9 — Kids, on iOS. Two of these tests are the point of the file.
//
//   1. THE FOUR-STATE ANSWER. `focus` and `forward` each mean four things on the wire —
//      absent (leave the other answer alone), null (clear it), `{key}` and `{text}` — and
//      a `String?` can only say two. One test per state, asserting the exact body, so that
//      "simplifying" `.absent` into a null cannot pass; that collapse is what a
//      synthesized `Encodable` does, which is why the body is a dictionary.
//   2. THE UNSAVED DRAFT. Typing into "something else" and then tapping an offered option
//      must not throw the typing away.

// MARK: - Fixtures

private enum KidsFixture {
    // Real UUIDs: the server's `answerKid` rejects a `personId` that isn't one.
    static let session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    static let week = "2026-09-06"
    static let wally = "11111111-1111-4111-8111-111111111111"
    static let lottie = "22222222-2222-4222-8222-222222222222"

    /// Wally's habit: 340 lifetime reps, 2 of 5 THIS WEEK. A goal-sourced option carries its
    /// goal so the card reads the second number, not the first.
    static let readGoalJSON = """
    {"id":"g-read","goalListId":"list-wally","title":"Read together","emoji":"📚",
     "category":"intellectual","goalType":"habit","unit":null,"habitPeriod":"week",
     "habitTargetPerPeriod":5,"trackingMode":"shared","participantMode":null,
     "targetBasis":null,"deadline":null,"isFeatured":false,"isSpotlight":false,
     "target":null,"totalProgress":340,"periodDone":2,"stepDone":null,"stepTotal":null,
     "logMethod":"manual","hasRewards":false,"milestoneTotal":0,"milestoneReached":0,
     "streakDays":4,"autoFromCalendar":false,"healthMetric":null,
     "createdAt":"2026-01-01T00:00:00.000Z","participants":[]}
    """

    static func focusSnapshot(forKey key: String) -> String? {
        switch key {
        case "goal:g-read":
            return #"{"source":"goal","id":"g-read","emoji":"📚","label":"Read together","detail":"2 of 5 this week"}"#
        case "chore:c-garage":
            return #"{"source":"chore","id":"c-garage","emoji":"🧹","label":"Sweep the garage","detail":"open since Wednesday"}"#
        case "chore:c-homework":
            return #"{"source":"routine","id":"c-homework","emoji":"🎒","label":"Homework","detail":null}"#
        case "chore:c-vacuum":
            return #"{"source":"routine","id":"c-vacuum","emoji":"🧹","label":"Vacuum the lounge","detail":null}"#
        default:
            return nil
        }
    }

    static func forwardSnapshot(forKey key: String) -> String? {
        switch key {
        case "event:e-party":
            return #"{"eventId":"e-party","emoji":"🎉","label":"Ezra’s party","when":"Sat"}"#
        case "event:e-soccer":
            return #"{"eventId":"e-soccer","emoji":"📅","label":"Soccer practice","when":"Tue"}"#
        case "event:e-dentist":
            return #"{"eventId":"e-dentist","emoji":"📅","label":"Dentist","when":"Thu"}"#
        default:
            return nil
        }
    }

    /// Free text names nothing in any module, which is how the read-back tells it apart from
    /// a picked option — and why it can live in the same field.
    static func customFocus(_ label: String) -> String {
        #"{"source":"custom","id":null,"emoji":"✨","label":"\#(label)","detail":null}"#
    }

    static func customForward(_ label: String) -> String {
        #"{"eventId":null,"emoji":"✨","label":"\#(label)","when":""}"#
    }

    static func viewJSON(
        wallyFocus: String = "null",
        wallyForward: String = "null",
        lottieFocus: String = "null",
        lottieForward: String = "null",
        canRepeat: Bool = true
    ) -> String {
        """
        {"weekStart":"\(week)",
         "sources":{"goals":true,"chores":true,"rewards":true},
         "canRepeat":\(canRepeat),
         "kids":[
          {"personId":"\(wally)","name":"Wally Sites","avatarEmoji":"🧒","colorHex":"#25A368",
           "age":8,"stars":42,"starsSymbol":"⭐",
           "week":[
             {"id":"e-soccer","title":"Soccer practice","when":"Tue 4:00 PM",
              "startsAt":"2026-09-08T16:00:00.000Z","allDay":false},
             {"id":"e-party","title":"Ezra’s party","when":"Sat",
              "startsAt":"2026-09-12T00:00:00.000Z","allDay":true}
           ],
           "chores":[
             {"id":"c-homework","title":"Homework","emoji":"🎒","when":"every day","late":false},
             {"id":"c-garage","title":"Sweep the garage","emoji":"🧹","when":"open since Wednesday","late":true}
           ],
           "focusOptions":[
             {"key":"chore:c-garage","source":"chore","id":"c-garage","emoji":"🧹",
              "label":"Sweep the garage","detail":"open since Wednesday","routed":true,"goal":null},
             {"key":"goal:g-read","source":"goal","id":"g-read","emoji":"📚",
              "label":"Read together","detail":"2 of 5 this week","routed":false,
              "goal":\(readGoalJSON)},
             {"key":"chore:c-homework","source":"routine","id":"c-homework","emoji":"🎒",
              "label":"Homework","detail":null,"routed":false,"goal":null}
           ],
           "forwardOptions":[
             {"key":"event:e-party","eventId":"e-party","emoji":"🎉","label":"Ezra’s party","when":"Sat"},
             {"key":"event:e-soccer","eventId":"e-soccer","emoji":"📅","label":"Soccer practice","when":"Tue"}
           ],
           "focus":\(wallyFocus),"forward":\(wallyForward),
           "settled":\(wallyFocus != "null" && wallyForward != "null")},
          {"personId":"\(lottie)","name":"Lottie Sites","avatarEmoji":"🎀","colorHex":"#E0548B",
           "age":null,"stars":null,"starsSymbol":null,
           "week":[],
           "chores":[
             {"id":"c-vacuum","title":"Vacuum the lounge","emoji":"🧹","when":"Sat","late":false}
           ],
           "focusOptions":[
             {"key":"chore:c-vacuum","source":"routine","id":"c-vacuum","emoji":"🧹",
              "label":"Vacuum the lounge","detail":null,"routed":false,"goal":null}
           ],
           "forwardOptions":[],
           "focus":\(lottieFocus),"forward":\(lottieForward),
           "settled":\(lottieFocus != "null" && lottieForward != "null")}
         ]}
        """
    }

    static func decoded(
        wallyFocus: String = "null",
        wallyForward: String = "null",
        lottieFocus: String = "null",
        lottieForward: String = "null",
        canRepeat: Bool = true
    ) throws -> WaffledAPI.PlanningKidsView {
        try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningKidsView.self,
            from: Data(viewJSON(
                wallyFocus: wallyFocus, wallyForward: wallyForward,
                lottieFocus: lottieFocus, lottieForward: lottieForward,
                canRepeat: canRepeat).utf8))
    }
}

private enum KidsStepFailure: Error { case rejected }

/// A stand-in for the server that MERGES the way `answerKid` does — absent leaves the other
/// answer alone, null clears, a key resolves against the options offered. Without the
/// merge, the draft test would prove nothing.
@MainActor
private final class KidsFeed {
    var wallyFocus = "null"
    var wallyForward = "null"
    var lottieFocus = "null"
    var lottieForward = "null"
    var canRepeat = true
    var fetchFails = false
    var writeFails = false
    var fetchCount = 0
    var answers: [(personId: String, focus: PlanningKidPick, forward: PlanningKidPick)] = []
    var repeats = 0

    func snapshot() throws -> WaffledAPI.PlanningKidsView {
        try KidsFixture.decoded(
            wallyFocus: wallyFocus, wallyForward: wallyForward,
            lottieFocus: lottieFocus, lottieForward: lottieForward, canRepeat: canRepeat)
    }

    func merge(personId: String, focus: PlanningKidPick, forward: PlanningKidPick) {
        if let resolved = Self.resolve(focus, snapshot: KidsFixture.focusSnapshot,
                                       custom: KidsFixture.customFocus) {
            if personId == KidsFixture.wally { wallyFocus = resolved } else { lottieFocus = resolved }
        }
        if let resolved = Self.resolve(forward, snapshot: KidsFixture.forwardSnapshot,
                                       custom: KidsFixture.customForward) {
            if personId == KidsFixture.wally { wallyForward = resolved } else { lottieForward = resolved }
        }
    }

    /// nil means "leave the stored answer exactly as it is" — the `.absent` contract.
    private static func resolve(
        _ pick: PlanningKidPick,
        snapshot: (String) -> String?,
        custom: (String) -> String
    ) -> String? {
        switch pick {
        case .absent: return nil
        case .clear: return "null"
        case let .key(k): return snapshot(k)
        case let .text(t): return custom(t)
        }
    }
}

@MainActor
private func model(_ feed: KidsFeed) -> PlanningKidsStepModel {
    PlanningKidsStepModel(
        fetchKids: { _, _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw KidsStepFailure.rejected }
            return try feed.snapshot()
        },
        answerKid: { _, personId, _, focus, forward in
            feed.answers.append((personId, focus, forward))
            if feed.writeFails { throw KidsStepFailure.rejected }
            feed.merge(personId: personId, focus: focus, forward: forward)
            return try feed.snapshot()
        },
        repeatAnswers: { _, _ in
            feed.repeats += 1
            if feed.writeFails { throw KidsStepFailure.rejected }
            feed.wallyFocus = KidsFixture.focusSnapshot(forKey: "goal:g-read") ?? "null"
            feed.wallyForward = KidsFixture.forwardSnapshot(forKey: "event:e-party") ?? "null"
            return try feed.snapshot()
        })
}

// MARK: - 1. The four-state answer

@Suite struct PlanningKidsAnswerBodyTests {

    private func body(
        focus: PlanningKidPick = .absent, forward: PlanningKidPick = .absent
    ) -> [String: JSONValue] {
        WaffledAPI.planningKidsAnswerBody(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: focus, forward: forward)
    }

    @Test func absentPutsNoKeyInTheBodyAtAll() {
        // Answering the focus must not so much as mention `forward`, or the other half is
        // erased.
        let sent = body(focus: .key("goal:g-read"), forward: .absent)
        #expect(sent["forward"] == nil)
        #expect(sent.keys.contains("forward") == false)
        #expect(sent["focus"] == .object(["key": .string("goal:g-read")]))
    }

    @Test func clearPutsAnExplicitNullInTheBody() {
        // THIS IS THE ONE A "SIMPLIFICATION" BREAKS: encode `.clear` as an omitted key and
        // "forget this answer" silently becomes "leave it alone".
        let sent = body(focus: .clear)
        #expect(sent["focus"] == .null)
        #expect(sent.keys.contains("focus"))
    }

    @Test func aPickedOptionIsSentAsItsKey() {
        let sent = body(forward: .key("event:e-party"))
        #expect(sent["forward"] == .object(["key": .string("event:e-party")]))
        #expect(sent["focus"] == nil)
    }

    @Test func freeTextIsSentAsTextNotAsAKey() {
        let sent = body(focus: .text("Be kind to Lottie"))
        #expect(sent["focus"] == .object(["text": .string("Be kind to Lottie")]))
    }

    @Test func bothAnswersTogetherStillSendBoth() {
        let sent = body(focus: .clear, forward: .text("Grandma’s"))
        #expect(sent["focus"] == .null)
        #expect(sent["forward"] == .object(["text": .string("Grandma’s")]))
    }

    @Test func theBodyAlwaysNamesTheSessionAndThePerson() {
        let sent = body()
        #expect(sent["sessionId"] == .string(KidsFixture.session))
        #expect(sent["personId"] == .string(KidsFixture.wally))
        #expect(sent["weekStart"] == .string(KidsFixture.week))
        #expect(sent.count == 3)
    }

    @Test func anEmptyWeekStartIsOmittedRatherThanSentBlank() {
        let sent = WaffledAPI.planningKidsAnswerBody(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: "", focus: .absent, forward: .absent)
        #expect(sent["weekStart"] == nil)
    }

    @Test func theFourStatesAreFourDistinctWireValues() {
        #expect(PlanningKidPick.absent.wireValue == nil)
        #expect(PlanningKidPick.clear.wireValue == .null)
        #expect(PlanningKidPick.key("k").wireValue == .object(["key": .string("k")]))
        #expect(PlanningKidPick.text("t").wireValue == .object(["text": .string("t")]))
    }
}

// MARK: - 2. The unsaved draft

@MainActor
@Suite struct PlanningKidsDraftTests {

    @Test func anUnsavedTypedDraftSurvivesChangingYourMind() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        model.beginTyping(personId: KidsFixture.wally, which: .focus)
        #expect(model.isTyping(personId: KidsFixture.wally, which: .focus))

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .key("goal:g-read"))
        #expect(model.isTyping(personId: KidsFixture.wally, which: .focus) == false)

        // The box records what was in it on its way out (the view's `.onDisappear`, which is
        // why the draft is written ONCE rather than per keystroke).
        model.recordDraft(personId: KidsFixture.wally, which: .focus, text: "Be kind to Lottie")

        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })

        let read = try #require(card.focusOptions.first { $0.key == "goal:g-read" })
        let homework = try #require(card.focusOptions.first { $0.key == "chore:c-homework" })
        #expect(PlanningKidsChoice.focusChosen(card, read))
        #expect(PlanningKidsChoice.focusChosen(card, homework) == false)
        #expect(PlanningKidsChoice.focusIsCustom(card) == false)

        #expect(model.typeInSeed(card, .focus) == "Be kind to Lottie")
    }

    @Test func aDraftBelongsToOneKidAndOneQuestion() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        model.recordDraft(personId: KidsFixture.wally, which: .focus, text: "Be kind to Lottie")

        let wally = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        let lottie = try #require(model.kids.first { $0.personId == KidsFixture.lottie })
        #expect(model.typeInSeed(wally, .focus) == "Be kind to Lottie")
        #expect(model.typeInSeed(wally, .forward) == "")
        #expect(model.typeInSeed(lottie, .focus) == "")
    }

    @Test func reopeningAChosenCustomAnswerShowsWhatTheySaidNotAnEmptyBox() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .text("Be kind to Lottie"))

        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        #expect(PlanningKidsChoice.focusIsCustom(card))
        #expect(card.focus?.label == "Be kind to Lottie")
        #expect(card.focusOptions.allSatisfy { PlanningKidsChoice.focusChosen(card, $0) == false })
        #expect(model.typeInSeed(card, .focus) == "Be kind to Lottie")
    }

    @Test func aTypedForwardAnswerReadsAsChosenAndNamesNoEvent() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, forward: .text("Grandma’s"))

        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        #expect(PlanningKidsChoice.forwardIsCustom(card))
        #expect(card.forwardOptions.allSatisfy {
            PlanningKidsChoice.forwardChosen(card, $0) == false
        })
    }

    @Test func withNothingAnsweredNoChipReadsAsChosen() async throws {
        // The guard that matters: a bare `forward?.eventId == option.eventId` reads TRUE for
        // every option when both sides are nil, lighting up the whole card.
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        #expect(card.focusOptions.allSatisfy { PlanningKidsChoice.focusChosen(card, $0) == false })
        #expect(card.forwardOptions.allSatisfy {
            PlanningKidsChoice.forwardChosen(card, $0) == false
        })
        #expect(PlanningKidsChoice.focusIsCustom(card) == false)
        #expect(PlanningKidsChoice.forwardIsCustom(card) == false)
    }
}

// MARK: - Decoding, and the goal's axis

@Suite struct PlanningKidsDecodingTests {

    @Test func theCardsDecodeFromTheServersOwnShape() throws {
        let view = try KidsFixture.decoded()
        #expect(view.weekStart == "2026-09-06")
        #expect(view.sources.goals)
        #expect(view.sources.chores)
        #expect(view.sources.rewards)
        #expect(view.canRepeat)
        #expect(view.kids.count == 2)

        let wally = view.kids[0]
        #expect(wally.name == "Wally Sites")
        #expect(wally.age == 8)
        #expect(wally.stars == 42)
        #expect(wally.week.count == 2)
        #expect(wally.week[0].when == "Tue 4:00 PM")
        #expect(wally.week[0].allDay == false)
        #expect(wally.chores.count == 2)
        #expect(wally.chores[1].late)
        #expect(wally.settled == false)
    }

    @Test func aKidWithNoBirthdayAndNoEconomyDropsBothRatherThanShowingZero() throws {
        let lottie = try KidsFixture.decoded().kids[1]
        // Nil, never 0: a zero would read as "you've earned nothing".
        #expect(lottie.stars == nil)
        #expect(lottie.starsSymbol == nil)
        #expect(lottie.age == nil)
    }

    @Test func aGoalSourcedOptionReadsThisPeriodsCountNotItsLifetimeTotal() throws {
        let wally = try KidsFixture.decoded().kids[0]
        let read = try #require(wally.focusOptions.first { $0.key == "goal:g-read" })
        let goal = try #require(read.goal)

        #expect(goal.totalProgress == 340)
        // 2 of 5 THIS WEEK — 340 would tell a kid they'd read 340 times since Sunday.
        #expect(GoalDisplay.progress(goal) == 2)
        #expect(GoalDisplay.target(goal) == 5)
        #expect(GoalDisplay.fraction(goal) == 0.4)
        #expect(read.detail == "2 of 5 this week")
    }

    @Test func aStandingChoreHasNoDetailLineAndThatAbsenceIsTheDesign() throws {
        let wally = try KidsFixture.decoded().kids[0]
        let homework = try #require(wally.focusOptions.first { $0.source == "routine" })
        #expect(homework.detail == nil)
        #expect(homework.goal == nil)

        let garage = try #require(wally.focusOptions.first { $0.key == "chore:c-garage" })
        #expect(garage.routed)
        #expect(garage.detail == "open since Wednesday")
    }

    @Test func theCrumbMirrorsTheAnswersTheServerStored() throws {
        let view = try KidsFixture.decoded(
            wallyFocus: KidsFixture.focusSnapshot(forKey: "goal:g-read") ?? "null",
            wallyForward: KidsFixture.forwardSnapshot(forKey: "event:e-party") ?? "null")
        let crumb = PlanningKidsCrumb.decision(view)
        guard case let .object(kids)? = crumb["kids"] else {
            Issue.record("the crumb must carry a `kids` object")
            return
        }
        #expect(kids.count == 1)
        guard case let .object(entry)? = kids[KidsFixture.wally],
              case let .object(focus)? = entry["focus"] else {
            Issue.record("Wally's answers must be mirrored back")
            return
        }
        // …and the field names are the ones the server's `parseAnswers` reads back. Rename or
        // drop `source` / `label` and the answers are discarded on the next read.
        #expect(focus["source"] == .string("goal"))
        #expect(focus["label"] == .string("Read together"))
        #expect(focus["id"] == .string("g-read"))
        #expect(focus["detail"] == .string("2 of 5 this week"))
        #expect(entry["forward"] != nil)
    }
}

// MARK: - The model

@MainActor
@Suite struct PlanningKidsStepModelTests {

    @Test func aFailedReadKeepsTheCardsItHadAndStillCountsAsLoaded() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)
        feed.fetchFails = true

        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        #expect(model.kids.count == 2)
        #expect(model.loaded)
    }

    @Test func noCrumbIsOfferedBeforeAReadHasLanded() async throws {
        // The shell REPLACES the step's data with the crumb when the affirmative is pressed,
        // so an empty map after a failed fetch would throw away the two sentences.
        let feed = KidsFeed()
        feed.fetchFails = true
        let model = model(feed)

        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        #expect(model.loaded)
        #expect(model.crumb == nil)
    }

    @Test func aFailedAnswerLeavesTheLastGoodOneOnScreenAndDoesNotRefetch() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)
        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .key("goal:g-read"))
        feed.writeFails = true

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .key("chore:c-homework"))

        #expect(feed.fetchCount == 1)
        #expect(model.errorMessage != nil)
        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        #expect(card.focus?.id == "g-read")
        #expect(model.isFrozen(shellBusy: false) == false)
    }

    @Test func answeringOneQuestionDoesNotTouchTheOther() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, forward: .key("event:e-party"))
        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .key("goal:g-read"))

        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        #expect(card.focus?.label == "Read together")
        #expect(card.forward?.label == "Ezra’s party")
        #expect(card.settled)
        #expect(feed.answers[1].forward == .absent)
    }

    @Test func theReadBackWaitsUntilEveryCardHasBothAnswers() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)
        #expect(model.isReadBack == false)

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .key("goal:g-read"),
            forward: .key("event:e-party"))
        #expect(model.isReadBack == false)

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.lottie,
            weekStart: KidsFixture.week, focus: .key("chore:c-vacuum"),
            forward: .text("Baking with Mum"))
        #expect(model.isReadBack)

        model.beginChanging()
        #expect(model.isReadBack == false)
        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .key("chore:c-homework"))
        #expect(model.isReadBack)
    }

    @Test func clearingAnAnswerTakesTheStepBackOutOfItsReadBack() async throws {
        let feed = KidsFeed()
        feed.wallyFocus = KidsFixture.focusSnapshot(forKey: "goal:g-read") ?? "null"
        feed.wallyForward = KidsFixture.forwardSnapshot(forKey: "event:e-party") ?? "null"
        feed.lottieFocus = KidsFixture.focusSnapshot(forKey: "chore:c-vacuum") ?? "null"
        feed.lottieForward = KidsFixture.customForward("Baking with Mum")
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)
        #expect(model.isReadBack)

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.wally,
            weekStart: KidsFixture.week, focus: .clear)

        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        #expect(card.focus == nil)
        #expect(card.forward?.label == "Ezra’s party")
        #expect(card.settled == false)
        #expect(model.isReadBack == false)
    }

    @Test func sameAsLastWeekIsGatedOnTheServerSayingThereIsALastWeek() async throws {
        let feed = KidsFeed()
        feed.canRepeat = false
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        await model.repeatLastWeek(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        #expect(model.canRepeat == false)
        #expect(feed.repeats == 0)
    }

    @Test func sameAsLastWeekCopiesTheAnswersForward() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        await model.repeatLastWeek(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        #expect(feed.repeats == 1)
        let card = try #require(model.kids.first { $0.personId == KidsFixture.wally })
        #expect(card.focus?.label == "Read together")
        #expect(card.forward?.label == "Ezra’s party")
    }

    @Test func theHeadingIsTheKidsOwnNamesNotTheCatalogsWord() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)

        #expect(model.heading == "Wally Sites and Lottie Sites")
    }

    @Test func theCardTheyAreStandingAtSurvivesAWrite() async throws {
        let feed = KidsFeed()
        let model = model(feed)
        await model.load(sessionId: KidsFixture.session, weekStart: KidsFixture.week)
        model.select(personId: KidsFixture.lottie)

        await model.answer(
            sessionId: KidsFixture.session, personId: KidsFixture.lottie,
            weekStart: KidsFixture.week, focus: .key("chore:c-vacuum"))

        #expect(model.activePersonId == KidsFixture.lottie)
    }
}
