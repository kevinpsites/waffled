import Foundation

/// One dish being cooked — a recipe with its own method and, crucially, its own place in
/// it. A plate ("BBQ Sunday" = BBQ Chicken + Potato Salad + Coleslaw + Peach Cobbler) is
/// several of these on the go at once, so bringing the side forward must never rewind the
/// main.
struct CookDish: Identifiable, Equatable {
    /// The recipe id — also how this dish's timers are keyed.
    let id: String
    let title: String
    /// `main` / `side` / `dessert` — the plate's free-text role; nil when a recipe is
    /// cooked on its own.
    let role: String?
    let steps: [WaffledAPI.RecipeStepDTO]
    let ingredients: [WaffledAPI.RecipeIngredientDTO]
    /// Where this dish is in its own method — kept while another dish is on screen.
    var index: Int = 0

    /// Clamp a step to one this dish actually has.
    func clamp(_ i: Int) -> Int { steps.isEmpty ? 0 : min(max(0, i), steps.count - 1) }
}

/// A dish's fetched method. Keeps the (pure) plate builder independent of the recipe
/// detail DTO the store fetches, so composing a plate is testable without a network.
struct CookMethod: Equatable, Sendable {
    let title: String
    let steps: [WaffledAPI.RecipeStepDTO]
    let ingredients: [WaffledAPI.RecipeIngredientDTO]
}

/// What is being cooked, minus every side effect: the dishes, which one is on screen, and
/// where each one is. `CookSessionStore` owns one of these and wraps it in the async /
/// alarm / notification shell — the rules live here so they can be tested directly.
struct CookSession: Equatable {
    /// The plate these dishes came from; nil ⇒ one recipe cooked on its own. A ONE-dish
    /// plate is still a plate (its timers name the dish, and a tapped notification
    /// re-opens the plate), so this — never `dishes.count` — is the test for "is a plate".
    let plateId: String?
    /// The plate's name, or the lone recipe's title.
    let title: String
    private(set) var dishes: [CookDish]
    private(set) var activeDishId: String
    /// Where a timer jump pulled you off, so one tap can put you back.
    ///
    /// A fired timer moves you to ITS dish and ITS step, which is right — the beeping
    /// pan is the live one — but it costs you the place you were reading. On a plate
    /// that's a dish you can at least tab back to; when the timer belongs to the dish
    /// you're already on, nothing else remembers.
    private(set) var returnMark: Mark?

    struct Mark: Equatable, Sendable {
        let dishId: String
        let step: Int
    }

    /// nil when there's nothing to cook — a session always has at least one dish.
    init?(plateId: String?, title: String, dishes: [CookDish]) {
        guard let first = dishes.first else { return nil }
        self.plateId = plateId
        self.title = title
        self.dishes = dishes
        self.activeDishId = first.id
    }

    var isPlate: Bool { plateId != nil }

    private var activeSlot: Int? { dishes.firstIndex { $0.id == activeDishId } }
    var activeDish: CookDish? { activeSlot.map { dishes[$0] } }
    var steps: [WaffledAPI.RecipeStepDTO] { activeDish?.steps ?? [] }
    var ingredients: [WaffledAPI.RecipeIngredientDTO] { activeDish?.ingredients ?? [] }

    /// The step the dish *on screen* is on. Every dish keeps its own, so this reads and
    /// writes through to the active one (clamped to that dish's method).
    var index: Int {
        get { activeDish?.index ?? 0 }
        set { if let i = activeSlot { dishes[i].index = dishes[i].clamp(newValue) } }
    }

    func contains(_ dishId: String) -> Bool { dishes.contains { $0.id == dishId } }

    /// Bring another dish on screen; its own step is restored untouched. False ⇒ that
    /// dish isn't part of this session.
    @discardableResult
    mutating func activate(_ dishId: String) -> Bool {
        guard contains(dishId) else { return false }
        activeDishId = dishId
        return true
    }

    /// Go to a dish AND a step inside it — what a fired timer, or a tap in the dock,
    /// does. Deliberately one call: setting `index` first would move the *outgoing*
    /// dish's pointer instead.
    @discardableResult
    mutating func jump(toDish dishId: String, step: Int) -> Bool {
        guard let i = dishes.firstIndex(where: { $0.id == dishId }) else { return false }
        let wasDish = activeDishId
        let wasStep = index
        let clamped = dishes[i].clamp(step)
        // A jump that lands where you already stand is not a journey — offering a way
        // "back" to the step you're reading would be noise.
        let moved = wasDish != dishId || wasStep != clamped
        dishes[i].index = clamped
        activeDishId = dishId
        if moved { returnMark = Mark(dishId: wasDish, step: wasStep) }
        return true
    }

