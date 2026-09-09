import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 7 (Meals). Four things carry the weight: the THREE-WAY `cards` (the body
// must OMIT THE KEY, never send a null); the undo KEEPING a night decided since; the shopper rule;
// and the receipt round-tripping `mealId`, the only dimension separating a filled title from a PLATE.

private enum MealsStepFailure: Error { case rejected }

// MARK: - The week, VERBATIM off the wire
//
// Field-for-field what `mealsStepView` returns and what the API integration test drives. The
// Sunday's meal-plan MIRROR event is absent because the server filters
// `origin in ('meal_plan','meal_prep')` out of the context.

private let weekNights = """
[
  { "date": "2026-09-06", "events": [],
    "dinner": { "entryId": "e-sun", "title": "Pasta bake", "emoji": null, "recipeId": "r-pasta",
                "mealId": null, "imageUrl": null, "cookName": "Kevin", "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-07", "events": [],
    "dinner": { "entryId": "e-mon", "title": "Fish tacos", "emoji": null, "recipeId": "r-tacos",
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-08", "events": [],
    "dinner": { "entryId": "e-tue", "title": "Leftovers", "emoji": null, "recipeId": null,
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-09",
    "events": [
      { "id": "ev-soccer", "title": "Soccer practice", "startsAt": "2026-09-09T22:30:00.000Z",
        "allDay": false, "personId": "p-lottie", "personName": "Lottie",
        "personColor": "#7A5AF8", "participantIds": [] }
    ],
    "dinner": null },
  { "date": "2026-09-10", "events": [],
    "dinner": { "entryId": "e-thu", "title": "Eating out", "emoji": null, "recipeId": null,
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-11", "events": [], "dinner": null },
  { "date": "2026-09-12", "events": [], "dinner": null }
]
"""

private let weekJSON = Data("""
{
  "weekStart": "2026-09-06",
  "nights": \(weekNights),
  "emptyDates": ["2026-09-09", "2026-09-11", "2026-09-12"],
  "groceries": { "items": 9, "checked": 2 },
  "choresOn": true,
  "shopping": null
}
""".utf8)

private let tripJSON = """
{ "choreId": "c-groceries", "personId": "p-kevin", "personName": "Kevin", "personAvatar": "🧢",
  "personColor": "#EC6049", "dueOn": "2026-09-12", "dueTime": "09:00", "status": "pending" }
"""

private let shopperJSON = Data("""
{
  "weekStart": "2026-09-06",
  "shopping": \(tripJSON),
  "view": {
    "weekStart": "2026-09-06",
    "nights": \(weekNights),
    "emptyDates": ["2026-09-09", "2026-09-11", "2026-09-12"],
    "groceries": { "items": 9, "checked": 2 },
    "choresOn": true,
    "shopping": \(tripJSON)
  }
}
""".utf8)

private let filledWeekJSON = """
{
  "weekStart": "2026-09-06",
  "nights": [
    { "date": "2026-09-06", "events": [],
      "dinner": { "entryId": "e-sun", "title": "Pasta bake", "recipeId": "r-pasta", "mealId": null,
                  "cookName": "Kevin", "minutes": null } },
    { "date": "2026-09-07", "events": [],
      "dinner": { "entryId": "e-mon", "title": "Fish tacos", "recipeId": "r-tacos", "mealId": null } },
    { "date": "2026-09-08", "events": [],
      "dinner": { "entryId": "e-tue", "title": "Leftovers", "recipeId": null, "mealId": null } },
    { "date": "2026-09-09", "events": [],
      "dinner": { "entryId": "e-wed", "title": "Chili", "recipeId": "r-chili", "mealId": null } },
    { "date": "2026-09-10", "events": [],
      "dinner": { "entryId": "e-thu", "title": "Eating out", "recipeId": null, "mealId": null } },
    { "date": "2026-09-11", "events": [],
      "dinner": { "entryId": "e-fri", "title": "Stir fry", "recipeId": "r-stir", "mealId": null } },
    { "date": "2026-09-12", "events": [],
      "dinner": { "entryId": "e-sat", "title": "Soup", "recipeId": "r-soup", "mealId": null } }
  ],
  "emptyDates": [],
  "groceries": { "items": 14, "checked": 2 },
  "choresOn": true,
  "shopping": null
}
"""

/// The receipt: `mealId` null on every claim because a fill writes recipes and titles, never plates.
private let fillJSON = Data("""
{
  "weekStart": "2026-09-06",
  "filled": [
    { "date": "2026-09-09", "entryId": "e-wed", "recipeId": "r-chili", "mealId": null, "title": null },
    { "date": "2026-09-11", "entryId": "e-fri", "recipeId": "r-stir", "mealId": null, "title": null },
    { "date": "2026-09-12", "entryId": "e-sat", "recipeId": "r-soup", "mealId": null, "title": null }
  ],
  "view": \(filledWeekJSON)
}
""".utf8)

/// The undo that hit a night somebody decided since: two cleared, ONE KEPT, still carrying it.
private let undoJSON = Data("""
{
  "weekStart": "2026-09-06",
  "cleared": ["2026-09-09", "2026-09-12"],
  "kept": ["2026-09-11"],
  "view": {
    "weekStart": "2026-09-06",
    "nights": [
      { "date": "2026-09-06", "events": [], "dinner": { "entryId": "e-sun", "title": "Pasta bake", "recipeId": "r-pasta" } },
      { "date": "2026-09-07", "events": [], "dinner": { "entryId": "e-mon", "title": "Fish tacos", "recipeId": "r-tacos" } },
      { "date": "2026-09-08", "events": [], "dinner": { "entryId": "e-tue", "title": "Leftovers", "recipeId": null } },
      { "date": "2026-09-09", "events": [], "dinner": null },
      { "date": "2026-09-10", "events": [], "dinner": { "entryId": "e-thu", "title": "Eating out", "recipeId": null } },
      { "date": "2026-09-11", "events": [], "dinner": { "entryId": "e-fri", "title": "Grandma’s", "recipeId": null } },
      { "date": "2026-09-12", "events": [], "dinner": null }
    ],
    "emptyDates": ["2026-09-09", "2026-09-12"],
    "groceries": { "items": 11, "checked": 2 },
    "choresOn": true,
    "shopping": null
  }
}
""".utf8)

/// A night that is a PLATE: recipe-less, carrying a `mealId`, named so a takeout classifier bites.
private let plateNightJSON = Data("""
{ "date": "2026-09-09", "events": [],
  "dinner": { "entryId": "e-wed", "title": "Takeout Tuesday", "emoji": null, "recipeId": null,
              "mealId": "m-copy-1", "imageUrl": null, "cookName": null, "cookAvatar": null,
              "cookColor": null, "minutes": null } }
""".utf8)

private func decodedWeek() throws -> WaffledAPI.PlanningMealsView {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsView.self, from: weekJSON)
}

