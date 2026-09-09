import Foundation
import Observation

// Weekly Planning · step 7 (Meals). THE STEP STORES NOTHING OF ITS OWN: everything on
// screen is the existing meal plan, and the only thing the session records is a crumb —
// which nights the app picked.

// MARK: - Formatting

enum PlanningMealsText {

    static let words = ["none", "one", "two", "three", "four", "five", "six", "seven"]
    static func countWord(_ n: Int) -> String { n >= 0 && n < words.count ? words[n] : String(n) }

    /// UTC + POSIX, matching `PlanningFormat`: a week's day is a calendar LABEL, and the
    /// device's zone hands back the day before for anybody west of Greenwich.
    static func dow(_ ymd: String) -> String {
        guard let d = isoDay.date(from: ymd) else { return ymd }
        return shortDay.string(from: d)
    }

    static func monthDay(_ ymd: String) -> String {
        guard let d = isoDay.date(from: ymd) else { return ymd }
        return monthDayFmt.string(from: d)
    }

    /// `startsAt` is a real instant, not a calendar label, so the clock reads in the
    /// DEVICE's zone.
    static func clock(_ e: WaffledAPI.PlanningNightEvent) -> String {
        if e.allDay { return "All day" }
        guard let d = isoInstant.date(from: e.startsAt) ?? isoInstantNoFraction.date(from: e.startsAt) else {
            return ""
        }
        return clockFmt.string(from: d)
    }

    static func attribution(
        _ d: WaffledAPI.PlanningNightDinner, auto: Bool, eatingOut: Bool
    ) -> String? {
        if let cook = d.cookName { return "\(d.cookAvatar ?? "👤") \(cook)" }
        if auto { return "the app picked this" }
        if d.mealId != nil { return "a whole plate" }
        if let minutes = d.minutes, minutes > 0 { return "\(minutes) min" }
        if eatingOut { return "no cooking" }
        return nil
    }

    /// A PLATE IS NEVER TAKEOUT. `TonightMeal.isEatingOut` reads a recipe-less row's title,
    /// and a plate is recipe-less with the plate's NAME as its title — so the plate branch
    /// (`recipeId == nil && mealId != nil`) must be checked FIRST.
    static func isEatingOut(_ d: WaffledAPI.PlanningNightDinner) -> Bool {
        guard d.mealId == nil, d.recipeId == nil else { return false }
        return TonightMeal.isEatingOut(d.title)
    }

    static func tripLabel(_ t: WaffledAPI.PlanningShoppingTrip?) -> String {
        guard let t else { return "Who's shopping?" }
        let when = dow(t.dueOn) + (t.dueTime.map { " \($0)" } ?? "")
        guard let name = t.personName else { return "Up for grabs · \(when)" }
        return "\(t.personAvatar ?? "👤") \(name) shops \(when)"
    }

    /// The undo only takes back what is still untouched, so the copy has to name the nights
    /// it walked past — otherwise "Undo the three" quietly becomes an undo of two.
    static func keptSentence(_ dates: [String]) -> String? {
        guard !dates.isEmpty else { return nil }
        let one = dates.count == 1
        return "\(countWord(dates.count)) \(one ? "night was" : "nights were") left alone — "
            + dates.map(dow).joined(separator: ", ")
            + " \(one ? "has" : "have") been decided since."
    }

    static func grocerySub(added: Int?) -> String {
        guard let added else { return "built from what's planned so far · staples skipped" }
        return "\(added) items added · staples skipped"
    }

    static func groceryPill(_ g: WaffledAPI.PlanningMealsGroceries) -> String {
        var s = "\(g.items) items · aisle order"
        if g.checked > 0 { s += " · \(g.checked) ticked" }
        return s
    }

    static func fillTitle(empties: Int) -> String {
        empties == 1
            ? "Fills the one empty night"
            : "Fills the \(countWord(empties)) empty nights"
    }

    static func plannerNote(_ empties: Int) -> String {
        let one = empties == 1
        return "Planning the \(countWord(empties)) empty \(one ? "night" : "nights")"
            + " — the rest stay as they are."
    }

    // `static let` per the project's performance rule — `dow` alone is read seven times a load.
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let shortDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE"
        return f
    }()
    private static let monthDayFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "MMM d"
        return f
    }()
    private static let clockFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "h:mm a"
        return f
    }()
    private static let isoInstant: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoInstantNoFraction = ISO8601DateFormatter()
}

