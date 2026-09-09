import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 6 — Goals, on iOS. Three invariants a "simplification" would
// undo: a goal's number comes off `GoalDisplay`, NOT `totalProgress`; the crumb mirrors
// the server's focus map for SETTLED groups only (an unsettled group's `focusGoalId` may
// be a pre-existing pin); and a failed fetch keeps the last good groups while a failed
// write mutates nothing. The JSON is the shape
// `apps/api/test/weekly-planning-goals.integration.test.ts` asserts on.

// MARK: - Fixtures

private enum GoalsFixture {

    static func goalJSON(
        id: String,
        title: String,
        type: String,
        total: Double,
        target: String = "null",
        habitTarget: String = "null",
        habitPeriod: String = "null",
        periodDone: String = "null",
        stepDone: String = "null",
        stepTotal: String = "null",
        isFeatured: Bool = false,
        pace: String = "null"
    ) -> String {
        """
        {"id":"\(id)","goalListId":"list-family","title":"\(title)","emoji":"📚",
         "category":"intellectual","goalType":"\(type)","unit":null,
         "habitPeriod":\(habitPeriod),"habitTargetPerPeriod":\(habitTarget),
         "trackingMode":"shared","participantMode":null,"targetBasis":null,"deadline":null,
         "isFeatured":\(isFeatured),"isSpotlight":false,"target":\(target),
         "totalProgress":\(total),"periodDone":\(periodDone),"stepDone":\(stepDone),
         "stepTotal":\(stepTotal),"logMethod":"manual","hasRewards":false,
         "milestoneTotal":0,"milestoneReached":0,"streakDays":3,"autoFromCalendar":false,
         "healthMetric":null,"createdAt":"2026-01-01T00:00:00.000Z","participants":[],
         "pace":\(pace)}
        """
    }

    static let viewJSON = json(familyExtra: nil)

    static func json(familyExtra: String?) -> String {
        """
    {"groups":[
      {"listId":"list-family","name":"Family","emoji":"🏡","colorHex":"#EC6049",
       "isPrivate":false,"sortOrder":0,"isEveryone":true,"settled":true,
       "focusGoalId":"goal-read",
       "members":[
         {"personId":"p-kevin","name":"Kevin Sites","avatarEmoji":"🧔","colorHex":"#2F7FED","age":41},
         {"personId":"p-wally","name":"Wally Sites","avatarEmoji":"🧒","colorHex":"#25A368","age":null}
       ],
       "goals":[
         \(familyExtra.map { "\($0)," } ?? "")
         \(goalJSON(id: "goal-read", title: "Read together", type: "habit", total: 340,
                    habitTarget: "5", habitPeriod: "\"week\"", periodDone: "2",
                    isFeatured: true,
                    pace: "{\"text\":\"2 of 5 last week\",\"tone\":\"behind\"}")),
         \(goalJSON(id: "goal-walk", title: "Walk the loop", type: "count", total: 12,
                    target: "20", pace: "{\"text\":\"3 days logged last week\",\"tone\":\"ok\"}"))
       ]},
      {"listId":"list-lottie","name":"Lottie","emoji":"🎀","colorHex":null,
       "isPrivate":false,"sortOrder":1,"isEveryone":false,"settled":true,
       "focusGoalId":null,
       "members":[{"personId":"p-lottie","name":"Lottie Sites","avatarEmoji":"🎀","colorHex":"#E0548B","age":6}],
       "goals":[
         \(goalJSON(id: "goal-recital", title: "Recital practice", type: "checklist",
                    total: 99, stepDone: "3", stepTotal: "4",
                    pace: "{\"text\":\"roughly 1 a month\",\"tone\":\"flat\"}"))
       ]},
      {"listId":"list-couple","name":"Us","emoji":"💛","colorHex":null,
       "isPrivate":true,"sortOrder":2,"isEveryone":false,"settled":false,
       "focusGoalId":"goal-date",
       "members":[
         {"personId":"p-kevin","name":"Kevin Sites","avatarEmoji":"🧔","colorHex":"#2F7FED","age":41},
         {"personId":"p-kelly","name":"Kelly Sites","avatarEmoji":"👩","colorHex":"#8A5CF0","age":40}
       ],
       "goals":[\(goalJSON(id: "goal-date", title: "Date night", type: "count", total: 1,
                           target: "12", isFeatured: true))]}
    ]}
    """
    }

