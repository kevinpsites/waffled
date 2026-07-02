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

    init(_ e: NookAPI.WeekEntryDTO) {
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
    var recipeSummary: NookAPI.RecipeSummary? {
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
/// chores, grocery count). Events come from PowerSync; these three domains aren't
/// synced tables, so they load over the API — refreshed on appear and pull-down.
@MainActor
@Observable
final class DashboardModel {
    private(set) var tonight: TonightMeal?
    private(set) var chores: [NookAPI.PersonChoresDTO] = []
    private(set) var groceryRemaining = 0
    private(set) var loaded = false

    private let api = NookAPI()

    /// Aggregate chore progress across the family (for the compact summary card).
    var choreDone: Int { chores.reduce(0) { $0 + $1.done } }
    var choreTotal: Int { chores.reduce(0) { $0 + $1.total } }
    var choreStars: Int { chores.reduce(0) { $0 + $1.stars } }

    /// Load all three domains concurrently. Failures (e.g. no token yet) leave the
    /// prior values in place rather than blanking the cards.
    func load(todayKey: String) async {
        async let meals = fetchMeals(todayKey)
        async let people = fetchChores()
        async let grocery = fetchGrocery()
        let (m, c, g) = await (meals, people, grocery)

        if let dinner = m.first(where: { $0.mealType == "dinner" && $0.date == todayKey }) {
            tonight = TonightMeal(dinner)
        } else {
            tonight = nil
        }
        chores = c.filter { $0.total > 0 }
        groceryRemaining = g.filter { !$0.checked }.count
        loaded = true
    }

    private func fetchMeals(_ day: String) async -> [NookAPI.WeekEntryDTO] {
        (try? await api.mealsWeek(start: day)) ?? []
    }
    private func fetchChores() async -> [NookAPI.PersonChoresDTO] {
        (try? await api.choresToday()) ?? []
    }
    private func fetchGrocery() async -> [NookAPI.GroceryItemDTO] {
        (try? await api.groceryItems()) ?? []
    }
}