// MARK: - Narrowing the shared planner to this step's promise

/// The two pure translations between this step and the app's own "Plan my week" planner,
/// narrowed to its promise: only EMPTY nights may be touched. Pure, so they are assertable.
enum PlanningMealsPlan {

    /// **NOON, in the HOUSEHOLD's zone.** The planner keys its chips with
    /// `DateFmt.string(d, "yyyy-MM-dd", householdTz)`, so a day pinned at midnight is one
    /// DST transition away from being the day before — and a key that doesn't match
    /// `initialDays` selects no chips, leaving "✨ Plan my week" a silent no-op.
    static func plannerDays(_ dates: [String], tz: TimeZone) -> [Date] {
        dates.compactMap { DateFmt.date($0 + " 12:00", "yyyy-MM-dd HH:mm", tz) }
    }

    /// Narrowed to what the fill may write: dinners only, still-empty nights, one card per
    /// night, never a card with neither recipe nor title — the server enforces all four.
    static func cards(
        from approved: [WaffledAPI.PlanCardDTO], emptyDates: [String]
    ) -> [WaffledAPI.PlanningMealsCard] {
        let open = Set(emptyDates)
        var taken = Set<String>()
        var out: [WaffledAPI.PlanningMealsCard] = []
        for card in approved {
            guard open.contains(card.date),
                  card.mealType == PlanningMealsModel.mealType,
                  !taken.contains(card.date)
            else { continue }
            let title = card.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard card.recipeId != nil || !title.isEmpty else { continue }
            taken.insert(card.date)
            out.append(
                WaffledAPI.PlanningMealsCard(
                    date: card.date, mealType: PlanningMealsModel.mealType,
                    title: title, recipeId: card.recipeId))
        }
        return out.sorted { $0.date < $1.date }
    }
}

// MARK: - Rows

struct PlanningMealsEventRow: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let clock: String
    let colorHex: String?
}

struct PlanningMealsNightRow: Identifiable, Equatable, Sendable {
    let date: String
    let dow: String
    let monthDay: String
    let events: [PlanningMealsEventRow]
    let dinner: WaffledAPI.PlanningNightDinner?
    let auto: Bool
    let eatingOut: Bool
    let attribution: String?

    var id: String { date }
    var fallbackEmoji: String { eatingOut ? "🥡" : "🍽️" }
}

// MARK: - Model

@MainActor
@Observable
final class PlanningMealsModel {
    typealias FetchView = (_ weekStart: String, _ choreId: String?) async throws -> WaffledAPI.PlanningMealsView
    typealias Fill = (_ weekStart: String, _ cards: [WaffledAPI.PlanningMealsCard]?) async throws -> WaffledAPI.PlanningMealsFill
    typealias Undo = (_ weekStart: String, _ filled: [WaffledAPI.PlanningFilledNight]) async throws -> WaffledAPI.PlanningMealsUndo
    typealias SetShopper = (
        _ weekStart: String, _ dueOn: String?, _ personId: String?, _ dueTime: String?, _ choreId: String?
    ) async throws -> WaffledAPI.PlanningMealsShopperResult
    typealias PlanSlot = (_ date: String, _ recipeId: String?, _ title: String?) async throws -> Void
    /// A night decided as a PLATE. It cannot go through `planSlot`: scheduling a saved plate
    /// COPIES it, which keeps next week's "BBQ Sunday" from rewriting the one already out.
    typealias PlanPlate = (_ date: String, _ mealId: String) async throws -> Void
    typealias ClearSlot = (_ date: String) async throws -> Void

    private(set) var view: WaffledAPI.PlanningMealsView?
    private(set) var loaded = false
    /// ONE WRITE AT A TIME — fill, undo, shopper and hand-picked night all move one week.
    private(set) var busy = false
    /// Settable so `DismissibleErrorBanner`'s ✕ can clear it.
    var errorMessage: String?

    /// The auto-filled nights that are STILL undoable, each carrying the proof the server
    /// checks. ONLY A FILL MAY PUT SOMETHING HERE: a claim rebuilt from the session crumb
    /// would be compared against the very row it was read from, so the guard would always
    /// pass and the undo would clear a night somebody deliberately changed.
    private(set) var filled: [WaffledAPI.PlanningFilledNight] = []
    private(set) var autoMarks: [String] = []
    private(set) var kept: [String] = []
    private(set) var groceryAdded: Int?

