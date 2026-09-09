import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 10 (Recap). Three things here matter most: the view must survive a
// ragged payload (in Swift a missing non-optional array throws and takes the whole recap with
// it), nothing is recomputed (the crumb is INTEGERS ONLY), and "Keep it parked" writes nothing.

private enum RecapFailure: Error { case rejected }

// MARK: - The recap, VERBATIM off the wire

private let recapJSON = Data("""
{
  "weekStart": "2026-09-06",
  "savedAt": null,
  "days": [
    { "date": "2026-09-06", "meal": null, "cook": null, "events": [], "more": 0 },
    { "date": "2026-09-07", "meal": "Crockpot chili", "cook": null, "events": [], "more": 0 },
    { "date": "2026-09-08", "meal": "Sheet-pan chicken", "cook": "Lottie",
      "events": [
        { "id": "ev-dance", "title": "Dance", "when": "Tuesday 6:00 PM",
          "personId": "p-lottie", "personName": "Lottie", "personColor": "#7A5AF8",
          "participantIds": [] }
      ],
      "more": 0 },
    { "date": "2026-09-09", "meal": null, "cook": null, "events": [], "more": 0 },
    { "date": "2026-09-10", "meal": null, "cook": null, "events": [], "more": 0 },
    { "date": "2026-09-11", "meal": null, "cook": null,
      "events": [
        { "id": "ev-1", "title": "Recital", "when": "Friday 5:00 PM", "personId": "p-wally",
          "personName": "Wally", "personColor": "#25A368", "participantIds": ["p-kevin"] },
        { "id": "ev-2", "title": "Standup", "when": "Friday 9:00 AM", "personId": null,
          "personName": null, "personColor": null, "participantIds": [] },
        { "id": "ev-3", "title": "Dentist", "when": "Friday 11:00 AM", "personId": "p-kevin",
          "personName": "Kevin", "personColor": null, "participantIds": [] },
        { "id": "ev-4", "title": "Date night", "when": "Friday 8:00 PM", "personId": "p-kevin",
          "personName": "Kevin", "personColor": "#EC6049", "participantIds": ["p-wally", "p-lottie"] }
      ],
      "more": 2 },
    { "date": "2026-09-12", "meal": null, "cook": null, "events": [], "more": 0 }
  ],
  "groups": [
    { "key": "calendar", "label": "Calendar", "headline": "2 events added since you started",
      "detail": "Date night · Recital", "count": 2, "stepKey": "calendar" },
    { "key": "meals", "label": "Meals + Lists", "headline": "5 nights planned · 14 items on the list",
      "detail": "Sheet-pan chicken · Crockpot chili", "count": 2, "stepKey": "meals" },
    { "key": "tasks", "label": "Chores + Rhythms", "headline": "6 tasks have an owner and a day · 1 rhythm settled",
      "detail": "Furnace filter · Air filter", "count": 2, "stepKey": "tasks" },
    { "key": "kids", "label": "Kids", "headline": "1 answer from the kids",
      "detail": "Wally · Reading", "count": 1, "stepKey": "kids" }
  ],
  "lastCall": [
    { "id": "n-camps", "note": "Look into summer camps",
      "detail": "Parked by Kevin · 2 weeks ago · passed over once" }
  ],
  "lastCallMore": 2,
  "leftAlone": [
    { "key": "step:connection", "label": "Connection", "detail": "Skipped on purpose",
      "badge": "skipped", "stepKey": "connection" },
    { "key": "goals:list-lottie", "label": "Lottie's goals", "detail": "Answered with no focus this week",
      "badge": "none", "stepKey": "goals" },
    { "key": "parked:tasks", "label": "Kelly’s parents in October?", "detail": "Parked for Tasks",
      "badge": "parked", "stepKey": "tasks" }
  ],
  "counts": { "decisions": 7, "deferred": 3, "parked": 2 }
}
""".utf8)

private func decodedRecap() throws -> WaffledAPI.PlanningRecapView {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningRecapView.self, from: recapJSON)
}

private let savedRecapJSON = Data(
    String(decoding: recapJSON, as: UTF8.self)
        .replacingOccurrences(of: "\"savedAt\": null", with: "\"savedAt\": \"2026-09-06T17:40:00.000Z\"")
        .utf8)

private func decodedSavedRecap() throws -> WaffledAPI.PlanningRecapView {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningRecapView.self, from: savedRecapJSON)
}

// MARK: - The feed