// MARK: - The feed

@MainActor
private final class MealsFeed {
    var view: WaffledAPI.PlanningMealsView
    var fillResult: WaffledAPI.PlanningMealsFill
    var undoResult: WaffledAPI.PlanningMealsUndo
    var shopperResult: WaffledAPI.PlanningMealsShopperResult

    var fetchFails = false
    var fillFails = false
    var undoFails = false
    var shopperForbidden = false
    var shopperFails = false
    var holdFill = false
    var fillGate: CheckedContinuation<Void, Never>?

    var fetchCount = 0
    var fillBodies: [[String: JSONValue]] = []
    var undoBodies: [[String: JSONValue]] = []
    var shopperCalls: [(weekStart: String, dueOn: String?, personId: String?, dueTime: String?, choreId: String?)] = []
    var plannedSlots: [(date: String, recipeId: String?, title: String?)] = []
    var clearedSlots: [String] = []

    init() throws {
        view = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsView.self, from: weekJSON)
        fillResult = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsFill.self, from: fillJSON)
        undoResult = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsUndo.self, from: undoJSON)
        shopperResult = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningMealsShopperResult.self, from: shopperJSON)
    }
}

@MainActor
private func model(_ feed: MealsFeed) -> PlanningMealsModel {
    PlanningMealsModel(
        fetchView: { _, _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw MealsStepFailure.rejected }
            return feed.view
        },
        fill: { weekStart, cards in
            feed.fillBodies.append(PlanningMealsWire.fillBody(weekStart: weekStart, cards: cards))
            if feed.holdFill {
                await withCheckedContinuation { feed.fillGate = $0 }
            }
            if feed.fillFails { throw MealsStepFailure.rejected }
            feed.view = feed.fillResult.view
            return feed.fillResult
        },
        undo: { weekStart, filled in
            feed.undoBodies.append(PlanningMealsWire.undoBody(weekStart: weekStart, filled: filled))
            if feed.undoFails { throw MealsStepFailure.rejected }
            feed.view = feed.undoResult.view
            return feed.undoResult
        },
        setShopper: { weekStart, dueOn, personId, dueTime, choreId in
            feed.shopperCalls.append((weekStart, dueOn, personId, dueTime, choreId))
            if feed.shopperForbidden { throw WaffledAPI.APIError.http(403, "Forbidden") }
            if feed.shopperFails { throw MealsStepFailure.rejected }
            feed.view = feed.shopperResult.view
            return feed.shopperResult
        },
        planSlot: { date, recipeId, title in
            feed.plannedSlots.append((date, recipeId, title))
        },
        planPlate: { date, _ in
            feed.plannedSlots.append((date, nil, "plate"))
        },
        clearSlot: { date in
            feed.clearedSlots.append(date)
        })
}

// MARK: - The three-way `cards`

@Suite struct PlanningMealsFillBodyTests {

    @Test func omitsTheCardsKeyEntirelyWhenTheServerShouldDraft() throws {
        let body = PlanningMealsWire.fillBody(weekStart: "2026-09-06", cards: nil)

        // THE ASSERTION THAT MATTERS: absent, not null. A present null parses as "not a usable
        // list" and writes NOTHING while still answering 200.
        #expect(body["cards"] == nil)
        #expect(Array(body.keys) == ["weekStart"])

        let encoded = String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        #expect(!encoded.contains("cards"))
    }