    /// Lives in the model, not a view's `@State` — see `PlanningMealsStore` for why.
    private(set) var plannerOpen = false

    private(set) var rows: [PlanningMealsNightRow] = []
    private(set) var rev = 0

    private let fetchView: FetchView
    private let fill: Fill
    private let undo: Undo
    private let setShopperFn: SetShopper
    private let planSlot: PlanSlot
    private let planPlate: PlanPlate
    private let clearSlot: ClearSlot

    init(
        fetchView: @escaping FetchView = { weekStart, choreId in
            try await WaffledAPI().planningMeals(weekStart: weekStart, choreId: choreId)
        },
        fill: @escaping Fill = { weekStart, cards in
            try await WaffledAPI().planningMealsFill(weekStart: weekStart, cards: cards)
        },
        undo: @escaping Undo = { weekStart, filled in
            try await WaffledAPI().planningMealsUndo(weekStart: weekStart, filled: filled)
        },
        setShopper: @escaping SetShopper = { weekStart, dueOn, personId, dueTime, choreId in
            try await WaffledAPI().planningMealsSetShopper(
                weekStart: weekStart, dueOn: dueOn, personId: personId,
                dueTime: dueTime, choreId: choreId)
        },
        planSlot: @escaping PlanSlot = { date, recipeId, title in
            try await WaffledAPI().planMeal(
                date: date, mealType: PlanningMealsModel.mealType, recipeId: recipeId, title: title)
        },
        planPlate: @escaping PlanPlate = { date, mealId in
            _ = try await WaffledAPI().scheduleMeal(
                id: mealId, date: date, mealType: PlanningMealsModel.mealType)
        },
        clearSlot: @escaping ClearSlot = { date in
            try await WaffledAPI().clearMeal(date: date, mealType: PlanningMealsModel.mealType)
        }
    ) {
        self.fetchView = fetchView
        self.fill = fill
        self.undo = undo
        self.setShopperFn = setShopper
        self.planSlot = planSlot
        self.planPlate = planPlate
        self.clearSlot = clearSlot
    }

    /// `nonisolated` so the pure narrowing in `PlanningMealsPlan` (and its tests) can spell
    /// the constant rather than a second copy.
    nonisolated static let mealType = "dinner"

    // MARK: Derived

    var autoDates: Set<String> { Set(filled.map(\.date)).union(autoMarks) }

    var emptyDates: [String] { view?.emptyDates ?? [] }

    /// `nil` when there are no dates, because the affirmative REPLACES the step's stored data
    /// and an empty list is a claim rather than an absence.
    var crumb: [String: JSONValue]? {
        let dates = autoDates.sorted()
        guard !dates.isEmpty else { return nil }
        return ["autoFilled": .array(dates.map(JSONValue.string))]
    }

    /// Passed back on every read and write, so a chore renamed on the Tasks board is still
    /// recognised as this week's trip instead of spawning a second one.
    var choreHint: String? { view?.shopping?.choreId }

    func dismissError() { errorMessage = nil }

    // MARK: Reads

    func enter(weekStart: String, seed: [String]) async {
        if loaded { await reread(weekStart: weekStart) } else { await load(weekStart: weekStart, seed: seed) }
    }

    /// A FAILED fetch still sets `loaded` (the loading contract in
    /// `Features/Shared/RestDomain.swift`) so the step says what went wrong.
    func load(weekStart: String, seed: [String]) async {
        do {
            let fresh = try await fetchView(weekStart, nil)
            // The crumb restores the MARKS, never the undo: see `filled`.
            let stillPlanned = Set(fresh.nights.filter { $0.dinner != nil }.map(\.date))
            autoMarks = seed.filter { stillPlanned.contains($0) }
            apply(fresh)
        } catch {
            if view == nil {
                errorMessage = "Couldn’t read this week’s meals — reload and try again."
            }
        }
        loaded = true
    }

    func reread(weekStart: String) async {
        if let fresh = try? await fetchView(weekStart, choreHint) { apply(fresh) }
    }

    // MARK: The planner the footer opens

    /// OPENS THE PLANNER and writes nothing at all: a week nobody approved is not a decision
    /// the family made.
    func openPlanner() {
        guard view != nil, !busy, !emptyDates.isEmpty else { return }
        plannerOpen = true
    }

