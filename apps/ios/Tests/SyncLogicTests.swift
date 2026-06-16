import Foundation
import Testing
import SwiftUI
@testable import Nook

// Unit tests for the pure sync logic — the parts that are easy to get subtly
// wrong (mixed timestamp formats, timezone day boundaries, agenda ordering, the
// CRUD upload contract). Run: xcodebuild test -scheme Nook -destination '…'.

private let denver = TimeZone(identifier: "America/Denver")!
private let utc = TimeZone(identifier: "UTC")!

private func event(_ id: String, _ raw: String?, allDay: Bool = false) -> SyncedEvent {
    SyncedEvent(id: id, title: id, startsAtRaw: raw, startsAt: EventTime.parse(raw),
                allDay: allDay, personId: nil, colorHex: nil, emoji: nil)
}

@Suite struct EventTimeTests {
    @Test func parsesIsoZulu() {
        #expect(EventTime.parse("2026-06-16T17:49:00Z") != nil)
    }

    @Test func parsesIsoFractional() {
        #expect(EventTime.parse("2026-06-16T17:49:00.000Z") != nil)
    }

    @Test func parsesPostgresSpaceOffset() {
        // server-replicated rows look like this
        #expect(EventTime.parse("2026-06-16 17:49:00+00") != nil)
    }

    @Test func parsesPostgresMicroseconds() {
        #expect(EventTime.parse("2026-06-16 17:49:00.123456+00") != nil)
    }

    @Test func theTwoFormatsAgreeOnInstant() {
        let a = EventTime.parse("2026-06-16T17:49:00Z")
        let b = EventTime.parse("2026-06-16 17:49:00+00")
        #expect(a == b)
    }

    @Test func dateOnlyAndGarbageAreNil() {
        #expect(EventTime.parse("2026-06-16") == nil)
        #expect(EventTime.parse("not a date") == nil)
        #expect(EventTime.parse("") == nil)
        #expect(EventTime.parse(nil) == nil)
    }

    @Test func dayKeyBucketsByTimezone() {
        // 03:00 UTC on the 17th is still the 16th in Denver (UTC-6 in summer).
        let instant = EventTime.parse("2026-06-17T03:00:00Z")!
        #expect(EventTime.dayKey(instant, denver) == "2026-06-16")
        #expect(EventTime.dayKey(instant, utc) == "2026-06-17")
    }
}

@Suite struct AgendaTests {
    @Test func timedSortBeforeAllDayThenByStart() {
        let allDay = event("all", "2026-06-16", allDay: true)
        let late = event("late", "2026-06-16T23:00:00Z")
        let early = event("early", "2026-06-16T15:00:00Z")
        let sorted = [allDay, late, early].sorted(by: Agenda.before)
        #expect(sorted.map(\.id) == ["early", "late", "all"])
    }

    @Test func forDayFiltersByHouseholdTz() {
        // 03:00Z on the 17th → Denver "today" is the 16th.
        let e = event("e", "2026-06-17T03:00:00Z")
        #expect(Agenda.forDay([e], day: "2026-06-16", tz: denver).count == 1)
        #expect(Agenda.forDay([e], day: "2026-06-17", tz: denver).isEmpty)
    }

    @Test func allDayEventBucketsByLiteralDate() {
        let e = event("party", "2026-06-20", allDay: true)
        #expect(Agenda.dayKey(e, denver) == "2026-06-20")
    }

    @Test func upcomingGroupsByDayAscendingAndDropsPast() {
        let past = event("past", "2026-06-10T15:00:00Z")
        let d1a = event("d1a", "2026-06-16T20:00:00Z")
        let d1b = event("d1b", "2026-06-16T15:00:00Z")
        let d2 = event("d2", "2026-06-17T15:00:00Z")
        let groups = Agenda.upcoming([past, d2, d1a, d1b], from: "2026-06-16", tz: utc)
        #expect(groups.map(\.day) == ["2026-06-16", "2026-06-17"])
        // within a day, ordered by start
        #expect(groups[0].items.map(\.id) == ["d1b", "d1a"])
        #expect(groups[1].items.map(\.id) == ["d2"])
    }
}

@Suite struct EncodingTests {
    @Test func crudOpMatchesBackendShape() throws {
        let op = CrudOpDTO(op: "PUT", table: "events", id: "abc",
                           data: ["title": "Hi", "person_id": nil])
        let data = try JSONEncoder().encode(["ops": [op]])
        let obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let ops = try #require(obj["ops"] as? [[String: Any]])
        #expect(ops.count == 1)
        #expect(ops[0]["op"] as? String == "PUT")
        #expect(ops[0]["table"] as? String == "events")
        #expect(ops[0]["id"] as? String == "abc")
        let d = try #require(ops[0]["data"] as? [String: Any])
        #expect(d["title"] as? String == "Hi")
        #expect(d["person_id"] is NSNull)   // nil column → JSON null (server reads as null)
    }

