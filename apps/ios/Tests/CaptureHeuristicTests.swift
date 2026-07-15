import Testing
import Foundation
@testable import Waffled

/// Mirrors the web `apps/web/src/lib/capture/parse.test.ts` — keep these in sync with the
/// parser (`CaptureHeuristic.swift` ↔ `parse.ts`).
private let people = ["Wally", "Kelly", "Kevin", "Lottie"]

private var pinnedCal: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "America/Denver")!
    c.locale = Locale(identifier: "en_US_POSIX")
    return c
}
// Fixed "now": Thursday, June 11 2026, 9:00 AM (matches parse.test.ts).
private var pinnedNow: Date {
    pinnedCal.date(from: DateComponents(year: 2026, month: 6, day: 11, hour: 9, minute: 0, second: 0))!
}

private func p(_ s: String, lists: [String] = []) -> CaptureIntent? {
    CaptureHeuristic.parse(s, persons: people, now: pinnedNow, cal: pinnedCal, lists: lists)
}

// MARK: extractors

private func asEvent(_ i: CaptureIntent?) -> (title: String, startsAt: String, allDay: Bool, person: String?, rrule: String?, schedule: String, when: String)? {
    if case let .event(t, s, a, pe, r, sc, w) = i { return (t, s, a, pe, r, sc, w) }
    return nil
}
private func asTask(_ i: CaptureIntent?) -> (title: String, person: String?, stars: Int?, rrule: String?, schedule: String)? {
    if case let .task(t, pe, st, r, sc) = i { return (t, pe, st, r, sc) }
    return nil
}
private func asMeal(_ i: CaptureIntent?) -> (title: String, date: String?, mealType: String, when: String)? {
    if case let .meal(t, d, mt, w) = i { return (t, d, mt, w) }
    return nil
}
private func asCountdown(_ i: CaptureIntent?) -> (title: String, date: String, emoji: String?, when: String)? {
    if case let .countdown(t, d, e, w) = i { return (t, d, e, w) }
    return nil
}
private func asPerson(_ i: CaptureIntent?) -> (name: String, memberType: String, avatarEmoji: String?, birthday: String?, isAdmin: Bool)? {
    if case let .person(n, mt, e, b, a) = i { return (n, mt, e, b, a) }
    return nil
}
private func asGoal(_ i: CaptureIntent?) -> (title: String, goalType: String, targetValue: Double?, unit: String?, deadline: String?, trackingMode: String, audience: String?)? {
    if case let .goal(t, gt, tv, u, d, tm, au) = i { return (t, gt, tv, u, d, tm, au) }
    return nil
}
private func asPantry(_ i: CaptureIntent?) -> (name: String, amount: String?, unit: String?, location: String, expiresOn: String?, lowAt: Double?)? {
    if case let .pantry(n, a, u, l, e, low) = i { return (n, a, u, l, e, low) }
    return nil
}
private func asGrocery(_ i: CaptureIntent?) -> (name: String, quantity: String?)? {
    if case let .grocery(n, q) = i { return (n, q) }
    return nil
}
private func asReward(_ i: CaptureIntent?) -> (title: String, emoji: String?, cost: Int?, currency: String?, category: String?, requiresApproval: Bool?)? {
    if case let .reward(t, e, c, cur, cat, ra) = i { return (t, e, c, cur, cat, ra) }
    return nil
}

private func iso(_ s: String) -> Date {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: s)!
}
private func hour(_ s: String) -> Int { pinnedCal.component(.hour, from: iso(s)) }
private func minute(_ s: String) -> Int { pinnedCal.component(.minute, from: iso(s)) }
private func dom(_ s: String) -> Int { pinnedCal.component(.day, from: iso(s)) }
private func dow(_ s: String) -> Int { pinnedCal.component(.weekday, from: iso(s)) - 1 }   // 0=Sun
private func mon(_ s: String) -> Int { pinnedCal.component(.month, from: iso(s)) }          // 1-based
private func year(_ s: String) -> Int { pinnedCal.component(.year, from: iso(s)) }
/// Weekday of a "YYYY-MM-DD" string, read in the pinned tz (0=Sun).
private func dowOfDate(_ s: String) -> Int {
    let parts = s.split(separator: "-").map { Int($0)! }
    let d = pinnedCal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))!
    return pinnedCal.component(.weekday, from: d) - 1
}