    @Test func sendsAnApprovedWeekAsARealArray() throws {
        let cards = [
            WaffledAPI.PlanningMealsCard(date: "2026-09-09", title: "Approved 3"),
            WaffledAPI.PlanningMealsCard(date: "2026-09-11", recipeId: "r-chili"),
        ]
        let body = PlanningMealsWire.fillBody(weekStart: "2026-09-06", cards: cards)

        guard case let .array(sent)? = body["cards"] else {
            Issue.record("cards should be a present array")
            return
        }
        #expect(sent.count == 2)
        #expect(sent[0] == .object([
            "date": .string("2026-09-09"),
            "mealType": .string("dinner"),
            "title": .string("Approved 3"),
            "recipeId": .null,
        ]))
        #expect(sent[1] == .object([
            "date": .string("2026-09-11"),
            "mealType": .string("dinner"),
            "title": .string(""),
            "recipeId": .string("r-chili"),
        ]))
    }

    @Test func anEmptyApprovedWeekStaysPresentAndEmpty() {
        // The third case, easy to "helpfully" collapse to absent — which hands the family a week
        // they never saw.
        let body = PlanningMealsWire.fillBody(weekStart: "2026-09-06", cards: [])
        #expect(body["cards"] == .array([]))
    }
}

@Suite struct PlanningMealsUndoBodyTests {

    @Test func roundTripsEveryDimensionOfTheReceiptIncludingMealId() throws {
        let claim = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningFilledNight.self,
            from: Data("""
            { "date": "2026-09-09", "entryId": "e-wed", "recipeId": null,
              "mealId": "m-copy-1", "title": "BBQ Sunday" }
            """.utf8))

        let body = PlanningMealsWire.undoBody(weekStart: "2026-09-06", filled: [claim])

        #expect(body["weekStart"] == .string("2026-09-06"))
        #expect(body["filled"] == .array([
            .object([
                "date": .string("2026-09-09"),
                "entryId": .string("e-wed"),
                "recipeId": .null,
                // WITHOUT THIS the undo would clear a decision it never made: a filled title and a
                // hand-picked PLATE of the same name agree on entryId, recipeId and title.
                "mealId": .string("m-copy-1"),
                "title": .string("BBQ Sunday"),
            ]),
        ]))
    }

    @Test func writesExplicitNullsRatherThanOmittingFields() throws {
        let claim = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningFilledNight.self,
            from: Data("""
            { "date": "2026-09-11", "entryId": "e-fri", "recipeId": "r-stir", "mealId": null, "title": null }
            """.utf8))
        guard case let .array(sent)? = PlanningMealsWire.undoBody(weekStart: "w", filled: [claim])["filled"],
              case let .object(one) = sent[0] else {
            Issue.record("filled should be an array of objects")
            return
        }
        #expect(one["mealId"] == .null)
        #expect(one["title"] == .null)
        #expect(one.keys.count == 5)
    }
}

@Suite struct PlanningMealsShopperBodyTests {

    @Test func clearingTheTripSendsExplicitNulls() {
        // `dueOn: null` is "no trip this week" — the chore is REMOVED. A body built with `if let`
        // would omit the key and the clear would be a silent no-op.
        let body = PlanningMealsWire.shopperBody(
            weekStart: "2026-09-06", dueOn: nil, personId: nil, dueTime: nil, choreId: "c-1")
        #expect(body["dueOn"] == .null)
        #expect(body["personId"] == .null)
        #expect(body["dueTime"] == .null)
        #expect(body["choreId"] == .string("c-1"))
    }
}

// MARK: - Who may be handed the trip

@Suite struct PlanningMealsShopperCapabilityTests {

    @Test func handingTheTripToSomebodyElseNeedsChoreManage() {
        // The server's own rule, stated client-side so the picker never offers a tap that 403s.
        #expect(!PlanningMealsShopper.mayAssign(
            personId: "p-wally", myPersonId: "p-kevin", canManage: false))
        #expect(PlanningMealsShopper.mayAssign(
            personId: "p-wally", myPersonId: "p-kevin", canManage: true))
    }

    @Test func puttingItOnYourselfOrUpForGrabsNeedsNothing() {
        #expect(PlanningMealsShopper.mayAssign(
            personId: "p-kevin", myPersonId: "p-kevin", canManage: false))
        #expect(PlanningMealsShopper.mayAssign(
            personId: nil, myPersonId: "p-kevin", canManage: false))
        #expect(PlanningMealsShopper.mayAssign(personId: nil, myPersonId: nil, canManage: false))
    }

    @Test func aDeviceWithNoPersonCannotClaimTheTripForItself() {
        // A kiosk identity has no person of its own, so "that's me" is not available to it.
        #expect(!PlanningMealsShopper.mayAssign(
            personId: "p-kevin", myPersonId: nil, canManage: false))
    }
}

// MARK: - Decoding

