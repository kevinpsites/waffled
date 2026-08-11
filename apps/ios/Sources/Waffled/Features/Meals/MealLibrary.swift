import Foundation

// A saved plate is a first-class citizen of the recipe library (decision 11): it sits
// in the same grid as the recipes and the search box matches it. This file holds the
// merge/filter/sort so the library view stays a view, and so the rules below can be
// pinned by tests.

/// One row in the unified library — a recipe or a saved plate.
enum LibraryEntry: Identifiable, Hashable {
    case recipe(WaffledAPI.RecipeSummary)
    case meal(WaffledAPI.MealDTO)

    var id: String {
        switch self {
        case .recipe(let r): return r.id
        case .meal(let m): return m.id
        }
    }
    var title: String {
        switch self {
        case .recipe(let r): return r.title
        case .meal(let m): return m.name
        }
    }
    var isMeal: Bool { if case .meal = self { return true } else { return false } }
    /// Hands-on + cooking. For a plate this is the sum across its dishes.
    var totalMinutes: Int? {
        switch self {
        case .recipe(let r): return r.totalTimeMinutes
        case .meal(let m): return m.totalMinutes
        }
    }
    /// Cook history is recipe-only; a plate has none, which is why the history sorts
    /// put plates last rather than floating them to the top on a tie.
    var cookedCount: Int {
        if case .recipe(let r) = self { return r.cookedCount }
        return 0
    }
    var lastCookedAt: String? {
        if case .recipe(let r) = self { return r.lastCookedAt }
        return nil
    }
}

/// Recipes / plates / both. The **type** filter is the only thing that can select
/// plates: they carry no cuisine, protein or dietary metadata, so a facet-shaped
/// "Meals" filter would filter itself out.
enum LibraryType: String, CaseIterable, Identifiable, Sendable {
    case all = "All", recipes = "Recipes", meals = "Meals"
    var id: String { rawValue }
    /// The chip label — plates get the 🍽️ the rest of the app uses for a meal.
    var chip: String {
        switch self {
        case .all: return "All"
        case .recipes: return "📖 Recipes"
        case .meals: return "🍽️ Meals"
        }
    }
}

/// Everything the library screen filters and sorts by, in one value.
struct LibraryFilters {
    var query = ""
    var type: LibraryType = .all
    var onlyFavorites = false
    var onlyNew = false
    var cuisine: Set<String> = []
    var protein: Set<String> = []
    var dietary: Set<String> = []
    var sort: RecipeSort = .az

    /// The recipe-metadata filters. Any of these on ⇒ no plate can match.
    var anyStructured: Bool {
        onlyFavorites || onlyNew || !cuisine.isEmpty || !protein.isEmpty || !dietary.isEmpty
    }
    var any: Bool { anyStructured || type != .all }
}

enum LibraryFilter {
    /// All the recipe text the search box matches against (mirrors the kiosk haystack).
    static func haystack(_ r: WaffledAPI.RecipeSummary) -> String {
        ([r.title, r.cuisine, r.protein, r.base, r.mealType, r.effort, r.cookMethod, r.collection]
            .compactMap { $0 }
         + (r.tags ?? []) + (r.vegetables ?? []) + (r.dietary ?? []))
            .joined(separator: " ").lowercased()
    }

    /// A plate matches on its own name **and on every dish title** — searching
    /// "chicken" has to find "BBQ Sunday", whose name contains no such word.
    static func haystack(_ m: WaffledAPI.MealDTO) -> String {
        ([m.name] + m.recipes.compactMap(\.title)).joined(separator: " ").lowercased()
    }

    /// Precomputed once per data load. Rebuilding these per keystroke is the search-
    /// field jank trap the app has hit before.
    static func haystacks(recipes: [WaffledAPI.RecipeSummary],
                          meals: [WaffledAPI.MealDTO]) -> [String: String] {
        var out: [String: String] = [:]
        out.reserveCapacity(recipes.count + meals.count)
        for r in recipes { out[r.id] = haystack(r) }
        for m in meals { out[m.id] = haystack(m) }
        return out
    }

    static func entries(recipes: [WaffledAPI.RecipeSummary], meals: [WaffledAPI.MealDTO],
                        filters f: LibraryFilters, haystacks: [String: String]) -> [LibraryEntry] {
        let q = f.query.trimmingCharacters(in: .whitespaces).lowercased()
        var out: [LibraryEntry] = []
        out.reserveCapacity(recipes.count + meals.count)

        if f.type != .meals {
            for r in recipes {
                if f.onlyFavorites && !r.isFavorite { continue }
                if f.onlyNew && r.cookedCount != 0 { continue }
                if !q.isEmpty && !(haystacks[r.id] ?? "").contains(q) { continue }
                if !f.cuisine.isEmpty && !(r.cuisine.map(f.cuisine.contains) ?? false) { continue }
                if !f.protein.isEmpty && !(r.protein.map(f.protein.contains) ?? false) { continue }
                if !f.dietary.isEmpty && Set(r.dietary ?? []).isDisjoint(with: f.dietary) { continue }
                out.append(.recipe(r))
            }
        }

        // Plates carry no cuisine / protein / dietary / cook-history metadata, so any
        // structured facet legitimately drops all of them. That is exactly why the
        // control that *selects* plates is a type filter and not another facet.
        if f.type != .recipes && !f.anyStructured {
            for m in meals {
                if !q.isEmpty && !(haystacks[m.id] ?? "").contains(q) { continue }
                out.append(.meal(m))
            }
        }

        return out.sorted { less($0, $1, f.sort) }
    }

    private static func less(_ a: LibraryEntry, _ b: LibraryEntry, _ sort: RecipeSort) -> Bool {
        switch sort {
        case .az: return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
        case .quickest: return (a.totalMinutes ?? .max) < (b.totalMinutes ?? .max)
        case .mostCooked: return a.cookedCount > b.cookedCount
        case .recent: return (a.lastCookedAt ?? "") > (b.lastCookedAt ?? "")
        }
    }
}