@Suite struct CaptureHeuristicEventTests {
    @Test func placeholderExample() {
        let e = asEvent(p("Soccer Tue 4pm for Wally"))!
        #expect(e.title == "Soccer")
        #expect(e.person == "Wally")
        #expect(e.allDay == false)
        #expect(dow(e.startsAt) == 2)
        #expect(hour(e.startsAt) == 16)
    }
    @Test func tomorrowAllDay() {
        let e = asEvent(p("Dentist tomorrow"))!
        #expect(e.title == "Dentist")
        #expect(e.allDay == true)
        #expect(dom(e.startsAt) == 12)
    }
    @Test func tonightEvening() {
        let e = asEvent(p("Movie night tonight"))!
        #expect(e.allDay == false)
        #expect(hour(e.startsAt) == 18)
        #expect(dom(e.startsAt) == 11)
    }
    @Test func timeWithMinutes() {
        let e = asEvent(p("Call plumber today at 3:30pm"))!
        #expect(hour(e.startsAt) == 15)
        #expect(minute(e.startsAt) == 30)
        #expect(e.title == "Call plumber")
    }
    @Test func monthDayFuture() {
        let e = asEvent(p("Trip Aug 5"))!
        #expect(mon(e.startsAt) == 8)
        #expect(dom(e.startsAt) == 5)
        #expect(year(e.startsAt) == 2026)
    }
    @Test func pastMonthRollsToNextYear() {
        #expect(year(asEvent(p("Reunion jan 3"))!.startsAt) == 2027)
    }
    @Test func nextFriday() {
        let e = asEvent(p("Date night next friday"))!
        #expect(dow(e.startsAt) == 5)
        #expect(dom(e.startsAt) == 19)
    }
}

@Suite struct CaptureHeuristicRecurringTests {
    @Test func everyTuesday() {
        let e = asEvent(p("soccer every Tuesday at 4pm for Wally"))!
        #expect(e.title == "Soccer")
        #expect(e.person == "Wally")
        #expect(e.rrule == "FREQ=WEEKLY;BYDAY=TU")
        #expect(dow(e.startsAt) == 2)
        #expect(hour(e.startsAt) == 16)
    }
    @Test func everyWeekday() {
        let e = asEvent(p("standup every weekday at 9am"))!
        #expect(e.rrule == "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")
        #expect(hour(e.startsAt) == 9)
    }
    @Test func everyDay() {
        #expect(asEvent(p("team huddle every day at 9am"))!.rrule == "FREQ=DAILY")
    }
    @Test func monthly() {
        let e = asEvent(p("book club monthly"))!
        #expect(e.title == "Book club")
        #expect(e.rrule == "FREQ=MONTHLY")
    }
    @Test func everyOther() {
        #expect(asEvent(p("yoga every other tuesday at 6pm"))!.rrule == "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU")
    }
    @Test func pluralWeekday() {
        #expect(asEvent(p("trash pickup tuesdays"))!.rrule == "FREQ=WEEKLY;BYDAY=TU")
    }
    @Test func bareWeekdayIsOneOff() {
        #expect(asEvent(p("Soccer Tue 4pm for Wally"))!.rrule == nil)
    }
    @Test func stripsCommandAndCalendar() {
        let e = asEvent(p("Add gymnastics to Lottie's calendar every Tuesday at noon"))!
        #expect(e.title == "Gymnastics")
        #expect(e.person == "Lottie")
        #expect(e.rrule == "FREQ=WEEKLY;BYDAY=TU")
        #expect(hour(e.startsAt) == 12)
    }
}

