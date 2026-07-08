import SwiftUI
import Observation

/// The Recipes library — every recipe in the household, searchable + filterable,
/// rendered as a two-column card grid. Tapping a card opens its full detail. The
/// server returns the whole library (no server-side search), so all filtering and
/// sorting happens client-side, mirroring the kiosk `RecipesLibrary`.
@MainActor
@Observable
final class RecipesModel {
    private(set) var recipes: [WaffledAPI.RecipeSummary] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = WaffledAPI()

    func load() async {
        loading = true
        do {
            recipes = try await api.recipeLibrary()
            error = false
        } catch {
            self.error = true
        }
        loading = false
    }

    /// Replace one recipe in place after a favorite/cooked change on the detail
    /// screen, so the library reflects it without a full reload.
    func apply(_ updated: WaffledAPI.RecipeSummary) {
        if let i = recipes.firstIndex(where: { $0.id == updated.id }) { recipes[i] = updated }
    }

    /// Drop a deleted recipe from the library without a full reload.
    func remove(id: String) {
        recipes.removeAll { $0.id == id }
    }
}

enum RecipeSort: String, CaseIterable, Identifiable {
    case az = "A–Z", quickest = "Quickest", mostCooked = "Most cooked", recent = "Recently cooked"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .az: return "textformat.abc"
        case .quickest: return "bolt"
        case .mostCooked: return "flame"
        case .recent: return "clock"
        }
    }
}

/// The Recipes library screen — the searchable/sortable/filterable card grid.
/// Normally it lives inside the Meals tab's NavigationStack and a card pushes the
/// recipe detail; in **pick mode** (`onPick` set, e.g. the planner's "Choose a
/// recipe" sheet) a card calls `onPick` instead so the same browse UI doubles as
/// the picker. `model` is owned by the caller.
struct RecipesLibraryView: View {
    let model: RecipesModel
    var onPick: ((WaffledAPI.RecipeSummary) -> Void)? = nil
    @Environment(SyncManager.self) private var sync
    @State private var query = ""
    @State private var sort: RecipeSort = .az
    @State private var onlyFavorites = false
    @State private var onlyNew = false
    @State private var selCuisine: Set<String> = []
    @State private var selProtein: Set<String> = []
    @State private var selDietary: Set<String> = []
    @State private var creating = false
    @FocusState private var searchFocused: Bool

    /// Seed `initialProtein` to open the library pre-filtered to one protein (the
    /// "Cook from your pantry" mains deep-link), or `initialNewOnly` to open filtered
    /// to never-cooked recipes (the recipe-detail "🆕 New" tag deep-link). Preserves
    /// the memberwise call sites.
    init(model: RecipesModel, initialProtein: String? = nil, initialNewOnly: Bool = false,
         onPick: ((WaffledAPI.RecipeSummary) -> Void)? = nil) {
        self.model = model
        self.onPick = onPick
        _selProtein = State(initialValue: initialProtein.map { [$0] } ?? [])
        _onlyNew = State(initialValue: initialNewOnly)
    }

    // iPhone: 2 fixed columns. iPad: adaptive — as many ~240pt cards as fit the width.
    private var cols: [GridItem] {
        DeviceExperience.current == .kiosk
            ? [GridItem(.adaptive(minimum: 220, maximum: 320), spacing: 14)]
            : [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]
    }

    var body: some View {
        ScrollView {
            searchField
            controlsBar
            if anyFilter { filterBar }
            content
        }
        .background(WF.canvas)
        .refreshable { await model.load() }
        .fullScreenCover(isPresented: $creating) {
            RecipeEditorView(mode: .create) { _ in Task { await model.load() } }
        }
        .onChange(of: sync.mealsRev) { _, _ in Task { await model.load() } }
        // In pick mode (the planner's "Choose a recipe" sheet), focus search on open.
        .task {
            if onPick != nil { try? await Task.sleep(for: .milliseconds(350)); searchFocused = true }
        }
    }

