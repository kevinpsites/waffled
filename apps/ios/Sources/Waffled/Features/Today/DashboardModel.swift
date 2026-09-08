import Foundation
import Observation

/// Tonight's dinner, derived from the planned week. Handles a recipe, a Meal Builder
/// **plate** (several dishes under one name), a recipe-less ("Fish") plan, or an
/// eating-out night — mirroring the web `TonightCard`.
struct TonightMeal: Sendable {
    let title: String
    let emoji: String
    let cookTimeMinutes: Int?
    let servings: Int?
    let eatingOut: Bool
    let hasRecipe: Bool
    let recipeId: String?
    let category: String?
    /// Set when tonight is a plate rather than a single recipe.
    let mealId: String?
    /// How many dishes the plate has (0 for a single-recipe or free-text night).
    let dishCount: Int

    init(_ e: WaffledAPI.WeekEntryDTO) {
        // A plate is a real meal with real dishes, so the eating-out heuristic must not
        // reach it: someone who names a plate "Takeout Night" still cooked four things.
        let out = e.recipeId == nil && !e.isMealBacked && TonightMeal.isEatingOut(e.title)
        eatingOut = out
        hasRecipe = e.recipeId != nil
        recipeId = e.recipeId
        mealId = e.mealId
        dishCount = e.dishCount
        category = e.recipe?.category
        title = out ? "Eating out" : (e.recipe?.title ?? e.meal?.name ?? e.title ?? "Dinner")
        emoji = e.recipe?.emoji ?? (out ? "🍴" : "🍽️")
        cookTimeMinutes = e.recipe?.cookTimeMinutes
        servings = e.recipe?.servings ?? e.meal?.servings
    }

    /// Tonight is a plate rather than a single recipe.
    var isMealBacked: Bool { mealId != nil }

    /// There is something here to open and cook — a recipe OR a plate.
    ///
    /// The card's buttons gate on this. Gating on `recipeSummary` alone told people
    /// "No recipe attached yet" about a meal with three dishes.
    var isCookable: Bool { hasRecipe || isMealBacked }

    /// A placeholder RecipeSummary so the Today card can open this meal's recipe.
    ///
    /// Deliberately nil for a plate: a plate has no single recipe to stand in for it,
    /// and inventing one would open the wrong screen. Route on `mealId` instead.
    var recipeSummary: WaffledAPI.RecipeSummary? {
        guard let recipeId else { return nil }
        return .placeholder(id: recipeId, title: title, emoji: emoji, category: category,
                            cookTimeMinutes: cookTimeMinutes, servings: servings)
    }

    /// A recipe-less plan whose title reads like an eating-out night ("takeout",
    /// "delivery", "going out", …). Mirrors the web regex.
    static func isEatingOut(_ title: String?) -> Bool {
        guard let t = title?.lowercased() else { return false }
        let patterns = [
            #"\b(eating|eat|dining|going)\s*out\b"#,
            #"take\s*-?out"#,
            #"\border(ing)?\s+in\b"#,
            #"\bdelivery\b"#,
            #"\btakeaway\b"#,
        ]
        return patterns.contains { t.range(of: $0, options: .regularExpression) != nil }
    }
}

/// REST-backed state for the Today dashboard's non-synced cards (tonight's meal,
/// chores, grocery count, plus the goals card and its review queues). Events come
/// from PowerSync; these domains aren't synced tables, so they load over the API —
/// refreshed on appear, pull-down, the in-app mutation buses (`sync.*Rev`), and on
/// the app returning to the foreground (changes made elsewhere while backgrounded).
///
/// Each card exposes its REST state independently. A failed fetch preserves confirmed
/// values and reports the failure; only successful responses authorize empty copy.
/// Throwing injectable fetchers preserve the error needed for network/session recovery.
@MainActor
@Observable
final class DashboardModel {
    private let tonightD = RestDomain<TonightMeal?>(nil, isEmpty: { $0 == nil })
    private let choresD = RestDomain<[WaffledAPI.PersonChoresDTO]>([], isEmpty: \.isEmpty)
    private let groceryD = RestDomain<Int>(0, isEmpty: { $0 == 0 })
    private let goalsD = RestDomain<[WaffledAPI.Goal]>([], isEmpty: \.isEmpty)
    private let recapD = RestDomain<[WaffledAPI.GoalRecapItem]>([], isEmpty: \.isEmpty)
    private let suggestionsD = RestDomain<[WaffledAPI.GoalSuggestionItem]>([], isEmpty: \.isEmpty)

    var tonight: TonightMeal? { tonightD.value }
    var chores: [WaffledAPI.PersonChoresDTO] { choresD.value }
    var groceryRemaining: Int { groceryD.value }
    var mealsState: RestState { tonightD.state }
    var choresState: RestState { choresD.state }
    var groceryState: RestState { groceryD.state }
    var goalsState: RestState { goalsD.state }
    var reviewState: RestState { .combined([recapD.state, suggestionsD.state]) }
    var loaded: Bool { mealsState.isAuthoritative && choresState.isAuthoritative && groceryState.isAuthoritative }