@MainActor
private final class RecapFeed {
    var view: WaffledAPI.PlanningRecapView
    var fetchFails = false
    var dropFails = false
    var fetchCount = 0
    /// A STRUCT and not a tuple: an array of tuples is not `Equatable` in Swift, so
    /// asserting "it asked for exactly this" would not compile.
    struct Ask: Equatable {
        let sessionId: String?
        let weekStart: String?
    }
    var fetchArgs: [Ask] = []
    var drops: [(id: String, sessionId: String)] = []

    init() throws {
        view = try decodedRecap()
    }
}

@MainActor
private func model(_ feed: RecapFeed) -> PlanningRecapModel {
    PlanningRecapModel(
        fetchRecap: { sessionId, weekStart in
            feed.fetchCount += 1
            feed.fetchArgs.append(RecapFeed.Ask(sessionId: sessionId, weekStart: weekStart))
            if feed.fetchFails { throw RecapFailure.rejected }
            return feed.view
        },
        dropNote: { id, sessionId in
            feed.drops.append((id, sessionId))
            if feed.dropFails { throw RecapFailure.rejected }
        })
}

// MARK: - Decoding

@Suite struct PlanningRecapDecodingTests {

    @Test func decodesTheWholeReceipt() throws {
        let r = try decodedRecap()
        #expect(r.weekStart == "2026-09-06")
        #expect(r.savedAt == nil)
        #expect(r.days.map(\.date) == [
            "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09",
            "2026-09-10", "2026-09-11", "2026-09-12",
        ])
        #expect(r.days[1].meal == "Crockpot chili")
        #expect(r.days[2].events.map(\.title) == ["Dance"])
        #expect(r.groups.map(\.key) == ["calendar", "meals", "tasks", "kids"])
        #expect(r.groups[1].label == "Meals + Lists")
        #expect(r.groups[1].stepKey == "meals")
        #expect(r.lastCall.map(\.note) == ["Look into summer camps"])
        #expect(r.lastCallMore == 2)
        #expect(r.leftAlone.map(\.badge) == ["skipped", "none", "parked"])
        #expect(r.counts.decisions == 7)
        #expect(r.counts.deferred == 3)
        #expect(r.counts.parked == 2)
    }

    @Test func carriesTheColourInputsAndNotAColour() throws {
        let dance = try #require(try decodedRecap().days[2].events.first)
        #expect(dance.personId == "p-lottie")
        #expect(dance.personColor == "#7A5AF8")
        #expect(dance.participantIds.isEmpty)
        let dentist = try #require(try decodedRecap().days[5].events.first { $0.title == "Dentist" })
        #expect(dentist.personId == "p-kevin")
        #expect(dentist.personColor == nil)
    }

    @Test func capsABusyDayAndReportsTheRemainder() throws {
        let friday = try decodedRecap().days[5]
        #expect(friday.events.count == 4)
        #expect(friday.more == 2)
    }

    @Test func aMissingParticipantIdsCostsATintAndNotTheSession() throws {
        let r = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningRecapView.self,
            from: Data("""
            { "weekStart": "2026-09-06",
              "days": [
                { "date": "2026-09-06",
                  "events": [ { "id": "ev-x", "title": "Dance", "when": "Sunday 6:00 PM" } ],
                  "more": 0 }
              ],
              "counts": { "decisions": 1, "deferred": 0, "parked": 0 } }
            """.utf8))

        #expect(r.days.count == 1)
        #expect(r.days[0].events.count == 1)
        #expect(r.days[0].events[0].participantIds.isEmpty)
        #expect(r.days[0].events[0].personId == nil)
        #expect(r.counts.decisions == 1)
    }

    @Test func aDayMissingItsEventsArrayStillRenders() throws {
        let r = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningRecapView.self,
            from: Data("""
            { "weekStart": "2026-09-06",
              "days": [ { "date": "2026-09-06", "meal": "Chili" } ] }
            """.utf8))

        #expect(r.days[0].events.isEmpty)
        #expect(r.days[0].more == 0)
        #expect(r.days[0].meal == "Chili")
        #expect(r.groups.isEmpty)
        #expect(r.lastCall.isEmpty)
        #expect(r.leftAlone.isEmpty)
        #expect(r.lastCallMore == 0)
        #expect(r.counts == WaffledAPI.PlanningRecapCounts())
    }

    @Test func anUnknownBadgeRendersAsItselfRatherThanFailing() throws {
        // The catalog is server-owned: a newer server may name a fourth outcome and must render
        // as itself, which is why `badge` is a String and not an enum.
        let row = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningRecapLeftAlone.self,
            from: Data("""
            { "key": "k", "label": "Something new", "detail": "d", "badge": "postponed", "stepKey": null }
            """.utf8))
        #expect(row.badge == "postponed")
        #expect(row.stepKey == nil)
    }
}