@Suite struct CaptureHeuristicGroceryTests {
    @Test func bareNoun() {
        if case let .grocery(name, q) = p("milk") { #expect(name == "Milk"); #expect(q == nil) } else { Issue.record("not grocery") }
    }
    @Test func stripVerb() {
        if case let .grocery(name, q) = p("buy almond milk") { #expect(name == "Almond milk"); #expect(q == nil) } else { Issue.record("not grocery") }
    }
    @Test func quantityUnit() {
        if case let .grocery(name, q) = p("2 lbs chicken thighs") { #expect(name == "Chicken thighs"); #expect(q == "2 lbs") } else { Issue.record("not grocery") }
    }
    @Test func addToList() {
        if case let .grocery(name, q) = p("add paper towels to the grocery list") { #expect(name == "Paper towels"); #expect(q == nil) } else { Issue.record("not grocery") }
    }
}

@Suite struct CaptureHeuristicTaskTests {
    @Test func remind() {
        let t = asTask(p("remind take out the trash for Wally"))!
        #expect(t.person == "Wally")
        #expect(t.title.lowercased().contains("trash"))
    }
    @Test func choreWithStars() {
        let t = asTask(p("chore walk the dog for Kelly 5 stars"))!
        #expect(t.person == "Kelly")
        #expect(t.stars == 5)
        #expect(t.title.lowercased().contains("walk the dog"))
    }
    @Test func choreBeatsDate() {
        let t = asTask(p("please make Wally a chore to take out the trash on Wednesday night and Sunday night."))!
        #expect(t.person == "Wally")
        #expect(t.title == "Take out the trash")
        #expect(t.rrule == "FREQ=WEEKLY;BYDAY=WE,SU")
        #expect(t.schedule == "Wed & Sun")
    }
    @Test func quotedTitle() {
        let t = asTask(p("Please add \"Take Out the Trash as a Chore\" for Lottie on Tuesday and Thursday."))!
        #expect(t.title == "Take Out the Trash")
        #expect(t.person == "Lottie")
        #expect(t.rrule == "FREQ=WEEKLY;BYDAY=TU,TH")
        #expect(t.schedule == "Tue & Thu")
    }
    @Test func possessiveDestination() {
        let t = asTask(p("Please add laundry for Monday, Wednesday, and Saturday to Kelly's chore list."))!
        #expect(t.title == "Laundry")
        #expect(t.person == "Kelly")
        #expect(t.rrule == "FREQ=WEEKLY;BYDAY=MO,WE,SA")
        #expect(t.schedule == "Mon & Wed & Sat")
    }
    @Test func dailyChore() {
        let t = asTask(p("chore for Kevin to make the bed every day"))!
        #expect(t.rrule == "FREQ=DAILY")
        #expect(t.title.lowercased().contains("make the bed"))
    }
}

@Suite struct CaptureHeuristicMealTests {
    @Test func mealPlan() {
        let m = asMeal(p("lets put shawarma on the meal plan"))!
        #expect(m.title == "Shawarma")
        #expect(m.mealType == "dinner")
        #expect(m.date == nil)
    }
    @Test func slotAndDay() {
        let m = asMeal(p("tacos for lunch on Friday"))!
        #expect(m.title.lowercased().contains("tacos"))
        #expect(m.mealType == "lunch")
        #expect(dowOfDate(m.date!) == 5)
    }
    @Test func dinnerWithTimeIsEvent() {
        #expect(asEvent(p("dinner with grandma at 6pm")) != nil)
    }
    @Test func eatingOut() {
        let m = asMeal(p("we're eating out friday"))!
        #expect(m.title == "Eating out")
        #expect(dowOfDate(m.date!) == 5)
    }
    @Test func reservationIsEvent() {
        #expect(asEvent(p("eating out at 7pm on friday")) != nil)
    }
}

@Suite struct CaptureHeuristicCountdownTests {
    @Test func daysUntil() {
        let c = asCountdown(p("12 days until Disney"))!
        #expect(c.title == "Disney")
        #expect(c.date == "2026-06-23") // June 11 + 12 days
    }
    @Test func inNDays() {
        let c = asCountdown(p("Disney in 12 days"))!
        #expect(c.title == "Disney")
        #expect(c.date == "2026-06-23")
    }
    @Test func sleepsUntil() {
        let c = asCountdown(p("10 sleeps until Christmas"))!
        #expect(c.title == "Christmas")
        #expect(c.date == "2026-06-21") // June 11 + 10 days
    }
    @Test func countdownToExplicitDate() {
        let c = asCountdown(p("countdown to the beach party on August 25"))!
        #expect(c.title == "Beach party")
        #expect(c.date == "2026-08-25")
    }
    @Test func clockTimeIsEvent() {
        #expect(asEvent(p("countdown to New Year at 6pm")) != nil)
    }

    // The nth <weekday0> (0=Sun) of a month, as a "YYYY-MM-DD" string in the pinned tz.
    private func nthWeekday(_ year: Int, _ month: Int, _ weekday0: Int, _ n: Int) -> String {
        let first = pinnedCal.date(from: DateComponents(year: year, month: month, day: 1))!
        let firstDow = pinnedCal.component(.weekday, from: first) - 1
        let offset = (weekday0 - firstDow + 7) % 7
        return String(format: "%04d-%02d-%02d", year, month, 1 + offset + (n - 1) * 7)
    }

    @Test func holidayForConnector() {
        let c = asCountdown(p("add a countdown for thanksgiving"))!
        #expect(c.title == "Thanksgiving")
        // 4th Thursday of November 2026 (future relative to NOW = Jun 11 2026).
        #expect(c.date == nthWeekday(2026, 11, 4, 4))
    }
    @Test func forConnectorExplicitDate() {
        let c = asCountdown(p("add a countdown for november 20th"))!
        #expect(c.title == "Countdown")
        #expect(c.date == "2026-11-20")
    }
    @Test func holidayChristmas() {
        let c = asCountdown(p("countdown to Christmas"))!
        #expect(c.title == "Christmas")
        #expect(c.date == "2026-12-25")
    }
    @Test func holidayEaster() {
        let c = asCountdown(p("countdown to Easter"))!
        #expect(c.title == "Easter")
        // Easter 2026 (Apr 5) is past NOW → rolls to Easter 2027 (Mar 28, via Computus).
        #expect(c.date == "2027-03-28")
    }
    @Test func clockTimeStillEvent() {
        #expect(asEvent(p("dentist Tuesday 3pm")) != nil)
    }
}

@Suite struct CaptureHeuristicPersonTests {
    @Test func sonIsKid() {
        let m = asPerson(p("add my son Max"))!
        #expect(m.name == "Max")
        #expect(m.memberType == "kid")
        #expect(m.isAdmin == false)
    }
    @Test func daughterIsKid() {
        let m = asPerson(p("add my daughter Jane"))!
        #expect(m.name == "Jane")
        #expect(m.memberType == "kid")
    }
    @Test func wifeIsAdult() {
        let m = asPerson(p("add my wife Sara"))!
        #expect(m.name == "Sara")
        #expect(m.memberType == "adult")
    }
    @Test func familyMemberDefaultsAdult() {
        let m = asPerson(p("add a family member named Robin"))!
        #expect(m.name == "Robin")
        #expect(m.memberType == "adult")
    }
    @Test func profileForName() {
        let m = asPerson(p("create a profile for Max"))!
        #expect(m.name == "Max")
    }
    @Test func dropsTrailingAge() {
        let m = asPerson(p("add my son Max, age 8"))!
        #expect(m.name == "Max")
        #expect(m.birthday == nil)
    }
}

@Suite struct CaptureHeuristicGoalTests {
    // Last day of the next occurrence of a 0-based month, computed from pinnedNow so the
    // assertion tracks the clock (mirrors the web endOfNextMonth helper).
    private func endOfNextMonth(_ mo0: Int) -> String {
        var year = pinnedCal.component(.year, from: pinnedNow)
        let nowMo0 = pinnedCal.component(.month, from: pinnedNow) - 1
        if mo0 < nowMo0 { year += 1 }
        // Day 0 of the following month = the last day of the target month.
        let d = pinnedCal.date(from: DateComponents(year: year, month: mo0 + 2, day: 0))!
        return String(format: "%04d-%02d-%02d", pinnedCal.component(.year, from: d),
                      pinnedCal.component(.month, from: d), pinnedCal.component(.day, from: d))
    }

    @Test func personalGoalRunMilesBySeptember() {
        let g = asGoal(p("set a personal goal to run 10 miles by september"))!
        #expect(g.title == "Run")
        #expect(g.goalType == "total")
        #expect(g.targetValue == 10)
        #expect(g.unit == "miles")
        #expect(g.deadline == endOfNextMonth(8)) // end of the next September
    }
    @Test func personalGoalRunMilesNoDeadline() {
        let g = asGoal(p("set a personal goal to run 10 miles"))!
        #expect(g.title == "Run")
        #expect(g.goalType == "total")
        #expect(g.targetValue == 10)
        #expect(g.unit == "miles")
        #expect(g.deadline == nil)
    }
    @Test func newGoalReadBooks() {
        let g = asGoal(p("set a new goal to read 20 books"))!
        #expect(g.title == "Read")
        #expect(g.goalType == "count")
        #expect(g.targetValue == 20)
        #expect(g.unit == "books")
        #expect(g.deadline == nil)
    }
    @Test func thisYearDeadline() {
        let g = asGoal(p("set a goal to read 20 books this year"))!
        #expect(g.goalType == "count")
        #expect(g.targetValue == 20)
        #expect(g.unit == "books")
        #expect(g.deadline == "\(pinnedCal.component(.year, from: pinnedNow))-12-31")
    }
    @Test func moneyTotal() {
        let g = asGoal(p("my goal is to save $500"))!
        #expect(g.title == "Save")
        #expect(g.goalType == "total")
        #expect(g.targetValue == 500)
        #expect(g.unit == "dollars")
    }
    @Test func iWantToGetInShape() {
        let g = asGoal(p("I want to get in shape"))!
        #expect(g.title == "Get in shape")
        #expect(g.goalType == "habit")
        #expect(g.targetValue == nil)
        #expect(g.unit == nil)
    }
    @Test func newGoalColon() {
        let g = asGoal(p("new goal: meditate every day"))!
        #expect(g.title == "Meditate every day")
        #expect(g.goalType == "habit")
    }
    @Test func iWantFishForDinnerIsMeal() {
        // "I want to…" is the trigger, not "I want <noun>" — this stays a meal.
        #expect(asMeal(p("I want fish for dinner")) != nil)
    }
    @Test func defaultsAssignment() {
        let g = asGoal(p("set a goal to run 10 miles"))!
        #expect(g.trackingMode == "shared_total")
    }
    @Test func audienceEveryoneFromFamilyPhrase() {
        let g = asGoal(p("set a family goal to walk 30 min per day"))!
        #expect(g.audience == "everyone")
    }
    @Test func audienceMeFromPersonalPhrase() {
        let g = asGoal(p("set a personal goal to run 10 miles"))!
        #expect(g.audience == "me")
    }
    @Test func audienceNilWithoutHint() {
        let g = asGoal(p("set a goal to read 20 books"))!
        #expect(g.audience == nil)
    }
    @Test func summarizesGoal() {
        let s = CaptureSummary(p("set a goal to read 20 books")!)
        #expect(s.icon == "🎯")
        #expect(s.kind == "Goal")
        #expect(s.primary == "Read")
        #expect(s.detail.contains("20 books"))
    }
}

@Suite struct CaptureHeuristicPantryTests {
    @Test func addMilkToThePantry() {
        let i = asPantry(p("add milk to the pantry"))!
        #expect(i.name == "Milk")
        #expect(i.location == "Pantry")
        #expect(i.amount == nil)
        #expect(i.unit == nil)
    }
    @Test func putCansOfBeansInThePantry() {
        let i = asPantry(p("put 2 cans of beans in the pantry"))!
        #expect(i.name == "Beans")
        #expect(i.amount == "2")
        #expect(i.unit == "cans")
        #expect(i.location == "Pantry")
    }
    @Test func weHaveMilkInTheFridge() {
        let i = asPantry(p("we have milk in the fridge"))!
        #expect(i.name == "Milk")
        #expect(i.location == "Fridge")
    }
    // Regression: pantry must NOT steal groceries — only an explicit pantry/fridge/
    // freezer destination routes here; a bare item or a shopping-list target stays grocery.
    @Test func bareAddMilkStaysGrocery() {
        #expect(asGrocery(p("add milk")) != nil)
    }
    @Test func addMilkToShoppingListStaysGrocery() {
        #expect(asGrocery(p("add milk to the shopping list")) != nil)
    }
    @Test func summarizesPantry() {
        let s = CaptureSummary(p("put 2 cans of beans in the pantry")!)
        #expect(s.icon == "🥫")
        #expect(s.kind == "Pantry")
        #expect(s.primary == "2 cans Beans")
        #expect(s.detail.contains("Pantry"))
    }
}

@Suite struct CaptureHeuristicRewardTests {
    @Test func rewardWithCost() {
        let r = asReward(p("add a reward: ice cream night for 50 stars"))!
        #expect(r.title == "Ice cream night")
        #expect(r.cost == 50)
        #expect(r.requiresApproval == nil)
    }
    @Test func rewardCostsPoints() {
        let r = asReward(p("new reward extra screen time costs 100 points"))!
        #expect(r.title == "Extra screen time")
        #expect(r.cost == 100)
    }
    @Test func rewardNoCost() {
        let r = asReward(p("reward: movie night"))!
        #expect(r.title == "Movie night")
        #expect(r.cost == nil)
    }
    // Regression: the explicit word "reward" triggers this — a bare grocery doesn't.
    @Test func bareItemStaysGrocery() {
        #expect(asGrocery(p("add ice cream")) != nil)
    }
    @Test func summarizesReward() {
        let s = CaptureSummary(p("add a reward: ice cream night for 50 stars")!)
        #expect(s.icon == "🎁")
        #expect(s.kind == "Reward")
        #expect(s.primary == "Ice cream night")
        #expect(s.detail.contains("50★"))
    }
}

@Suite struct CaptureHeuristicEdgeTests {
    @Test func emptyInput() {
        #expect(p("") == nil)
        #expect(p("   ") == nil)
    }
    @Test func confidence() {
        #expect(CaptureHeuristic.looksConfident(p("Soccer Tue 4pm for Wally"), text: "Soccer Tue 4pm for Wally"))
        #expect(CaptureHeuristic.looksConfident(p("2 lbs chicken thighs"), text: "2 lbs chicken thighs"))
        #expect(!CaptureHeuristic.looksConfident(p("milk"), text: "milk"))   // bare noun held back
    }
}