    /// Household goals (featured-first) for the Today goals card, plus the
    /// goal-calendar review queues for the "review events" entry card.
    var goals: [WaffledAPI.Goal] { goalsD.value }
    var reviewRecap: [WaffledAPI.GoalRecapItem] { recapD.value }
    var reviewSuggestions: [WaffledAPI.GoalSuggestionItem] { suggestionsD.value }
    /// Whether the goals load has completed at least once — the goals card must key
    /// its empty state off THIS flag, not `loaded` (the dash fetch usually finishes
    /// first, which used to flash "Set a family goal →" before goals arrived).
    var goalsLoaded: Bool { goalsState.isAuthoritative }

    private var loadGeneration = 0
    private var goalsGeneration = 0

    private let fetchMeals: @Sendable (String) async throws -> [WaffledAPI.WeekEntryDTO]
    private let fetchChores: @Sendable () async throws -> [WaffledAPI.PersonChoresDTO]
    private let fetchGrocery: @Sendable () async throws -> [WaffledAPI.GroceryItemDTO]
    private let fetchGoals: @Sendable () async throws -> [WaffledAPI.Goal]
    private let fetchRecap: @Sendable () async throws -> [WaffledAPI.GoalRecapItem]
    private let fetchSuggestions: @Sendable () async throws -> [WaffledAPI.GoalSuggestionItem]

    init(fetchMeals: (@Sendable (String) async throws -> [WaffledAPI.WeekEntryDTO])? = nil,
         fetchChores: (@Sendable () async throws -> [WaffledAPI.PersonChoresDTO])? = nil,
         fetchGrocery: (@Sendable () async throws -> [WaffledAPI.GroceryItemDTO])? = nil,
         fetchGoals: (@Sendable () async throws -> [WaffledAPI.Goal])? = nil,
         fetchRecap: (@Sendable () async throws -> [WaffledAPI.GoalRecapItem])? = nil,
         fetchSuggestions: (@Sendable () async throws -> [WaffledAPI.GoalSuggestionItem])? = nil) {
        let api = WaffledAPI()
        self.fetchMeals = fetchMeals ?? { try await api.mealsWeek(start: $0) }
        self.fetchChores = fetchChores ?? { try await api.choresToday() }
        self.fetchGrocery = fetchGrocery ?? { try await api.groceryItems() }
        self.fetchGoals = fetchGoals ?? { try await api.goalsIn(listId: nil) }
        self.fetchRecap = fetchRecap ?? { try await api.goalRecap() }
        self.fetchSuggestions = fetchSuggestions ?? { try await api.goalSuggestions() }
    }

    /// Aggregate chore progress across the family (for the compact summary card).
    var choreDone: Int { chores.reduce(0) { $0 + $1.done } }
    var choreTotal: Int { chores.reduce(0) { $0 + $1.total } }
    var choreStars: Int { chores.reduce(0) { $0 + $1.stars } }

    /// Load the meal/chores/grocery domains concurrently. Per `RestDomain.apply`, a
    /// domain that fails keeps its prior value; one that succeeds empty clears (e.g.
    /// tonight's dinner was removed elsewhere → back to "No dinner planned").
    func load(todayKey: String) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        tonightD.beginLoading(); choresD.beginLoading(); groceryD.beginLoading()
        async let meals = RestFetch.result { [fetchMeals] in try await fetchMeals(todayKey) }
        async let people = RestFetch.result(fetchChores)
        async let grocery = RestFetch.result(fetchGrocery)
        let (m, c, g) = await (meals, people, grocery)
        guard !Task.isCancelled, generation == loadGeneration else { return }

        tonightD.apply(m.map { entries in
            entries.first(where: { $0.mealType == "dinner" && $0.date == todayKey })
                .map(TonightMeal.init)
        })
        choresD.apply(c.map { $0.filter { $0.total > 0 } })
        groceryD.apply(g.map { $0.filter { !$0.checked }.count })
    }

    /// Load the goals card + the goal-calendar review queues concurrently (keyed to
    /// `sync.goalsRev` by the view). Same failure semantics as `load`.
    func loadGoals() async {
        goalsGeneration &+= 1
        let generation = goalsGeneration
        goalsD.beginLoading(); recapD.beginLoading(); suggestionsD.beginLoading()
        async let goalRows = RestFetch.result(fetchGoals)
        async let recapRows = RestFetch.result(fetchRecap)
        async let suggestionRows = RestFetch.result(fetchSuggestions)
        let (g, r, s) = await (goalRows, recapRows, suggestionRows)
        guard !Task.isCancelled, generation == goalsGeneration else { return }

        goalsD.apply(g)
        recapD.apply(r)
        suggestionsD.apply(s)
    }
}