@Suite struct PlanningMealsDecodingTests {

    @Test func decodesTheWeekTheServerNamed() throws {
        let view = try decodedWeek()
        #expect(view.weekStart == "2026-09-06")
        #expect(view.nights.map(\.date) == [
            "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09",
            "2026-09-10", "2026-09-11", "2026-09-12",
        ])
        #expect(view.emptyDates == ["2026-09-09", "2026-09-11", "2026-09-12"])
        #expect(view.nights[0].dinner?.title == "Pasta bake")
        #expect(view.nights[0].dinner?.cookName == "Kevin")
        #expect(view.nights[1].dinner?.cookName == nil)
        #expect(view.nights[1].dinner?.minutes == nil)
        #expect(view.groceries?.items == 9)
        #expect(view.groceries?.checked == 2)
        #expect(view.choresOn)
        #expect(view.shopping == nil)
    }

    @Test func keepsTheNightsEventsWithTheirColourInputs() throws {
        let wed = try decodedWeek().nights[3]
        #expect(wed.events.map(\.title) == ["Soccer practice"])
        #expect(wed.events[0].personColor == "#7A5AF8")
        #expect(wed.events[0].participantIds.isEmpty)
        #expect(!wed.events[0].allDay)
    }

    @Test func aPayloadMissingAnArrayCostsThatArrayAndNotTheWeek() throws {
        // Swift throws on a missing non-optional array where the web shrugs, so it would fail the
        // WHOLE view: a night with no `events`, and an event with no `participantIds`, must decode.
        let view = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningMealsView.self,
            from: Data("""
            { "weekStart": "2026-09-06",
              "nights": [
                { "date": "2026-09-06" },
                { "date": "2026-09-07",
                  "events": [ { "id": "ev-1", "title": "Dance", "startsAt": "2026-09-07T23:00:00.000Z", "allDay": false } ] }
              ] }
            """.utf8))
        #expect(view.nights.count == 2)
        #expect(view.nights[0].events.isEmpty)
        #expect(view.nights[1].events[0].participantIds.isEmpty)
        #expect(view.emptyDates.isEmpty)
        #expect(!view.choresOn)
        #expect(view.groceries == nil)
    }

    @Test func decodesTheFillReceiptWithMealIdNullOnEveryClaim() throws {
        let fill = try WaffledAPI.decoder.decode(WaffledAPI.PlanningMealsFill.self, from: fillJSON)
        #expect(fill.filled.map(\.date) == ["2026-09-09", "2026-09-11", "2026-09-12"])
        #expect(fill.filled.allSatisfy { $0.mealId == nil })
        #expect(fill.view.emptyDates.isEmpty)
    }
}

// MARK: - The plate branch

@Suite struct PlanningMealsPlateTests {

    @Test func aPlateIsNeverTakeoutHoweverItIsNamed() throws {
        let night = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningMealsNight.self, from: plateNightJSON)
        let dinner = try #require(night.dinner)

        // `recipeId == nil && mealId != nil` is the PLATE branch, checked BEFORE the classifier, or
        // a plate called "Takeout Tuesday" wears the takeout tile and claims "no cooking".
        #expect(dinner.mealId == "m-copy-1")
        #expect(!PlanningMealsText.isEatingOut(dinner))
        #expect(PlanningMealsText.attribution(dinner, auto: false, eatingOut: false) == "a whole plate")
    }

    @Test func aRecipelessTakeoutTitleStillReadsAsTakeout() throws {
        let dinner = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningNightDinner.self,
            from: Data("""
            { "entryId": "e-thu", "title": "Eating out", "recipeId": null, "mealId": null }
            """.utf8))
        #expect(PlanningMealsText.isEatingOut(dinner))
        #expect(PlanningMealsText.attribution(dinner, auto: false, eatingOut: true) == "no cooking")
    }
}

// MARK: - The copy

@Suite struct PlanningMealsTextTests {

    @Test func smallCountsReadAsWords() {
        #expect(PlanningMealsText.countWord(3) == "three")
        #expect(PlanningMealsText.countWord(1) == "one")
        #expect(PlanningMealsText.countWord(9) == "9")
    }