    func setPlanner(_ open: Bool) { plannerOpen = open }

    /// Applied through THIS STEP's fill endpoint rather than the planner's per-slot writes,
    /// which alone can refuse an already-decided night and hand back the undo's receipt.
    @discardableResult
    func applyPlan(weekStart: String, approved: [WaffledAPI.PlanCardDTO]) async -> Bool {
        let cards = PlanningMealsPlan.cards(from: approved, emptyDates: emptyDates)
        plannerOpen = false
        // NEVER `cards: []`. An empty-but-present array is "not a usable list" to the route,
        // which answers 200 having written nothing (see `PlanningMealsWire.fillBody`).
        guard !cards.isEmpty else {
            errorMessage = "Nothing in that plan landed on an empty night — the week was left as it is."
            return false
        }
        return await planTheRest(weekStart: weekStart, cards: cards)
    }

    // MARK: The two writes the planner and the footer drive

    /// Returns true when something was actually written. `cards` IS THREE-WAY (see
    /// `PlanningMealsWire.fillBody`) and `nil` means the KEY IS ABSENT, never a null — the
    /// endpoint's headless path, kept for a non-interactive caller.
    @discardableResult
    func planTheRest(weekStart: String, cards: [WaffledAPI.PlanningMealsCard]? = nil) async -> Bool {
        guard !busy else {
            errorMessage = "Something else was still saving — the week wasn’t planned. Try again."
            return false
        }
        busy = true
        errorMessage = nil
        kept = []
        let before = view?.groceries?.items
        defer { busy = false }
        do {
            let r = try await fill(weekStart, cards)
            let fresh = Set(r.filled.map(\.date))
            let after = r.view.groceries?.items
            // Explicitly `Int?`: the count is only knowable when the lists module was on for
            // BOTH reads, and "we don't know" is not the claim "0 added".
            let added: Int? = (before != nil && after != nil) ? after! - before! : nil
            filled = (filled.filter { !fresh.contains($0.date) } + r.filled)
                .sorted { $0.date < $1.date }
            autoMarks = autoMarks.filter { !fresh.contains($0) }
            groceryAdded = (!r.filled.isEmpty && (added ?? 0) > 0) ? added : nil
            apply(r.view)
            return true
        } catch {
            errorMessage = "That didn’t take — try again."
            return false
        }
    }

    /// Only clears what is still untouched: a night decided since comes back in `kept`.
    @discardableResult
    func undoTheFill(weekStart: String) async -> Bool {
        guard !busy, !filled.isEmpty else { return false }
        busy = true
        errorMessage = nil
        kept = []
        groceryAdded = nil
        defer { busy = false }
        do {
            let r = try await undo(weekStart, filled)
            let settled = Set(r.cleared).union(r.kept)
            kept = r.kept
            filled = filled.filter { !settled.contains($0.date) }
            autoMarks = autoMarks.filter { !settled.contains($0) }
            apply(r.view)
            return true
        } catch {
            errorMessage = "That didn’t take — try again."
            return false
        }
    }

    // MARK: A night, decided by hand

    @discardableResult
    func planNight(weekStart: String, date: String, recipeId: String?, title: String?) async -> Bool {
        await handWrite(weekStart: weekStart, date: date, failure: "that night wasn’t planned") {
            try await self.planSlot(date, recipeId, title)
        }
    }

    @discardableResult
    func planNightAsPlate(weekStart: String, date: String, mealId: String) async -> Bool {
        await handWrite(weekStart: weekStart, date: date, failure: "that night wasn’t planned") {
            try await self.planPlate(date, mealId)
        }
    }

    @discardableResult
    func clearNight(weekStart: String, date: String) async -> Bool {
        await handWrite(weekStart: weekStart, date: date, failure: "that night wasn’t cleared") {
            try await self.clearSlot(date)
        }
    }