    @Test func jsonValueEncodesMixedTypesAndNull() throws {
        // The capture-commit bodies mix strings, ints, and explicit nulls; the
        // server distinguishes a null personId from an absent one.
        let body: [String: JSONValue] = [
            "title": .string("Dishes"), "personId": .null, "rewardAmount": .int(2),
        ]
        let data = try JSONEncoder().encode(body)
        let obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(obj["title"] as? String == "Dishes")
        #expect(obj["rewardAmount"] as? Int == 2)
        #expect(obj["personId"] is NSNull)
    }
}

@Suite struct GroceryLabelTests {
    @Test func foldsQuantityIntoLabel() {
        #expect(SyncManager.groceryLabel(name: "milk", quantity: "2") == "milk (2)")
    }

    @Test func dropsMissingOrBlankQuantity() {
        #expect(SyncManager.groceryLabel(name: "milk", quantity: nil) == "milk")
        #expect(SyncManager.groceryLabel(name: "milk", quantity: "") == "milk")
        #expect(SyncManager.groceryLabel(name: "milk", quantity: "  ") == "milk")
    }
}

@Suite struct ColorTests {
    @Test func hexStringParsing() {
        #expect(Color(hexString: "#2F7FED") != nil)
        #expect(Color(hexString: "2F7FED") != nil)
        #expect(Color(hexString: "#FFF") == nil)   // wrong length
        #expect(Color(hexString: "zzzzzz") == nil)
        #expect(Color(hexString: nil) == nil)
    }
}

private enum BoomError: Error { case boom }
private final class Counter { var n = 0 }

@Suite struct RetryTests {
    // Guards the DB-open-lock fix: the first PowerSync open is retried so a
    // transient "database is locked" doesn't leave the app empty.
    @Test func succeedsOnFirstTry() async {
        let c = Counter()
        let err = await Retry.run(attempts: 3) { c.n += 1 }
        #expect(err == nil)
        #expect(c.n == 1)
    }

    @Test func retriesUntilItSucceeds() async {
        let c = Counter()
        let err = await Retry.run(attempts: 5) {
            c.n += 1
            if c.n < 3 { throw BoomError.boom }   // fail twice, then succeed
        }
        #expect(err == nil)
        #expect(c.n == 3)
    }

    @Test func givesUpAfterAllAttempts() async {
        let c = Counter()
        let err = await Retry.run(attempts: 4) {
            c.n += 1
            throw BoomError.boom
        }
        #expect(err != nil)
        #expect(c.n == 4)
    }
}

@Suite struct TonightMealTests {
    @Test func detectsEatingOutPhrases() {
        #expect(TonightMeal.isEatingOut("Takeout"))
        #expect(TonightMeal.isEatingOut("take-out"))
        #expect(TonightMeal.isEatingOut("Going out for sushi"))
        #expect(TonightMeal.isEatingOut("pizza delivery"))
        #expect(TonightMeal.isEatingOut("order in"))
        #expect(TonightMeal.isEatingOut("Eating out"))
    }

    @Test func treatsRealMealsAsCooking() {
        #expect(!TonightMeal.isEatingOut("Ravioli & Sausage Bake"))
        #expect(!TonightMeal.isEatingOut("Outback-style steak"))   // "out" inside a word
        #expect(!TonightMeal.isEatingOut(nil))
        #expect(!TonightMeal.isEatingOut(""))
    }

    @Test func recipeEntryDrivesTitleAndMeta() {
        let entry = NookAPI.WeekEntryDTO(
            id: "1", date: "2026-06-16", mealType: "dinner", title: nil, recipeId: "r1",
            recipe: .init(title: "Tacos", emoji: "🌮", cookTimeMinutes: 25, servings: 4)
        )
        let meal = TonightMeal(entry)
        #expect(meal.title == "Tacos")
        #expect(meal.emoji == "🌮")
        #expect(meal.hasRecipe)
        #expect(!meal.eatingOut)
        #expect(meal.cookTimeMinutes == 25)
        #expect(meal.servings == 4)
    }

    @Test func eatingOutEntryShowsEatingOut() {
        let entry = NookAPI.WeekEntryDTO(
            id: "2", date: "2026-06-16", mealType: "dinner", title: "Takeout night",
            recipeId: nil, recipe: nil
        )
        let meal = TonightMeal(entry)
        #expect(meal.eatingOut)
        #expect(meal.title == "Eating out")
        #expect(meal.emoji == "🍴")
    }
}

@Suite struct ListGroupingTests {
    private func item(_ id: String, section: String?) -> NookAPI.ListItemDTO {
        NookAPI.ListItemDTO(id: id, name: id, quantity: nil, checked: false, section: section, assignee: nil)
    }

    @Test func groupsAlphabeticallyByDefaultPreservingItemOrder() {
        let items = [
            item("a", section: "Produce"), item("b", section: "Pantry"),
            item("c", section: "Produce"), item("d", section: "Pantry"),
        ]
        let groups = ListGrouping.sections(items)
        #expect(groups.map(\.title) == ["Pantry", "Produce"])   // sections alphabetical
        #expect(groups.first { $0.title == "Produce" }?.items.map(\.id) == ["a", "c"])
        #expect(groups.first { $0.title == "Pantry" }?.items.map(\.id) == ["b", "d"])
    }