// MARK: - The crumb

@Suite struct PlanningRecapCrumbTests {

    @Test func theCrumbIsIntegersOnly() throws {
        let crumb = try #require(PlanningRecapCrumb.decision(try decodedRecap()))
        // The keys match `planningRecapDecision` on the web exactly — both platforms write the
        // same record.
        #expect(crumb == [
            "counts": .object([
                "decisions": .int(7),
                "deferred": .int(3),
                "parked": .int(2),
            ]),
        ])
        #expect(crumb.keys.count == 1)
    }

    @Test func nothingReadMeansNoCrumbAtAll() {
        // Not zeroes: the affirmative REPLACES the step's data, so a crumb handed up after a
        // failed fetch would write "0 decisions" over a week that really did decide things.
        #expect(PlanningRecapCrumb.decision(nil) == nil)
    }
}

// MARK: - The copy

@Suite struct PlanningRecapTextTests {

    @Test func theDinnerLineNamesTheCookOnlyWhenThereIsOne() {
        #expect(PlanningRecapText.mealLine(meal: "Lentil soup", cook: "Lottie") == "Lentil soup · Lottie")
        #expect(PlanningRecapText.mealLine(meal: "Lentil soup", cook: nil) == "Lentil soup")
        #expect(PlanningRecapText.mealLine(meal: nil, cook: "Lottie") == nil)
        #expect(PlanningRecapText.mealLine(meal: "", cook: "Lottie") == nil)
    }

    @Test func theHeaderNumberIsTheServersAndReadsAsEnglish() {
        #expect(PlanningRecapText.decisionsLabel(1) == "1 decision")
        #expect(PlanningRecapText.decisionsLabel(7) == "7 decisions")
        #expect(PlanningRecapText.lastCallMoreLabel(1) == "…and 1 more still on the board")
        #expect(PlanningRecapText.lastCallMoreLabel(2) == "…and 2 more still on the board")
    }

    @Test func dayLabelsAreReadInUTCBecauseADateIsALabel() {
        // Parsed in the device's zone a bare YYYY-MM-DD renders the previous weekday for
        // anybody west of Greenwich — the web parses at noon for the same reason.
        #expect(PlanningRecapText.dayName("2026-09-06") == "Sun")
        #expect(PlanningRecapText.dayNumber("2026-09-06") == "6")
        #expect(PlanningRecapText.dayName("2026-09-12") == "Sat")
        #expect(PlanningRecapText.dayNumber("2026-09-12") == "12")
    }
}

// MARK: - The model

@MainActor
@Suite struct PlanningRecapModelTests {

    @Test func readsTheSessionsOwnWeekAndBuildsEveryDayOnce() async throws {
        let feed = try RecapFeed()
        let model = model(feed)

        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        #expect(model.loaded)
        #expect(feed.fetchArgs == [RecapFeed.Ask(sessionId: "s-1", weekStart: "2026-09-06")])
        #expect(model.days.count == 7)
        #expect(model.days[0].dayName == "Sun")
        #expect(model.days[0].dayNumber == "6")
        #expect(model.days[2].mealLine == "Sheet-pan chicken · Lottie")
        #expect(model.days[1].mealLine == "Crockpot chili")
        #expect(model.days[5].more == 2)
    }

    @Test func handsTheColourResolverTheEventsOwnInputs() async throws {
        let feed = try RecapFeed()
        let model = model(feed)
        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        let dance = try #require(model.days[2].events.first)
        // The row carries a `SyncedEvent` so the strip goes through the app's OWN
        // `EventPalette`, precomputed once per read rather than three allocations per frame.
        #expect(dance.synced.personId == "p-lottie")
        #expect(dance.synced.colorHex == "#7A5AF8")
        #expect(dance.when == "Tuesday 6:00 PM")

        let palette = EventPalette(
            memberIds: ["p-kevin", "p-wally", "p-lottie"], familyHex: "#F97316", style: .tinted)
        let dateNight = try #require(model.days[5].events.first { $0.title == "Date night" })
        #expect(palette.hex(for: dateNight.synced) == "#F97316")
        #expect(palette.hex(for: dance.synced) == "#7A5AF8")
        let standup = try #require(model.days[5].events.first { $0.title == "Standup" })
        #expect(palette.hex(for: standup.synced) == nil)
    }

    @Test func failedReadKeepsTheWeekItAlreadyReadBack() async throws {
        let feed = try RecapFeed()
        let model = model(feed)
        await model.load(sessionId: "s-1", weekStart: "2026-09-06")
        feed.fetchFails = true

        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        #expect(model.loaded)
        #expect(model.days.count == 7)
        #expect(model.counts.decisions == 7)
        #expect(model.crumb != nil)
    }