    static func decoded() throws -> WaffledAPI.PlanningGoalsView {
        try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningGoalsView.self, from: Data(viewJSON.utf8))
    }

    static func decodedWithNewFamilyGoal() throws -> WaffledAPI.PlanningGoalsView {
        let extra = goalJSON(id: "goal-sunset", title: "Sunset walks", type: "count",
                             total: 0, target: "30", isFeatured: true)
        return try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningGoalsView.self,
            from: Data(json(familyExtra: extra).utf8))
    }
}

private enum GoalsStepFailure: Error { case rejected }

@MainActor
private final class GoalsFeed {
    var snapshot: WaffledAPI.PlanningGoalsView
    var fetchFails = false
    var writeFails = false
    var createFails = false
    var fetchCount = 0
    var writes: [(listId: String, goalId: String?)] = []
    var creates: [[String: JSONValue]] = []
    var afterCreate: WaffledAPI.PlanningGoalsView?

    init(_ snapshot: WaffledAPI.PlanningGoalsView) { self.snapshot = snapshot }
}

@MainActor
private func model(_ feed: GoalsFeed) -> PlanningGoalsStepModel {
    PlanningGoalsStepModel(
        fetchGoals: { _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw GoalsStepFailure.rejected }
            return feed.snapshot
        },
        setFocus: { _, listId, goalId in
            feed.writes.append((listId, goalId))
            if feed.writeFails { throw GoalsStepFailure.rejected }
            return feed.snapshot
        },
        createGoal: { body in
            feed.creates.append(body)
            if feed.createFails { throw GoalsStepFailure.rejected }
            if let after = feed.afterCreate { feed.snapshot = after }
        })
}

// MARK: - Decoding

@Suite struct PlanningGoalsDecodingTests {

    @Test func theStepsViewDecodesFromTheServersOwnShape() throws {
        let view = try GoalsFixture.decoded()
        #expect(view.groups.count == 3)

        let family = view.groups[0]
        #expect(family.listId == "list-family")
        #expect(family.isPrivate == false)
        #expect(family.isEveryone)
        #expect(family.settled)
        #expect(family.focusGoalId == "goal-read")
        #expect(family.sortOrder == 0)
        #expect(family.goals.count == 2)

        #expect(family.members[0].age == 41)
        #expect(family.members[1].age == nil)

        #expect(view.groups[2].isPrivate)
    }

    @Test func aHabitsNumberComesOffTheDisplayAxisNotItsLifetimeTotal() throws {
        let view = try GoalsFixture.decoded()
        let read = view.groups[0].goals[0].goal
        #expect(read.goalType == "habit")
        #expect(read.totalProgress == 340)

        // 2 of 5 THIS WEEK. 340 is the number this step must never show.
        #expect(GoalDisplay.progress(read) == 2)
        #expect(GoalDisplay.target(read) == 5)
        #expect(GoalDisplay.fraction(read) == 0.4)
        #expect(PlanningGoalsText.axisLabel(read) == "this week")
    }

    @Test func aChecklistIsMeasuredInStepsAndACountInItsTotal() throws {
        let view = try GoalsFixture.decoded()
        let recital = view.groups[1].goals[0].goal
        #expect(GoalDisplay.progress(recital) == 3)
        #expect(GoalDisplay.target(recital) == 4)
        #expect(PlanningGoalsText.axisLabel(recital) == "steps done")

        let walk = view.groups[0].goals[1].goal
        #expect(GoalDisplay.progress(walk) == 12)
        #expect(GoalDisplay.target(walk) == 20)
    }

    @Test func thePaceSentenceAndItsToneArriveWithTheGoal() throws {
        let view = try GoalsFixture.decoded()
        #expect(view.groups[0].goals[0].pace?.text == "2 of 5 last week")
        #expect(view.groups[0].goals[0].pace?.tone == "behind")
        #expect(view.groups[1].goals[0].pace?.tone == "flat")
        #expect(view.groups[2].goals[0].pace == nil)
    }

    @Test func anUnknownToneReadsNeutralRatherThanAlarming() {
        #expect(PlanningPaceTone.kind("ok") == .ok)
        #expect(PlanningPaceTone.kind("behind") == .behind)
        #expect(PlanningPaceTone.kind("flat") == .neutral)
        #expect(PlanningPaceTone.kind("euphoric") == .neutral)
    }
}