    @Test func preferredOrderComesFirstThenAlphabetical() {
        // Section order must be stable regardless of item order (the edit-reshuffle bug).
        let items = [
            item("z", section: "Meat & Seafood"), item("a", section: "Snacks"),
            item("p", section: "Produce"), item("b", section: "Bakery"),
        ]
        let aisles = ["Produce", "Pantry", "Dairy & Chilled", "Meat & Seafood", "Bakery", "Frozen", "Other"]
        let groups = ListGrouping.sections(items, preferredOrder: aisles)
        // canonical aisles in shopping order first, then non-aisle sections alphabetically
        #expect(groups.map(\.title) == ["Produce", "Meat & Seafood", "Bakery", "Snacks"])
    }

    @Test func ungroupedItemsFallIntoTrailingItemsGroup() {
        let items = [
            item("x", section: nil), item("y", section: "Gear"), item("z", section: nil),
        ]
        let groups = ListGrouping.sections(items)
        #expect(groups.map(\.title) == ["Gear", "Items"])   // ungrouped always last
        #expect(groups.last?.items.map(\.id) == ["x", "z"])
    }

    @Test func noSectionsMeansOneHeaderlessGroup() {
        let groups = ListGrouping.sections([item("a", section: nil), item("b", section: "")])
        #expect(groups.count == 1)
        #expect(groups[0].title == nil)
        #expect(groups[0].items.count == 2)
    }

    @Test func emptyInputYieldsNoGroups() {
        #expect(ListGrouping.sections([]).isEmpty)
    }
}

@Suite struct MealGroupingTests {
    private func gItem(_ id: String, recipes: [String]) -> NookAPI.ListItemDTO {
        NookAPI.ListItemDTO(id: id, name: id, quantity: nil, checked: false, section: nil,
                            assignee: nil, aisle: nil, sourceRecipeIds: recipes)
    }
    private func meal(_ recipeId: String?, _ title: String, date: String) -> NookAPI.GroceryBoardDTO.Meal {
        .init(recipeId: recipeId, title: title, emoji: nil, color: "#000000", date: date, mealType: "dinner")
    }

    @Test func groupsItemsUnderTheirMealInDateOrder() {
        let meals = [meal("r2", "Tue", date: "2026-06-16"), meal("r1", "Mon", date: "2026-06-15")]
        let items = [gItem("a", recipes: ["r1"]), gItem("b", recipes: ["r2"]), gItem("c", recipes: ["r1"])]
        let groups = MealGrouping.sections(items: items, meals: meals)
        #expect(groups.map { $0.meal?.title } == ["Mon", "Tue"])   // sorted by date
        #expect(groups[0].items.map(\.id) == ["a", "c"])
        #expect(groups[1].items.map(\.id) == ["b"])
    }

    @Test func sharedItemAppearsOnceUnderFirstMeal() {
        let meals = [meal("r1", "Mon", date: "2026-06-15"), meal("r2", "Tue", date: "2026-06-16")]
        let groups = MealGrouping.sections(items: [gItem("shared", recipes: ["r1", "r2"])], meals: meals)
        #expect(groups.count == 1)
        #expect(groups[0].meal?.title == "Mon")
    }

    @Test func mealLessItemsGoToTrailingExtrasGroup() {
        let meals = [meal("r1", "Mon", date: "2026-06-15")]
        let items = [gItem("milk", recipes: []), gItem("basil", recipes: ["r1"])]
        let groups = MealGrouping.sections(items: items, meals: meals)
        #expect(groups.map { $0.meal?.title } == ["Mon", nil])   // extras (nil meal) last
        #expect(groups.last?.items.map(\.id) == ["milk"])
    }
}

@Suite struct CaptureIntentTests {
    private func decode(_ json: String) throws -> CaptureIntent {
        try JSONDecoder().decode(CaptureIntent.self, from: Data(json.utf8))
    }

    @Test func decodesEvent() throws {
        let intent = try decode("""
        {"kind":"event","title":"Dentist","startsAt":"2026-06-23T20:00:00.000Z",
         "allDay":false,"personName":"Kevin","whenLabel":"Tue, Jun 23 · 2:00 PM"}
        """)
        guard case let .event(title, startsAt, allDay, person, _) = intent else {
            Issue.record("expected event"); return
        }
        #expect(title == "Dentist")
        #expect(startsAt == "2026-06-23T20:00:00.000Z")
        #expect(allDay == false)
        #expect(person == "Kevin")
    }

    @Test func decodesGroceryAndMeal() throws {
        guard case let .grocery(name, qty) =
            try decode(#"{"kind":"grocery","name":"milk","quantity":"2"}"#) else {
            Issue.record("expected grocery"); return
        }
        #expect(name == "milk")
        #expect(qty == "2")

        guard case let .meal(_, _, mealType, _) =
            try decode(#"{"kind":"meal","title":"Tacos","date":"2026-06-18","mealType":"dinner","whenLabel":"x"}"#) else {
            Issue.record("expected meal"); return
        }
        #expect(mealType == "dinner")
    }

    @Test func rejectsUnknownKind() {
        #expect(throws: (any Error).self) {
            try decode(#"{"kind":"spaceship"}"#)
        }
    }
}