    /// Take the offer: return to the dish and step the last jump pulled you off.
    @discardableResult
    mutating func goBack() -> Bool {
        guard let mark = returnMark, let i = dishes.firstIndex(where: { $0.id == mark.dishId })
        else { return false }
        dishes[i].index = dishes[i].clamp(mark.step)
        activeDishId = mark.dishId
        returnMark = nil
        return true
    }

    /// The × on the pill — forget the offer, stay put.
    mutating func dismissReturn() { returnMark = nil }

    /// The offer to show, or nil. Deliberately hidden once you're standing on it: you
    /// may well have walked back yourself, and a button pointing at your own feet is
    /// worse than no button. Otherwise it stays until used or dismissed.
    var pendingReturn: Mark? {
        guard let mark = returnMark else { return nil }
        if mark.dishId == activeDishId && mark.step == index { return nil }
        return mark
    }

    /// The dish a pending offer points at, for the pill's label.
    var pendingReturnTitle: String? {
        guard let mark = pendingReturn else { return nil }
        return dishes.first { $0.id == mark.dishId }?.title
    }

    /// The timers belonging to one dish. Timers live in ONE flat list across the whole
    /// plate (they all keep running whichever dish you're looking at) — this is how the
    /// dish tabs and the dock slice it.
    static func timers(_ all: [CookTimer], for dishId: String) -> [CookTimer] {
        all.filter { $0.dishId == dishId }
    }

    /// Build a session for a whole plate. Dishes come out in `sortOrder` (never trust
    /// arrival order), and a dish whose method failed to load is skipped rather than
    /// sinking the plate — one unreachable side shouldn't stop you cooking dinner.
    /// nil ⇒ nothing loaded, so there is nothing to cook.
    static func plate(_ meal: WaffledAPI.MealDTO, methods: [String: CookMethod]) -> CookSession? {
        // Sort is not stable, so tie-break on arrival order to keep equal sortOrders put.
        let ordered = meal.recipes.enumerated()
            .sorted { ($0.element.sortOrder, $0.offset) < ($1.element.sortOrder, $1.offset) }
            .map(\.element)
        let dishes = ordered.compactMap { d -> CookDish? in
            guard let m = methods[d.recipeId] else { return nil }
            return CookDish(id: d.recipeId, title: d.title ?? m.title, role: d.role,
                            steps: m.steps, ingredients: m.ingredients)
        }
        return CookSession(plateId: meal.id, title: meal.name, dishes: dishes)
    }
}

/// The link payload a fired cook-timer notification carries, so tapping it re-opens Cook
/// Mode on the DISH that beeped — at the right step, and with the rest of its plate (and
/// their running timers) intact. Kept out of any view so the notification delegate (in
/// `NotificationManager`) can set it without importing view types.
struct CookTimerLink: Equatable {
    /// The recipe whose timer fired: one dish of a plate, or the lone recipe.
    let dishId: String
    let stepIndex: Int
    /// The plate that dish belongs to, when it has one, so re-opening restores the whole
    /// plate rather than just that one recipe.
    let plateId: String?

    private static let dishKey = "cookDishId"
    /// The pre-plates key, still WRITTEN with the dish id: a notification queued by an
    /// older build (or sitting in the OS queue across an app update) must keep
    /// deep-linking rather than becoming an inert tap.
    private static let recipeKey = "cookRecipeId"
    private static let stepKey = "cookStepIndex"
    private static let plateKey = "cookPlateId"
    private static let timerKey = "cookTimerId"

    /// The `userInfo` a scheduled timer notification carries.
    func userInfo(timerId: String) -> [String: Any] {
        var info: [String: Any] = [Self.dishKey: dishId, Self.recipeKey: dishId,
                                   Self.stepKey: stepIndex, Self.timerKey: timerId]
        if let plateId { info[Self.plateKey] = plateId }
        return info
    }

    /// Read one back off a tapped notification; nil ⇒ not one of ours (an event reminder,
    /// say), so the caller falls through to its other handlers.
    static func from(userInfo: [AnyHashable: Any]) -> CookTimerLink? {
        guard let dish = (userInfo[dishKey] as? String) ?? (userInfo[recipeKey] as? String)
        else { return nil }
        return CookTimerLink(dishId: dish, stepIndex: userInfo[stepKey] as? Int ?? 0,
                             plateId: userInfo[plateKey] as? String)
    }
}