// MARK: - The crumb

@Suite struct PlanningGoalsCrumbTests {

    @Test func theCrumbMirrorsTheServersFocusMapIncludingItsExplicitNull() throws {
        let crumb = PlanningGoalsCrumb.decision(try GoalsFixture.decoded())
        guard case let .object(focus)? = crumb["focus"] else {
            Issue.record("the crumb must carry a `focus` object")
            return
        }
        #expect(focus["list-family"] == .string("goal-read"))
        // …and "nothing this week", a REAL answer that must survive as a null, or the
        // group reads as unanswered on the next visit.
        #expect(focus["list-lottie"] == .null)
        #expect(focus.count == 2)
    }

    @Test func anUnsettledGroupsAdoptedPinIsNotRecordedAsAnAnswer() throws {
        let crumb = PlanningGoalsCrumb.decision(try GoalsFixture.decoded())
        guard case let .object(focus)? = crumb["focus"] else {
            Issue.record("the crumb must carry a `focus` object")
            return
        }
        // `list-couple` is unsettled but carries `focusGoalId` from a hand pin; writing it
        // would star a tab nobody has looked at.
        #expect(focus["list-couple"] == nil)
    }

}

// MARK: - The model

@MainActor
@Suite struct PlanningGoalsStepModelTests {

    @Test func noCrumbIsOfferedBeforeAReadHasLanded() async throws {
        // An empty map is a claim, not "nothing settled", and the shell REPLACES the step's
        // data with the crumb — so a failed fetch must offer none.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.fetchFails = true
        let model = model(feed)

        await model.load(sessionId: "session-1")

        #expect(model.loaded)
        #expect(model.crumb == nil)
    }

    @Test func theStepSkipsPastASettledGroupToLandOnWhatIsLeft() async throws {
        // The FIRST group is deliberately settled: with every group unsettled this would
        // pass even if the model just landed on `groups.first`.
        let json = GoalsFixture.viewJSON
            .replacingOccurrences(
                of: "\"isEveryone\":false,\"settled\":true",
                with: "\"isEveryone\":false,\"settled\":false")
        let view = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningGoalsView.self, from: Data(json.utf8))
        let feed = GoalsFeed(view)
        let model = model(feed)

        await model.load(sessionId: "session-1")

        #expect(view.groups[0].settled)
        #expect(model.tabId == "list-lottie")
    }

    @Test func theStepOpensOnTheOnlyUnsettledGroupWhenTheOthersAreDone() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)

        await model.load(sessionId: "session-1")

        #expect(model.tabId == "list-couple")
        #expect(model.settledCount == 2)
    }

    @Test func aFailedReadKeepsTheGroupsItHadAndStillCountsAsLoaded() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        feed.fetchFails = true

        await model.load(sessionId: "session-1")

        #expect(model.groups.count == 3)
        #expect(model.loaded)
    }

    @Test func nothingThisWeekIsSentAsARealAnswerNotAsAMissingOne() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")

        await model.pick(sessionId: "session-1", listId: "list-couple", goalId: nil)

        #expect(feed.writes.count == 1)
        #expect(feed.writes[0].listId == "list-couple")
        #expect(feed.writes[0].goalId == nil)
    }

    @Test func aFailedWriteLeavesTheLastGoodAnswerOnScreenAndDoesNotRefetch() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        feed.writeFails = true

        await model.pick(sessionId: "session-1", listId: "list-family", goalId: "goal-walk")

        #expect(feed.fetchCount == 1)
        #expect(model.errorMessage != nil)
        #expect(model.groups[0].focusGoalId == "goal-read")
        #expect(model.isFrozen(shellBusy: false) == false)
    }

    @Test func theTabTheFamilyIsStandingOnSurvivesAWrite() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        model.selectTab("list-family")

        await model.pick(sessionId: "session-1", listId: "list-family", goalId: "goal-walk")

        // Re-deriving "the first unsettled group" per write would jump them off the group
        // they just answered.
        #expect(model.tabId == "list-family")
    }
}

// MARK: - The step's words

@Suite struct PlanningGoalsTextTests {