    @Test func theKeptNoteNamesTheNightsItWalkedPast() {
        #expect(PlanningMealsText.keptSentence([]) == nil)
        #expect(PlanningMealsText.keptSentence(["2026-09-11"])
            == "one night was left alone — Fri has been decided since.")
        #expect(PlanningMealsText.keptSentence(["2026-09-11", "2026-09-12"])
            == "two nights were left alone — Fri, Sat have been decided since.")
    }

    @Test func theTripPillSaysUpForGrabsRatherThanNothing() throws {
        #expect(PlanningMealsText.tripLabel(nil) == "Who's shopping?")

        let unassigned = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningShoppingTrip.self,
            from: Data("""
            { "choreId": "c-1", "personId": null, "personName": null, "personAvatar": null,
              "personColor": null, "dueOn": "2026-09-12", "dueTime": "09:00", "status": "pending" }
            """.utf8))
        #expect(PlanningMealsText.tripLabel(unassigned) == "Up for grabs · Sat 09:00")

        let assigned = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningShoppingTrip.self,
            from: Data("""
            { "choreId": "c-1", "personId": "p-kevin", "personName": "Kevin", "personAvatar": "🧢",
              "personColor": "#EC6049", "dueOn": "2026-09-12", "dueTime": null, "status": "pending" }
            """.utf8))
        #expect(PlanningMealsText.tripLabel(assigned) == "🧢 Kevin shops Sat")
    }

    @Test func theGroceryLineOnlyClaimsWhatWasMeasured() {
        #expect(PlanningMealsText.grocerySub(added: nil)
            == "built from what's planned so far · staples skipped")
        #expect(PlanningMealsText.grocerySub(added: 5) == "5 items added · staples skipped")
    }

    @Test func anAllDayEventSaysSoAndAnUnreadableInstantSaysNothing() throws {
        let allDay = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningNightEvent.self,
            from: Data("""
            { "id": "ev-1", "title": "School closed", "startsAt": "2026-09-09T00:00:00.000Z",
              "allDay": true, "participantIds": [] }
            """.utf8))
        #expect(PlanningMealsText.clock(allDay) == "All day")

        let unreadable = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningNightEvent.self,
            from: Data("""
            { "id": "ev-2", "title": "Odd one", "startsAt": "not a timestamp", "allDay": false }
            """.utf8))
        #expect(PlanningMealsText.clock(unreadable) == "")
    }

    @Test func dayLabelsAreReadInUTCBecauseADateIsALabel() {
        // In a negative-offset zone a bare YYYY-MM-DD parses to the day before, shifting the week.
        #expect(PlanningMealsText.dow("2026-09-06") == "Sun")
        #expect(PlanningMealsText.monthDay("2026-09-06") == "Sep 6")
    }
}

// MARK: - The crumb

@Suite struct PlanningMealsCrumbTests {

    @Test func readsOnlyRealDaysOutOfWhateverTheSessionKept() {
        // `step.data` is free-form by the time it comes back, so it is filtered rather than trusted.
        let data: [String: JSONValue] = [
            "autoFilled": .array([
                .string("2026-09-09"), .string("nope"), .int(7), .string("2026-9-9"),
                .string("2026-09-12"),
            ]),
        ]
        #expect(PlanningMealsCrumb.dates(data) == ["2026-09-09", "2026-09-12"])
        #expect(PlanningMealsCrumb.dates(nil).isEmpty)
        #expect(PlanningMealsCrumb.dates(["autoFilled": .string("2026-09-09")]).isEmpty)
    }
}

// MARK: - The model

@MainActor
@Suite struct PlanningMealsModelTests {

    @Test func failedReadKeepsTheWeekItAlreadyHadAndStillLoads() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        feed.fetchFails = true

        await model.reread(weekStart: "2026-09-06")