    /// One call for assign / move / hand over / clear (`dueOn: nil`), because a trip has to be
    /// undoable. A FAILED WRITE DOES NOT REFETCH AND DOES NOT MUTATE.
    @discardableResult
    func setShopper(
        weekStart: String, dueOn: String?, personId: String?, dueTime: String?
    ) async -> Bool {
        guard !busy else {
            errorMessage = "Something else was still saving — the trip wasn’t changed. Try again."
            return false
        }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let r = try await setShopperFn(weekStart, dueOn, personId, dueTime, choreHint)
            apply(r.view)
            return true
        } catch let WaffledAPI.APIError.http(code, _) where code == 401 || code == 403 {
            errorMessage = "Only a parent can hand the shopping to somebody else."
            return false
        } catch {
            errorMessage = "That didn’t take — the trip stayed as it was."
            return false
        }
    }

    // MARK: - Internals

    /// Refuse while busy WITH A MESSAGE — the picker has already closed, so a quiet return
    /// would report a night nobody planned.
    private func handWrite(
        weekStart: String, date: String, failure: String, _ work: () async throws -> Void
    ) async -> Bool {
        guard !busy else {
            errorMessage = "Something else was still saving — \(failure). Try again."
            return false
        }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await work()
        } catch {
            errorMessage = "That didn’t take — try again."
            return false
        }
        filled.removeAll { $0.date == date }
        autoMarks.removeAll { $0 == date }
        kept = []
        groceryAdded = nil
        // FORGETTING THE ✨ IS ITSELF A CHANGE, so it lands before the re-read: a failed
        // re-read keeps the previous view and would leave the crumb naming this night.
        rebuildRows()
        rev += 1
        await reread(weekStart: weekStart)
        return true
    }

    private func apply(_ fresh: WaffledAPI.PlanningMealsView) {
        view = fresh
        rebuildRows()
        rev += 1
    }

        // `auto` is folded in here rather than passed to the tile because it changes the
        // ATTRIBUTION line, and a view recomputing that would redo the date work per frame.
    private func rebuildRows() {
        guard let view else { rows = []; return }
        let auto = autoDates
        rows = view.nights.map { night in
            let dinner = night.dinner
            let out = dinner.map(PlanningMealsText.isEatingOut) ?? false
            let isAuto = auto.contains(night.date)
            return PlanningMealsNightRow(
                date: night.date,
                dow: PlanningMealsText.dow(night.date),
                monthDay: PlanningMealsText.monthDay(night.date),
                events: night.events.map {
                    PlanningMealsEventRow(
                        id: $0.id, title: $0.title,
                        clock: PlanningMealsText.clock($0), colorHex: $0.personColor)
                },
                dinner: dinner,
                auto: isAuto,
                eatingOut: out,
                attribution: dinner.flatMap {
                    PlanningMealsText.attribution($0, auto: isAuto, eatingOut: out)
                })
        }
    }
}

// MARK: - The store the body and the footer share

/// WHY THIS EXISTS. The shell renders the step's BODY and its FOOTER control as two sibling
/// trees built from separate calls, so a `@State` model in either is invisible to the other
/// and threading one through would mean editing `PlanningStepSeam.swift`, which this step
/// does not own. KEYED BY SESSION + WEEK, ONE AT A TIME: a different key REPLACES the
/// model, so stepping weeks cannot leave a previous week's ✨ marks behind. DELIBERATELY
/// NOT `@Observable`, so resolving a model during `body` is not a state write.
@MainActor
final class PlanningMealsStepStore {
    static let shared = PlanningMealsStepStore()

    private var key = ""
    private var model: PlanningMealsModel?

    static func key(sessionId: String, weekStart: String) -> String { "\(sessionId)|\(weekStart)" }

    func model(
        sessionId: String, weekStart: String,
        // `@MainActor` on the closure TYPE, not just the method: a default-argument expression
        // is evaluated in a non-isolated context.
        make: @MainActor () -> PlanningMealsModel = { PlanningMealsModel() }
    ) -> PlanningMealsModel {
        let wanted = Self.key(sessionId: sessionId, weekStart: weekStart)
        if key == wanted, let model { return model }
        let fresh = make()
        key = wanted
        model = fresh
        return fresh
    }

    func reset() {
        key = ""
        model = nil
    }
}

enum PlanningMealsCrumb {
    static func dates(_ data: [String: JSONValue]?) -> [String] {
        guard case let .array(raw)? = data?["autoFilled"] else { return [] }
        return raw.compactMap { value in
            guard case let .string(s) = value, isDay(s) else { return nil }
            return s
        }
    }

    private static func isDay(_ s: String) -> Bool {
        s.count == 10
            && s.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil
    }
}