    @Test func theGroupSubLineOnlyEverStatesFactsTheServerSent() throws {
        let view = try GoalsFixture.decoded()
        #expect(PlanningGoalsText.groupSubtitle(view.groups[0]) == "shared · everyone tracks it")
        #expect(PlanningGoalsText.groupSubtitle(view.groups[1]) == "individual · age 6")
        #expect(PlanningGoalsText.groupSubtitle(view.groups[2]) == "private · just the two of you")
    }

    @Test func theVerdictTellsAlreadyPinnedApartFromWeDecided() throws {
        let view = try GoalsFixture.decoded()
        #expect(PlanningGoalsText.verdict(view.groups[0]) == "★ This week · Read together")
        #expect(PlanningGoalsText.verdict(view.groups[1]) == "No focus this week — that’s allowed")
        #expect(PlanningGoalsText.verdict(view.groups[2])
                == "Pinned already · Date night — keep it, or pick another")
    }
}

// MARK: - "＋ New goal for this week"

/// A naive "+ New goal" makes the goal in whichever group the family was NOT looking at,
/// and it appears to vanish. These pin the four invariants: which group it lands in, that
/// it is then on screen, that making it is not confirming it, and that a saved goal
/// survives a failed refetch.
@MainActor
@Suite struct PlanningGoalsNewGoalTests {

    /// What the goals editor hands back: the Pinned tier (from `startFeatured`) and a
    /// `goalListId` the step must not trust.
    private static let editorBody: [String: JSONValue] = [
        "title": .string("Sunset walks"),
        "goalListId": .null,
        "goalType": .string("count"),
        "isFeatured": .bool(true),
        "targetValue": .double(30),
    ]

    private func makeGoal(
        _ model: PlanningGoalsStepModel,
        body: [String: JSONValue] = PlanningGoalsNewGoalTests.editorBody
    ) async {
        model.openNewGoal()
        guard let target = model.newForListId else {
            Issue.record("the composer refused to open")
            return
        }
        await model.submitNewGoal(sessionId: "session-1", listId: target, body: body)
    }

    @Test func theGoalIsMadeInTheGroupWhoseTabIsSelected() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        // DELIBERATELY NOT the tab the step lands on (`list-couple`), or this passes for
        // the wrong reason.
        model.selectTab("list-family")

        model.openNewGoal()
        #expect(model.newForListId == "list-family")
        let made = await model.submitNewGoal(
            sessionId: "session-1", listId: "list-family", body: Self.editorBody)