        #expect(model.loaded)
        #expect(model.rows.count == 7)
        #expect(model.rows[0].dinner?.title == "Pasta bake")
    }

    @Test func theCrumbIsNilUntilTheAppHasActuallyPickedANight() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        // No ✨ anywhere ⇒ nil, matching the web. An empty list would be a claim, not an absence.
        #expect(model.crumb == nil)
    }

    @Test func theCrumbRestoresTheMarksButNeverTheUndo() async throws {
        let feed = try MealsFeed()
        let model = model(feed)

        await model.load(weekStart: "2026-09-06", seed: ["2026-09-06", "2026-09-09"])

        #expect(model.autoMarks == ["2026-09-06"])
        #expect(model.rows[0].auto)
        #expect(model.rows[0].attribution == "👤 Kevin") // a real cook still outranks ✨
        #expect(model.crumb == ["autoFilled": .array([.string("2026-09-06")])])

        // AND THE UNDO IS NOT LIVE: a rebuilt claim would be compared against its own source row.
        #expect(model.filled.isEmpty)
    }

    @Test func fillingMarksTheNightsMeasuresTheGroceriesAndArmsTheUndo() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        let landed = await model.planTheRest(weekStart: "2026-09-06")

        #expect(landed)
        // The one that would be catastrophic: iOS drafts headlessly, so the key is absent.
        #expect(feed.fillBodies.count == 1)
        #expect(feed.fillBodies[0]["cards"] == nil)

        #expect(model.filled.map(\.date) == ["2026-09-09", "2026-09-11", "2026-09-12"])
        #expect(model.crumb == ["autoFilled": .array([
            .string("2026-09-09"), .string("2026-09-11"), .string("2026-09-12"),
        ])])
        #expect(model.groceryAdded == 5)
        let wed = try #require(model.rows.first { $0.date == "2026-09-09" })
        #expect(wed.auto)
        #expect(wed.attribution == "the app picked this")
        #expect(model.emptyDates.isEmpty)
    }

    @Test func undoKeepsANightSomebodyDecidedSinceAndSaysSo() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        await model.planTheRest(weekStart: "2026-09-06")

        let landed = await model.undoTheFill(weekStart: "2026-09-06")

        #expect(landed)
        // The claim went out with all three nights — the SERVER decides which are still undoable.
        guard case let .array(sent)? = feed.undoBodies[0]["filled"] else {
            Issue.record("the undo must send its receipt")
            return
        }
        #expect(sent.count == 3)

        #expect(model.kept == ["2026-09-11"])
        // A kept night leaves the undoable set WITHOUT being cleared, so a second tap can't return.
        #expect(model.filled.isEmpty)
        #expect(model.autoMarks.isEmpty)
        let fri = try #require(model.rows.first { $0.date == "2026-09-11" })
        #expect(fri.dinner?.title == "Grandma’s")
        #expect(!fri.auto)
        #expect(PlanningMealsText.keptSentence(model.kept)
            == "one night was left alone — Fri has been decided since.")
        #expect(model.crumb == nil)
    }

    @Test func aFailedFillChangesNothingAndSaysWhy() async throws {
        let feed = try MealsFeed()
        feed.fillFails = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        let landed = await model.planTheRest(weekStart: "2026-09-06")

        #expect(!landed)
        #expect(model.filled.isEmpty)
        #expect(model.errorMessage != nil)
        #expect(feed.fetchCount == 1)
        #expect(model.emptyDates == ["2026-09-09", "2026-09-11", "2026-09-12"])
    }

    @Test func undoDoesNothingWithoutALiveReceipt() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: ["2026-09-06"])

        // A restored MARK is not a receipt, so there is nothing to take back.
        let landed = await model.undoTheFill(weekStart: "2026-09-06")

        #expect(!landed)
        #expect(feed.undoBodies.isEmpty)
    }

    @Test func decidingANightByHandStopsItBeingAnAutoFill() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        await model.planTheRest(weekStart: "2026-09-06")
        #expect(model.filled.count == 3)

        feed.view = feed.fillResult.view
        let landed = await model.planNight(
            weekStart: "2026-09-06", date: "2026-09-11", recipeId: "r-curry", title: nil)

        #expect(landed)
        #expect(feed.plannedSlots.map { $0.date } == ["2026-09-11"])
        #expect(feed.plannedSlots[0].recipeId == "r-curry")
        #expect(model.filled.map(\.date) == ["2026-09-09", "2026-09-12"])
        #expect(model.crumb == ["autoFilled": .array([
            .string("2026-09-09"), .string("2026-09-12"),
        ])])
    }

    @Test func aHandWriteForgetsTheStarEvenIfTheReReadFails() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        await model.planTheRest(weekStart: "2026-09-06")

        // The write lands, the re-read after it does not. The loading contract keeps the previous
        // view — which must NOT keep the ✨, or the tile claims a night somebody just decided.
        feed.fetchFails = true
        let landed = await model.planNight(
            weekStart: "2026-09-06", date: "2026-09-11", recipeId: "r-curry", title: nil)

        #expect(landed)
        let fri = try #require(model.rows.first { $0.date == "2026-09-11" })
        #expect(!fri.auto)
        #expect(fri.attribution != "the app picked this")
        #expect(model.crumb == ["autoFilled": .array([
            .string("2026-09-09"), .string("2026-09-12"),
        ])])
    }

    @Test func clearingANightGoesThroughTheMealsScreensOwnDelete() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        #expect(await model.clearNight(weekStart: "2026-09-06", date: "2026-09-08"))
        #expect(feed.clearedSlots == ["2026-09-08"])
    }

    @Test func assigningTheTripReadsItBackOffTheChoreAndKeepsItsIdForNextTime() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        #expect(model.choreHint == nil)

        #expect(await model.setShopper(
            weekStart: "2026-09-06", dueOn: "2026-09-12", personId: "p-kevin", dueTime: "09:00"))

        #expect(model.view?.shopping?.choreId == "c-groceries")
        #expect(model.view?.shopping?.personName == "Kevin")
        #expect(PlanningMealsText.tripLabel(model.view?.shopping) == "🧢 Kevin shops Sat 09:00")
        // A shopper write must not refetch the week — the answer already carries it.
        #expect(feed.fetchCount == 1)

        // AND THE HINT NOW TRAVELS: it keeps a renamed chore recognised as this week's trip.
        #expect(model.choreHint == "c-groceries")
        #expect(await model.setShopper(
            weekStart: "2026-09-06", dueOn: "2026-09-11", personId: nil, dueTime: nil))
        #expect(feed.shopperCalls.count == 2)
        #expect(feed.shopperCalls[1].choreId == "c-groceries")
        // Up for grabs goes out as an explicit null, not as "leave the assignee alone".
        #expect(PlanningMealsWire.shopperBody(
            weekStart: "2026-09-06", dueOn: "2026-09-11", personId: nil,
            dueTime: nil, choreId: "c-groceries")["personId"] == .null)
    }

    @Test func aRefusedShopperWriteLeavesTheTripAloneAndDoesNotRefetch() async throws {
        let feed = try MealsFeed()
        feed.shopperForbidden = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        let landed = await model.setShopper(
            weekStart: "2026-09-06", dueOn: "2026-09-12", personId: "p-wally", dueTime: "09:00")

        #expect(!landed)
        #expect(model.errorMessage == "Only a parent can hand the shopping to somebody else.")
        #expect(model.view?.shopping == nil)
        #expect(feed.fetchCount == 1)
        #expect(feed.shopperCalls.count == 1)
        #expect(feed.shopperCalls[0].choreId == nil) // no trip yet, so nothing to hint with
    }

    @Test func oneWriteAtATimeAndTheSecondSaysSoRatherThanReturningQuietly() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        // The first fill is parked inside the stub, so the second genuinely arrives while a write
        // is in flight. A quiet `return` there would report a week that was never written.
        feed.holdFill = true
        let first = Task { await model.planTheRest(weekStart: "2026-09-06") }
        var spins = 0
        while feed.fillGate == nil && spins < 1_000 {
            await Task.yield()
            spins += 1
        }
        try #require(feed.fillGate != nil)

        let second = await model.planTheRest(weekStart: "2026-09-06")

        feed.fillGate?.resume()
        feed.fillGate = nil
        let landed = await first.value

        #expect(landed)
        #expect(!second)
        #expect(feed.fillBodies.count == 1)
        #expect(model.errorMessage != nil)
    }
}