    @Test func aFirstReadThatFailsSaysSoWithoutClaimingAnything() async throws {
        let feed = try RecapFeed()
        feed.fetchFails = true
        let model = model(feed)

        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        #expect(model.loaded)
        #expect(model.view == nil)
        #expect(model.days.isEmpty)
        #expect(model.errorMessage != nil)
        // NO CRUMB. Writing zeroes here is the wipe.
        #expect(model.crumb == nil)
    }

    @Test func keepItParkedWritesNothingAtAll() async throws {
        let feed = try RecapFeed()
        let model = model(feed)
        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        model.keepParked("n-camps")

        // THE QUIET ANSWER: the note stays open and turns up in next Sunday's step 1, so
        // nothing may be written, not even a "seen" flag.
        #expect(feed.drops.isEmpty)
        #expect(model.openLastCall.isEmpty)
        #expect(model.counts.parked == 2)
    }

    @Test func dropItGoesThroughStepOnesOwnResolver() async throws {
        let feed = try RecapFeed()
        let model = model(feed)
        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        await model.drop("n-camps", sessionId: "s-1")

        #expect(feed.drops.count == 1)
        #expect(feed.drops[0].id == "n-camps")
        #expect(feed.drops[0].sessionId == "s-1")
        #expect(model.openLastCall.isEmpty)
        #expect(feed.fetchCount == 1)
    }

    @Test func aFailedDropLeavesTheNoteOnTheBoard() async throws {
        let feed = try RecapFeed()
        feed.dropFails = true
        let model = model(feed)
        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        await model.drop("n-camps", sessionId: "s-1")

        #expect(model.openLastCall.map(\.id) == ["n-camps"])
        #expect(model.errorMessage != nil)
        #expect(model.working == nil)
    }

    @Test func nothingDecidedIsAStateAndNotAnEmptyScreen() async throws {
        let feed = try RecapFeed()
        feed.view = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningRecapView.self,
            from: Data("""
            { "weekStart": "2026-09-06", "savedAt": null, "days": [], "groups": [],
              "lastCall": [], "lastCallMore": 0, "leftAlone": [],
              "counts": { "decisions": 0, "deferred": 0, "parked": 0 } }
            """.utf8))
        let model = model(feed)

        await model.load(sessionId: "s-1", weekStart: "2026-09-06")

        #expect(model.nothingDecided)
        #expect(model.crumb == [
            "counts": .object(["decisions": .int(0), "deferred": .int(0), "parked": .int(0)]),
        ])
    }

    @Test func aSessionlessReadStillAsksForAWeek() async throws {
        let feed = try RecapFeed()
        let model = model(feed)

        await model.load(sessionId: nil, weekStart: "2026-09-06")

        #expect(feed.fetchArgs == [RecapFeed.Ask(sessionId: nil, weekStart: "2026-09-06")])
        #expect(model.days.count == 7)
    }
}

// MARK: - The tense
// The recap is rendered on two surfaces: step 10, inside a session about to be saved, and the
// finished-week record, which may be read on Thursday — so no sentence may promise what SAVING
// will do. The week itself says which it is (`savedAt`), so the two clients cannot drift.
@Suite struct PlanningRecapTenseTests {

    @Test func aWeekAboutToBeSavedReadsForward() {
        #expect(PlanningRecapText.changedTitle(saved: false) == "What tonight changed")
        #expect(PlanningRecapText.footNote(saved: false).contains("Saving writes the record"))
        #expect(PlanningRecapText.nothingDecidedDetail(saved: false).contains("Saving still records"))
    }

    @Test func aWeekAlreadySavedReadsBack() {
        #expect(PlanningRecapText.changedTitle(saved: true) == "What the session changed")
        #expect(!PlanningRecapText.footNote(saved: true).contains("Saving"))
        #expect(PlanningRecapText.footNote(saved: true).contains("was saved"))
        #expect(PlanningRecapText.nothingDecidedDetail(saved: true).contains("was saved as it stood"))
    }

    @MainActor @Test func theWeekItselfDecidesTheTense() async throws {
        let feed = try RecapFeed()
        let live = model(feed)
        await live.load(sessionId: "s1", weekStart: "2026-09-06")
        #expect(live.saved == false)

        feed.view = try decodedSavedRecap()
        let saved = model(feed)
        await saved.load(sessionId: "s1", weekStart: "2026-09-06")
        #expect(saved.saved)
    }
}