    /// Inline search field — kept in the content (not `.searchable`), since the Meals
    /// tab's principal segmented control suppresses the nav-bar search drawer.
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(WF.ink3)
            TextField("Search recipes, cuisine, a veggie…", text: $query)
                .font(.system(size: 15)).textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFocused)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 15)).foregroundStyle(WF.ink3)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 13).padding(.vertical, 10)
        .background(WF.panel).clipShape(Capsule())
        .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
        .padding(.horizontal, 16).padding(.top, 10)
    }

    @ViewBuilder private var content: some View {
        let list = filtered
        if model.loading && model.recipes.isEmpty {
            ProgressView().tint(WF.ink3).padding(.top, 60)
        } else if model.recipes.isEmpty {
            empty(model.error ? "Couldn’t load your recipes." : "No recipes yet. Import some with `just import-recipes`.")
        } else if list.isEmpty {
            empty("No recipes match. Try clearing filters.")
        } else {
            LazyVGrid(columns: cols, spacing: 14) {
                ForEach(list) { r in
                    if let onPick {
                        Button { onPick(r) } label: { RecipeCard(recipe: r) }.buttonStyle(.plain)
                    } else {
                        NavigationLink(value: MealsRoute.recipe(r)) { RecipeCard(recipe: r) }
                            .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 110)
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(.system(size: 14)).foregroundStyle(WF.ink3)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity).padding(.horizontal, 30).padding(.top, 70)
    }

    // MARK: filtering + sorting

    /// All recipe text the search box matches against (mirrors the kiosk haystack).
    private func haystack(_ r: WaffledAPI.RecipeSummary) -> String {
        ([r.title, r.cuisine, r.protein, r.base, r.mealType, r.effort, r.cookMethod, r.collection]
            .compactMap { $0 }
         + (r.tags ?? []) + (r.vegetables ?? []) + (r.dietary ?? []))
            .joined(separator: " ").lowercased()
    }

    private var filtered: [WaffledAPI.RecipeSummary] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let matched = model.recipes.filter { r in
            if onlyFavorites && !r.isFavorite { return false }
            if onlyNew && r.cookedCount != 0 { return false }
            if !q.isEmpty && !haystack(r).contains(q) { return false }
            if !selCuisine.isEmpty && !(r.cuisine.map(selCuisine.contains) ?? false) { return false }
            if !selProtein.isEmpty && !(r.protein.map(selProtein.contains) ?? false) { return false }
            if !selDietary.isEmpty && Set(r.dietary ?? []).isDisjoint(with: selDietary) { return false }
            return true
        }
        return matched.sorted(by: sortLess)
    }

    private func sortLess(_ a: WaffledAPI.RecipeSummary, _ b: WaffledAPI.RecipeSummary) -> Bool {
        switch sort {
        case .az: return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
        case .quickest: return (a.totalTimeMinutes ?? .max) < (b.totalTimeMinutes ?? .max)
        case .mostCooked: return a.cookedCount > b.cookedCount
        case .recent: return (a.lastCookedAt ?? "") > (b.lastCookedAt ?? "")
        }
    }

    private var anyFilter: Bool {
        onlyFavorites || onlyNew || !selCuisine.isEmpty || !selProtein.isEmpty || !selDietary.isEmpty
    }

    private func uniqueValues(_ pick: (WaffledAPI.RecipeSummary) -> String?) -> [String] {
        Array(Set(model.recipes.compactMap(pick))).sorted()
    }
    private var allDietary: [String] {
        Array(Set(model.recipes.flatMap { $0.dietary ?? [] })).sorted()
    }

    // MARK: chrome

    /// Sort + filter live in the content (not the nav bar) so the Meals segmented
    /// control stays centered.
    private var controlsBar: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Sort", selection: $sort) {
                    ForEach(RecipeSort.allCases) { s in
                        Label(s.rawValue, systemImage: s.icon).tag(s)
                    }
                }
                Section("Cuisine") { facetToggles(uniqueValues(\.cuisine), $selCuisine) }
                Section("Protein") { facetToggles(uniqueValues(\.protein), $selProtein) }
                if !allDietary.isEmpty { Section("Dietary") { facetToggles(allDietary, $selDietary) } }
            } label: {
                pill(systemImage: anyFilter ? "line.3.horizontal.decrease.circle.fill"
                                            : "line.3.horizontal.decrease.circle",
                     text: sort.rawValue, active: anyFilter)
            }
            Spacer()
            Button { withAnimation(.snappy) { onlyNew.toggle() } } label: {
                pill(systemImage: "sparkles", text: "New", active: onlyNew)
            }
            Button { withAnimation(.snappy) { onlyFavorites.toggle() } } label: {
                pill(systemImage: onlyFavorites ? "heart.fill" : "heart",
                     text: "Favorites", active: onlyFavorites)
            }
            // Browsing (not picking for a meal slot) → offer "New recipe".
            if onPick == nil {
                Button { creating = true } label: { pill(systemImage: "plus", text: "New", active: false) }
            }
        }
        .padding(.horizontal, 16).padding(.top, 8)
    }

    private func pill(systemImage: String, text: String, active: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage).font(.system(size: 13, weight: .semibold))
            Text(text).font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(active ? WF.primary : WF.ink2)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(active ? WF.primary.opacity(0.1) : WF.card)
        .overlay(Capsule().strokeBorder(active ? WF.primary.opacity(0.4) : WF.hair, lineWidth: 1))
        .clipShape(Capsule())
    }

    @ViewBuilder private func facetToggles(_ values: [String], _ set: Binding<Set<String>>) -> some View {
        ForEach(values, id: \.self) { v in
            Button {
                if set.wrappedValue.contains(v) { set.wrappedValue.remove(v) } else { set.wrappedValue.insert(v) }
            } label: {
                Label(v.capitalized, systemImage: set.wrappedValue.contains(v) ? "checkmark" : "")
            }
        }
    }

    /// Inline chips for whatever's active, with a one-tap Clear (shown only when
    /// at least one filter is on).
    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if onlyFavorites { activeChip("❤️ Favorites") { onlyFavorites = false } }
                if onlyNew { activeChip("🆕 New") { onlyNew = false } }
                ForEach(Array(selCuisine).sorted(), id: \.self) { v in
                    activeChip("🌍 \(v.capitalized)") { selCuisine.remove(v) }
                }
                ForEach(Array(selProtein).sorted(), id: \.self) { v in
                    activeChip("🥩 \(v.capitalized)") { selProtein.remove(v) }
                }
                ForEach(Array(selDietary).sorted(), id: \.self) { v in
                    activeChip(v.capitalized) { selDietary.remove(v) }
                }
                Button {
                    withAnimation { onlyFavorites = false; onlyNew = false; selCuisine = []; selProtein = []; selDietary = [] }
                } label: {
                    Text("Clear").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }

    private func activeChip(_ text: String, remove: @escaping () -> Void) -> some View {
        Button(action: { withAnimation { remove() } }) {
            HStack(spacing: 5) {
                Text(text).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(WF.primary.opacity(0.12))
            .overlay(Capsule().strokeBorder(WF.primary.opacity(0.5), lineWidth: 1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// One recipe tile: a gradient hero with the recipe emoji, then title + a compact
/// meta line (cuisine · protein · time · cooked count).
struct RecipeCard: View {
    let recipe: WaffledAPI.RecipeSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                RecipeGradient.forCategory(recipe.category)
                    .overlay(Text(recipe.emoji ?? RecipeGradient.emoji(recipe.category)).font(.system(size: 42)))
                    .frame(height: 104)
                    .overlay(alignment: .topLeading) {
                        // Never cooked → a "🆕" corner badge (mirrors the kiosk library).
                        if recipe.cookedCount == 0 {
                            Text("🆕").font(.system(size: 15)).padding(7)
                        }
                    }
                if recipe.isFavorite {
                    Text("❤️").font(.system(size: 15)).padding(7)
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                // Fixed 2-line title + an always-present meta + collection line, so every
                // card is the same height regardless of how many tags a recipe has.
                Text(recipe.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    .lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, minHeight: 40, maxHeight: 40, alignment: .topLeading)
                metaLine
                Text(recipe.collection.map { "📁 \($0)" } ?? " ")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(WF.ink3).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.horizontal, 11).padding(.top, 9).padding(.bottom, 12)
        }
        .wfField()
    }

    private var metaLine: some View {
        HStack(spacing: 8) {
            if let c = recipe.cuisine { meta("🌍", c) }
            if let p = recipe.protein { meta("🥩", p) }
            // Total time = prep + cook (the card summarizes; the detail breaks it down).
            if let t = recipe.totalTimeMinutes { meta("🕐", "\(t)m") }
            if recipe.cookedCount > 0 { meta("👨‍🍳", "\(recipe.cookedCount)×") }
        }
        .lineLimit(1)
    }

    private func meta(_ icon: String, _ text: String) -> some View {
        Text("\(icon) \(text)").font(.system(size: 11, weight: .medium)).foregroundStyle(WF.ink2)
    }
}

/// Category → hero gradient + fallback emoji, mirroring the kiosk's `GRAD_BY_CATEGORY`.
enum RecipeGradient {
    static func forCategory(_ category: String?) -> LinearGradient {
        let pair: (UInt32, UInt32)
        switch category?.lowercased() {
        case "breakfast": pair = (0xF3E2C4, 0xE6C188)
        case "dinner":    pair = (0xF6D9C6, 0xE9B596)
        case "snack", "dessert": pair = (0xECCFA6, 0xD8A868)
        default:          pair = (0xD9E6C2, 0xA9C585) // lunch / fallback
        }
        return LinearGradient(colors: [Color(hex: pair.0), Color(hex: pair.1)],
                              startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static func emoji(_ category: String?) -> String {
        switch category?.lowercased() {
        case "breakfast": return "🥞"
        case "lunch": return "🥗"
        case "dinner": return "🍝"
        case "snack", "dessert": return "🍪"
        default: return "🍽️"
        }
    }
}

extension WaffledAPI.RecipeSummary {
    /// Total active time = prep + cook (the library card's "🕐"), or nil if neither is set.
    var totalTimeMinutes: Int? {
        let t = (prepTimeMinutes ?? 0) + (cookTimeMinutes ?? 0)
        return t > 0 ? t : nil
    }

    /// A minimal placeholder for an instant recipe-detail header when only partial
    /// info is on hand (the planner, the Today card). The detail screen reloads the
    /// full recipe on appear.
    static func placeholder(id: String, title: String, emoji: String?, category: String?,
                            cookTimeMinutes: Int?, servings: Int?) -> WaffledAPI.RecipeSummary {
        .init(id: id, title: title, emoji: emoji, category: category, prepTimeMinutes: nil,
              cookTimeMinutes: cookTimeMinutes, servings: servings, imageUrl: nil, sourceName: nil,
              isFavorite: false, cookedCount: 0, lastCookedAt: nil, mealType: nil, protein: nil,
              base: nil, cuisine: nil, effort: nil, cookMethod: nil, flavorProfile: nil, dietary: nil, vegetables: nil,
              collection: nil, tags: nil, addedTags: nil, notes: nil, userNotes: nil, overrides: nil)
    }
}