// MARK: - The store the body and the footer share

/// `.serialized` because these cases share the process-wide store the body and the footer meet in.
/// The first `await` anybody adds would make them flaky, and the flake would look like a store bug.
@MainActor
@Suite(.serialized) struct PlanningMealsStepStoreTests {

    @Test func theBodyAndTheFooterGetTheSAMEModel() throws {
        let store = PlanningMealsStepStore.shared
        store.reset()
        let feed = try MealsFeed()

        // The body resolves first, the footer second. Two models and the footer's ✨ never lands.
        let body = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })
        let footer = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })

        #expect(body === footer)
        store.reset()
    }

    @Test func steppingToAnotherWeekCannotInheritTheLastWeeksMarks() throws {
        let store = PlanningMealsStepStore.shared
        store.reset()
        let feed = try MealsFeed()

        let first = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })
        let next = store.model(sessionId: "s-2", weekStart: "2026-09-13", make: { model(feed) })

        #expect(first !== next)
        // Single-slot: asking for the old key builds a fresh model, so a stale receipt can't live.
        let again = store.model(sessionId: "s-1", weekStart: "2026-09-06", make: { model(feed) })
        #expect(again !== first)
        store.reset()
    }

    @Test func theKeyIsSpelledInExactlyOnePlace() {
        #expect(PlanningMealsStepStore.key(sessionId: "s-1", weekStart: "2026-09-06")
            == "s-1|2026-09-06")
    }
}

// MARK: - "Plan the rest" brings up the planner
//
// The web's footer control does exactly one thing — `set({ planner: true })` — and the shared
// planner renders from the step BODY off the same store, because the two are sibling trees. So the
// presentation flag has to live on the MODEL, which is also the only place a test can reach it.

@MainActor
@Suite struct PlanningMealsPlannerTests {

    @Test func theControlOpensThePlannerAndWritesNothingByItself() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        #expect(!model.plannerOpen)
        model.openPlanner()

        #expect(model.plannerOpen)
        // THE REGRESSION GUARD: tapping the control must not draft a week nobody has seen.
        #expect(feed.fillBodies.isEmpty)
        #expect(model.filled.isEmpty)
    }

    /// Every night planned ⇒ nothing to draft. Belt on the model, not just the disabled control.
    @Test func aFullWeekCannotOpenThePlanner() async throws {
        let feed = try MealsFeed()
        feed.view = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningMealsView.self,
            from: Data("""
            { "weekStart": "2026-09-06", "nights": [], "emptyDates": [],
              "groceries": null, "choresOn": false, "shopping": null }
            """.utf8))
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])

        model.openPlanner()
        #expect(!model.plannerOpen)
    }

    @Test func theSheetCanCloseItself() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        model.openPlanner()

        model.setPlanner(false)
        #expect(!model.plannerOpen)
    }

    /// The point of routing the approved week through the step's OWN fill endpoint: it refuses a
    /// night somebody already decided and hands back the receipt. So the cards travel as an ARRAY.
    @Test func theApprovedWeekTravelsAsARealArrayAndClosesThePlanner() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        model.openPlanner()

        let approved = [
            planCard("2026-09-09", title: "Sheet-pan chicken", recipeId: "r-sheet"),
            planCard("2026-09-11", title: "Chili", recipeId: nil),
            planCard("2026-09-12", title: "Ramen", recipeId: "r-ramen"),
        ]
        let landed = await model.applyPlan(weekStart: "2026-09-06", approved: approved)

        #expect(landed)
        #expect(!model.plannerOpen)
        #expect(feed.fillBodies.count == 1)
        guard case let .array(sent)? = feed.fillBodies[0]["cards"] else {
            Issue.record("the approved week must travel as a present array")
            return
        }
        #expect(sent.count == 3)
        #expect(model.filled.map(\.date) == ["2026-09-09", "2026-09-11", "2026-09-12"])
    }

    /// A week that narrows to nothing must NOT be sent. `cards: []` is "present but not a usable
    /// list", answered 200 while writing nothing — so firing it would report a week never planned.
    @Test func anApprovedWeekThatNarrowsToNothingIsNeverSent() async throws {
        let feed = try MealsFeed()
        let model = model(feed)
        await model.load(weekStart: "2026-09-06", seed: [])
        model.openPlanner()

        let landed = await model.applyPlan(
            weekStart: "2026-09-06",
            approved: [planCard("2026-09-06", title: "Nope", recipeId: nil),
                       planCard("2026-09-07", title: "Also nope", recipeId: nil)])

        #expect(!landed)
        #expect(feed.fillBodies.isEmpty)
        #expect(!model.plannerOpen)
        #expect(model.errorMessage != nil)
    }
}

