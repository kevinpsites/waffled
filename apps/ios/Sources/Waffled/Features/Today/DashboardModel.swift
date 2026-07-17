import Foundation
import Observation

/// Tonight's dinner, derived from the planned week. Handles a recipe, a recipe-less
/// ("Fish") plan, or an eating-out night — mirroring the web `TonightCard`.
struct TonightMeal: Sendable {
    let title: String
    let emoji: String
    let cookTimeMinutes: Int?
    let servings: Int?
    let eatingOut: Bool
    let hasRecipe: Bool
    let recipeId: String?
    let category: String?

    init(_ e: WaffledAPI.WeekEntryDTO) {
        let out = e.recipeId == nil && TonightMeal.isEatingOut(e.title)
        eatingOut = out
        hasRecipe = e.recipeId != nil
        recipeId = e.recipeId
        category = e.recipe?.category
        title = out ? "Eating out" : (e.recipe?.title ?? e.title ?? "Dinner")
        emoji = e.recipe?.emoji ?? (out ? "🍴" : "🍽️")
        cookTimeMinutes = e.recipe?.cookTimeMinutes
        servings = e.recipe?.servings
    }

    /// A placeholder RecipeSummary so the Today card can open this meal's recipe.
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
/// Each domain lives in a shared `RestDomain` (same layer the iPad kiosk uses),
/// which carries the loading-state contract the cards rely on: `loaded` /
/// `goalsLoaded` flip true only after their fetch completes, so a card can tell
/// "still loading" (show a placeholder) apart from "loaded and empty" (show the
/// empty state). A failed fetch (offline, expired token) keeps the prior values
/// rather than blanking the cards.
///
/// Fetchers are injectable for the unit tests; the defaults hit `WaffledAPI`,
/// returning nil on failure so `RestDomain.apply` can tell "empty" from "errored".
@MainActor
@Observable
final class DashboardModel {
    private let tonightD = RestDomain<TonightMeal?>(nil)
    private let choresD = RestDomain<[WaffledAPI.PersonChoresDTO]>([])
    private let groceryD = RestDomain<Int>(0)
    private let goalsD = RestDomain<[WaffledAPI.Goal]>([])
    private let recapD = RestDomain<[WaffledAPI.GoalRecapItem]>([])
    private let suggestionsD = RestDomain<[WaffledAPI.GoalSuggestionItem]>([])

    var tonight: TonightMeal? { tonightD.value }
    var chores: [WaffledAPI.PersonChoresDTO] { choresD.value }
    var groceryRemaining: Int { groceryD.value }
    /// Whether the meals/chores/grocery load has completed at least once.
    var loaded: Bool { tonightD.loaded && choresD.loaded && groceryD.loaded }

    /// Household goals (featured-first) for the Today goals card, plus the
    /// goal-calendar review queues for the "review events" entry card.
    var goals: [WaffledAPI.Goal] { goalsD.value }
    var reviewRecap: [WaffledAPI.GoalRecapItem] { recapD.value }
    var reviewSuggestions: [WaffledAPI.GoalSuggestionItem] { suggestionsD.value }
    /// Whether the goals load has completed at least once — the goals card must key
    /// its empty state off THIS flag, not `loaded` (the dash fetch usually finishes
    /// first, which used to flash "Set a family goal →" before goals arrived).
    var goalsLoaded: Bool { goalsD.loaded && recapD.loaded && suggestionsD.loaded }

    private let fetchMeals: @Sendable (String) async -> [WaffledAPI.WeekEntryDTO]?
    private let fetchChores: @Sendable () async -> [WaffledAPI.PersonChoresDTO]?
    private let fetchGrocery: @Sendable () async -> [WaffledAPI.GroceryItemDTO]?
    private let fetchGoals: @Sendable () async -> [WaffledAPI.Goal]?
    private let fetchRecap: @Sendable () async -> [WaffledAPI.GoalRecapItem]?
    private let fetchSuggestions: @Sendable () async -> [WaffledAPI.GoalSuggestionItem]?

    init(fetchMeals: (@Sendable (String) async -> [WaffledAPI.WeekEntryDTO]?)? = nil,
         fetchChores: (@Sendable () async -> [WaffledAPI.PersonChoresDTO]?)? = nil,
         fetchGrocery: (@Sendable () async -> [WaffledAPI.GroceryItemDTO]?)? = nil,
         fetchGoals: (@Sendable () async -> [WaffledAPI.Goal]?)? = nil,
         fetchRecap: (@Sendable () async -> [WaffledAPI.GoalRecapItem]?)? = nil,
         fetchSuggestions: (@Sendable () async -> [WaffledAPI.GoalSuggestionItem]?)? = nil) {
        let api = WaffledAPI()
        self.fetchMeals = fetchMeals ?? { try? await api.mealsWeek(start: $0) }
        self.fetchChores = fetchChores ?? { try? await api.choresToday() }
        self.fetchGrocery = fetchGrocery ?? { try? await api.groceryItems() }
        self.fetchGoals = fetchGoals ?? { try? await api.goalsIn(listId: nil) }
        self.fetchRecap = fetchRecap ?? { try? await api.goalRecap() }
        self.fetchSuggestions = fetchSuggestions ?? { try? await api.goalSuggestions() }
    }

    /// Aggregate chore progress across the family (for the compact summary card).
    var choreDone: Int { chores.reduce(0) { $0 + $1.done } }
    var choreTotal: Int { chores.reduce(0) { $0 + $1.total } }
    var choreStars: Int { chores.reduce(0) { $0 + $1.stars } }

    /// Load the meal/chores/grocery domains concurrently. Per `RestDomain.apply`, a
    /// domain that fails keeps its prior value; one that succeeds empty clears (e.g.
    /// tonight's dinner was removed elsewhere → back to "No dinner planned").
    func load(todayKey: String) async {
        async let meals = fetchMeals(todayKey)
        async let people = fetchChores()
        async let grocery = fetchGrocery()
        let (m, c, g) = await (meals, people, grocery)

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
        async let goalRows = fetchGoals()
        async let recapRows = fetchRecap()
        async let suggestionRows = fetchSuggestions()
        let (g, r, s) = await (goalRows, recapRows, suggestionRows)

        goalsD.apply(g)
        recapD.apply(r)
        suggestionsD.apply(s)
    }
}