        #expect(made)
        #expect(feed.creates.count == 1)
        #expect(feed.creates[0]["goalListId"] == .string("list-family"))
        // Pinned on the way in, so the server adopts it as the group's focus on the way
        // back (see `getGoalsStepView`) without a second trip.
        #expect(feed.creates[0]["isFeatured"] == .bool(true))
        #expect(feed.creates[0]["title"] == .string("Sunset walks"))
        #expect(feed.creates[0]["targetValue"] == .double(30))
    }

    @Test func theGroupIsTheOnlyThingTheStepOverrules() {
        let out = PlanningGoalsStepModel.newGoalBody(
            [
                "title": .string("Sunset walks"),
                "goalListId": .string("list-lottie"),
                "isFeatured": .bool(false),
                "isSpotlight": .bool(true),
                "participantIds": .array([.string("p-kevin")]),
            ],
            listId: "list-family")

        #expect(out["goalListId"] == .string("list-family"))
        #expect(out["isFeatured"] == .bool(false))
        #expect(out["isSpotlight"] == .bool(true))
        #expect(out["title"] == .string("Sunset walks"))
        #expect(out["participantIds"] == .array([.string("p-kevin")]))
        #expect(out.count == 5)
    }

    @Test func theNewGoalShowsUpInThatGroupsListRatherThanVanishing() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.afterCreate = try GoalsFixture.decodedWithNewFamilyGoal()
        let model = model(feed)
        await model.load(sessionId: "session-1")
        model.selectTab("list-family")

        await makeGoal(model)

        #expect(feed.fetchCount == 2)
        #expect(model.active?.listId == "list-family")
        let onScreen = model.active?.goals.map(\.goal.id) ?? []
        #expect(onScreen.contains("goal-sunset"))
        #expect(model.newForListId == nil)
        #expect(model.creating == false)
    }

    @Test func makingAGoalIsNotTheSameAsConfirmingItForTheWeek() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        model.selectTab("list-couple")

        await makeGoal(model)

        #expect(feed.creates.count == 1)
        #expect(feed.writes.isEmpty)
        let couple = model.groups.first(where: { $0.listId == "list-couple" })
        #expect(couple?.settled == false)
        #expect(model.settledCount == 2)
    }

    @Test func aRefetchThatFailsAfterTheGoalWasSavedKeepsTheLastGoodGroups() async throws {
        // The goal IS saved by this point: blanking the step, or pushing a crumb built on
        // nothing, is the worse failure.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")
        let revBefore = model.rev
        feed.fetchFails = true

        await makeGoal(model)

        #expect(feed.creates.count == 1)
        #expect(model.groups.count == 3)
        #expect(model.groups[0].focusGoalId == "goal-read")
        #expect(model.rev == revBefore)
        #expect(model.newForListId == nil)
        #expect(model.creating == false)
    }

    @Test func aCreateThatFailsSaysSoAndChangesNothing() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.createFails = true
        let model = model(feed)
        await model.load(sessionId: "session-1")

        model.openNewGoal()
        let made = await model.submitNewGoal(
            sessionId: "session-1", listId: "list-couple", body: Self.editorBody)

        // The view gates `props.refresh()` on this: refreshing over a goal that never saved
        // greys the step out — a second, false failure on top of the banner.
        #expect(made == false)
        #expect(model.errorMessage != nil)
        #expect(feed.fetchCount == 1)
        #expect(model.newForListId == nil)
        #expect(model.isFrozen(shellBusy: false) == false)
    }

    @Test func aSubmitNamingAGroupTheStepDoesNotHaveCreatesNothing() async throws {
        // The group is captured when the editor opens, so a refetch that dropped that list
        // mid-compose must not create into it — the goal would land where the family
        // cannot see it.
        let feed = GoalsFeed(try GoalsFixture.decoded())
        let model = model(feed)
        await model.load(sessionId: "session-1")

        let made = await model.submitNewGoal(
            sessionId: "session-1", listId: "list-that-went-away", body: Self.editorBody)

        #expect(made == false)
        #expect(feed.creates.isEmpty)
        #expect(model.creating == false)
    }

    @Test func thereIsNothingToOpenWhenTheStepHasNoGroups() async throws {
        let feed = GoalsFeed(try GoalsFixture.decoded())
        feed.fetchFails = true
        let model = model(feed)
        await model.load(sessionId: "session-1")

        model.openNewGoal()

        #expect(model.newForListId == nil)
        #expect(model.newGoalGroup == nil)
    }

    // MARK: whose group you may add to

    @Test func aManagerMayAddToAnyGroupAndEveryoneElseOnlyToTheirOwn() throws {
        let groups = try GoalsFixture.decoded().groups
        let family = groups[0], lottie = groups[1], couple = groups[2]

        for g in groups {
            #expect(PlanningGoalsStepModel.canTarget(
                g, canManageGoals: true, personId: "p-lottie"))
        }

        // Without it, only a group that is just you: offering the editor otherwise is
        // show-then-403.
        #expect(PlanningGoalsStepModel.canTarget(
            lottie, canManageGoals: false, personId: "p-lottie"))
        #expect(PlanningGoalsStepModel.canTarget(
            family, canManageGoals: false, personId: "p-lottie") == false)
        #expect(PlanningGoalsStepModel.canTarget(
            couple, canManageGoals: false, personId: "p-kevin") == false)
        #expect(PlanningGoalsStepModel.canTarget(
            lottie, canManageGoals: false, personId: "p-kevin") == false)
        #expect(PlanningGoalsStepModel.canTarget(
            lottie, canManageGoals: false, personId: nil) == false)
    }

    // MARK: the group, in the shape the goals editor speaks

    @Test func theGroupHandedToTheEditorCarriesItsPeopleSoParticipantsFollowTheList() throws {
        let couple = try GoalsFixture.decoded().groups[2]
        let list = couple.asGoalList

        #expect(list.id == "list-couple")
        #expect(list.name == "Us")
        #expect(list.emoji == "💛")
        #expect(list.goalCount == 1)
        #expect(list.members.map(\.personId) == ["p-kevin", "p-kelly"])
        #expect(list.members[1].name == "Kelly Sites")
        #expect(list.members[0].avatarEmoji == "🧔")
        #expect(list.members[1].colorHex == "#8A5CF0")
    }
}
