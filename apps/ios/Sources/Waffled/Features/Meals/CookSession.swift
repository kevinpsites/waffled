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
        dishes[i].index = dishes[i].clamp(step)
        activeDishId = dishId
        return true
    }

    /// The timers belonging to one dish. Timers live in ONE flat list across the whole
    /// plate (they all keep running whichever dish you're looking at) — this is how the
    /// dish tabs and the dock slice it.
    static func timers(_ all: [CookTimer], for dishId: String) -> [CookTimer] {
        all.filter { $0.dishId == dishId }
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