// MARK: - Narrowing the shared planner to this step's promise

@Suite struct PlanningMealsPlanNarrowingTests {

    /// The day chips are the EMPTY nights, and they must round-trip through the planner's own key,
    /// `yyyy-MM-dd` in the HOUSEHOLD's zone — get the zone wrong and no chip is selected.
    @Test func theEmptyNightsBecomeDatesThatRoundTripInTheHouseholdZone() {
        let tz = TimeZone(identifier: "America/Los_Angeles")!
        let days = PlanningMealsPlan.plannerDays(["2026-09-09", "2026-09-11", "2026-09-12"], tz: tz)

        #expect(days.count == 3)
        #expect(days.map { DateFmt.string($0, "yyyy-MM-dd", tz) }
            == ["2026-09-09", "2026-09-11", "2026-09-12"])
        // NOON, not midnight: a day pinned at midnight is one DST transition away from
        // being the day before, and the planner reads the weekday back off this Date.
        #expect(days.map { Cal.gregorian(tz).component(.hour, from: $0) } == [12, 12, 12])
    }

    /// East of Greenwich too — the failure is asymmetric, so one zone proves nothing.
    @Test func andInAZoneAheadOfUTC() {
        let tz = TimeZone(identifier: "Australia/Sydney")!
        let days = PlanningMealsPlan.plannerDays(["2026-09-09"], tz: tz)
        #expect(days.map { DateFmt.string($0, "yyyy-MM-dd", tz) } == ["2026-09-09"])
    }

    @Test func rubbishInIsDroppedRatherThanBecomingSomeOtherDay() {
        let tz = TimeZone(identifier: "UTC")!
        #expect(PlanningMealsPlan.plannerDays(["not-a-day", ""], tz: tz).isEmpty)
    }

    /// The approved cards, narrowed to what this step promised: DINNERS, on the nights still empty.
    @Test func onlyDinnersOnStillEmptyNightsTravel() {
        let cards = PlanningMealsPlan.cards(
            from: [
                planCard("2026-09-09", title: "Sheet-pan chicken", recipeId: "r-sheet"),
                planCard("2026-09-07", title: "Already decided", recipeId: nil),
                planCard("2026-09-11", title: "Lunchtime soup", recipeId: nil, mealType: "lunch"),
                planCard("2026-09-12", title: "Ramen", recipeId: "r-ramen"),
            ],
            emptyDates: ["2026-09-09", "2026-09-11", "2026-09-12"])

        #expect(cards.map(\.date) == ["2026-09-09", "2026-09-12"])
        #expect(cards.allSatisfy { $0.mealType == "dinner" })
        #expect(cards[0].recipeId == "r-sheet")
        #expect(cards[0].title == "Sheet-pan chicken")
        let bare = PlanningMealsPlan.cards(
            from: [planCard("2026-09-11", title: "Chili", recipeId: nil)],
            emptyDates: ["2026-09-11"])
        #expect(bare.count == 1)
        #expect(bare[0].recipeId == nil)
        #expect(bare[0].title == "Chili")
    }

    @Test func aCardWithNothingOnItIsDropped() {
        let cards = PlanningMealsPlan.cards(
            from: [planCard("2026-09-09", title: "   ", recipeId: nil)],
            emptyDates: ["2026-09-09"])
        #expect(cards.isEmpty)
    }

    @Test func theNoteNamesHowManyNightsAreInPlayAndWhatIsLeftAlone() {
        #expect(PlanningMealsText.plannerNote(3)
            == "Planning the three empty nights — the rest stay as they are.")
        #expect(PlanningMealsText.plannerNote(1)
            == "Planning the one empty night — the rest stay as they are.")
    }
}

/// One AI-drafted card off `POST /api/meals/plan-week`, as the planner hands it back.
private func planCard(
    _ date: String, title: String, recipeId: String?, mealType: String = "dinner"
) -> WaffledAPI.PlanCardDTO {
    WaffledAPI.PlanCardDTO(
        date: date, mealType: mealType, title: title, recipeId: recipeId,
        emoji: nil, minutes: nil, servings: nil, note: nil)
}
