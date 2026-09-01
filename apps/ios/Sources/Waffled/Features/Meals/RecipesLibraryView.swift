import SwiftUI
import Observation

/// The Recipes library — every recipe in the household **and every saved plate**
/// (decision 11: a saved meal is a first-class citizen of the library), searchable +
/// filterable, rendered as a two-column card grid. Tapping a card opens its detail.
/// The server returns the whole library (no server-side search), so all filtering and
/// sorting happens client-side in `LibraryFilter`, mirroring the kiosk.
@MainActor
@Observable
final class RecipesModel {
    private(set) var recipes: [WaffledAPI.RecipeSummary] = []
    /// Saved plates, listed alongside the recipes.
    private(set) var meals: [WaffledAPI.MealDTO] = []
    /// The searchable text for every entry, keyed by id and rebuilt **once per load**.
    /// Recomputing it per keystroke is the search-field jank trap this app has hit.
    private(set) var haystacks: [String: String] = [:]
    private(set) var loading = true
    private(set) var error = false

    private let api = WaffledAPI()

    func load() async {
        loading = true
        // Plates come from a different endpoint, and a server predating Meal Builder
        // simply has none — which must not blank the recipes alongside them.
        let api = self.api
        async let fetchedRecipes = try? await api.recipeLibrary()
        async let fetchedMeals = try? await api.savedMeals()
        let (r, m) = await (fetchedRecipes, fetchedMeals)
        if let r {
            recipes = r
            error = false
        } else {
            error = true
        }
        meals = m ?? []
        haystacks = LibraryFilter.haystacks(recipes: recipes, meals: meals)
        loading = false
    }

    /// Replace one recipe in place after a favorite/cooked change on the detail
    /// screen, so the library reflects it without a full reload.
    func apply(_ updated: WaffledAPI.RecipeSummary) {
        if let i = recipes.firstIndex(where: { $0.id == updated.id }) {
            recipes[i] = updated
            haystacks[updated.id] = LibraryFilter.haystack(updated)
        }
    }

    /// Drop a deleted recipe from the library without a full reload.
    func remove(id: String) {
        recipes.removeAll { $0.id == id }
        haystacks[id] = nil
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
/// recipe (or plate) detail; in **pick mode** (`onPick` set, e.g. the planner's
/// "Choose a recipe" sheet, or the Meal Builder's "＋ Add a side") a card calls back
/// instead, so the same browse UI doubles as the picker. `model` is owned by the caller.
struct RecipesLibraryView: View {
    let model: RecipesModel
    var onPick: ((WaffledAPI.RecipeSummary) -> Void)? = nil
    /// Pick a saved plate. When picking is on but this is nil the caller can only use
    /// a single recipe (the planner's slot picker), so plates are hidden rather than
    /// rendered as a control that does nothing.
    var onPickMeal: ((WaffledAPI.MealDTO) -> Void)? = nil
    /// A plate to leave out — the one currently being built. Adding a plate to itself
    /// flattens it into itself, which silently renumbers every dish it already has.
    var excludeMealId: String? = nil
    @Environment(SyncManager.self) private var sync
    @State private var f = LibraryFilters()
    @State private var creating = false
    /// A recipe just written from inside the picker, held until the editor's cover has
    /// finished dismissing — then handed to `onPick`.
    @State private var createdForPick: WaffledAPI.RecipeSummary?
    /// Non-nil ⇒ the Meal Builder is up. Presented (not pushed) because this screen is
    /// hosted by four different navigation stacks, only one of which knows MealsRoute.
    @State private var building: MealBuilderStart?
    @FocusState private var searchFocused: Bool
    /// Recently-opened recipes — a shortcut back to what you just had open.
    @State private var recent: [WaffledAPI.RecipeSummary] = []
    /// Whose history the rail shows. Per-device (a viewing preference, not household
    /// config), so it's `@AppStorage` rather than server state — same as the web's
    /// localStorage key, and the same reason the pinned Today goal is stored locally.
    @AppStorage("waffled.recentRecipesScope") private var recentScope = "me"

    /// Seed `initialProtein` to open the library pre-filtered to one protein (the
    /// "Cook from your pantry" mains deep-link), or `initialNewOnly` to open filtered
    /// to never-cooked recipes (the recipe-detail "🆕 New" tag deep-link). Preserves
    /// the memberwise call sites.
    init(model: RecipesModel, initialProtein: String? = nil, initialNewOnly: Bool = false,
         onPick: ((WaffledAPI.RecipeSummary) -> Void)? = nil,
         onPickMeal: ((WaffledAPI.MealDTO) -> Void)? = nil,
         excludeMealId: String? = nil) {
        self.model = model
        self.onPick = onPick
        self.onPickMeal = onPickMeal
        self.excludeMealId = excludeMealId
        var seed = LibraryFilters()
        seed.protein = initialProtein.map { [$0] } ?? []
        seed.onlyNew = initialNewOnly
        _f = State(initialValue: seed)
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
            if f.any { filterBar }
            recentRail
            content
        }
        .background(WF.canvas)
        // Picking, and the recipe you want isn't written yet: write it here and it fills
        // the slot you opened. This lives in the nav bar rather than beside the filter
        // chips — a fourth chip overflowed the row on a phone and wrapped its label mid-
        // word, and "+" in the bar is where iOS puts "make a new one" anyway. Both hosts
        // (the planner's picker sheet and the Meal Builder's add-a-dish sheet) use only
        // `.cancellationAction`, so this can't collide. Only a recipe — a plate inside a
        // plate isn't something the picker's callers can take.
        .toolbar {
            if onPick != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New recipe")
                }
            }
        }
        // `.onAppear`, not `.task`: this has to re-run when the library is returned
        // TO — popping back from a recipe is what makes that recipe the newest entry
        // in the rail. `.onAppear` fires on every appearance by contract; `.task`'s
        // behaviour on a NavigationStack pop is an implementation detail to rely on.
        .onAppear { Task { await loadRecent() } }
        .onChange(of: recentScope) { _, _ in Task { await loadRecent() } }
        .refreshable { await model.load(); await loadRecent() }
        .fullScreenCover(isPresented: $creating, onDismiss: {
            // Hand a just-written recipe back only once the editor is fully gone:
            // picking dismisses the picker sheet this library sits in, and tearing
            // down two presentations in the same frame drops the animation.
            if let saved = createdForPick { createdForPick = nil; onPick?(saved) }
        }) {
            RecipeEditorView(mode: .create) { saved in
                Task { await model.load() }
                if onPick != nil { createdForPick = saved }
            }
        }
        .fullScreenCover(item: $building) { start in
            NavigationStack { MealBuilderView(start: start, recipes: model) }
                // A plate built here belongs in the library the moment it's saved.
                .onDisappear { Task { await model.load() } }
        }
        // A recipe or meal written anywhere else (another device, the editor, the
        // planner) reloads the library — and the rail with it, since a rename or a
        // delete has to be reflected there too. Recording a VIEW doesn't move this
        // rev; returning to the library is what refreshes the rail, above.
        .onChange(of: sync.mealsRev) { _, _ in Task { await model.load(); await loadRecent() } }
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
            TextField("Search recipes, meals, a veggie…", text: $f.query)
                .font(.system(size: 15)).textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFocused)
            if !f.query.isEmpty {
                Button { f.query = "" } label: {
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

    /// Plates the current caller can actually use. In pick mode without a meal handler
    /// a plate card would be a control that does nothing when tapped.
    private var pickableMeals: [WaffledAPI.MealDTO] {
        guard onPick == nil || onPickMeal != nil else { return [] }
        guard let excludeMealId else { return model.meals }
        return model.meals.filter { $0.id != excludeMealId }
    }

    private var entries: [LibraryEntry] {
        LibraryFilter.entries(recipes: model.recipes, meals: pickableMeals,
                              filters: f, haystacks: model.haystacks)
    }

    @ViewBuilder private var content: some View {
        let list = entries
        if model.loading && model.recipes.isEmpty {
            ProgressView().tint(WF.ink3).padding(.top, 60)
        } else if model.recipes.isEmpty && model.meals.isEmpty {
            empty(model.error ? "Couldn’t load your recipes." : "No recipes yet. Import some with `just import-recipes`.")
        } else if list.isEmpty {
            empty("Nothing matches. Try clearing filters.")
        } else {
            LazyVGrid(columns: cols, spacing: 14) {
                ForEach(list) { entry in card(entry) }
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, WF.tabBarClearance)
        }
    }

    @ViewBuilder private func card(_ entry: LibraryEntry) -> some View {
        switch entry {
        case .recipe(let r):
            if let onPick {
                Button { onPick(r) } label: { RecipeCard(recipe: r) }.buttonStyle(.plain)
            } else {
                NavigationLink(value: MealsRoute.recipe(r)) { RecipeCard(recipe: r) }
                    .buttonStyle(.plain)
            }
        case .meal(let m):
            if let onPickMeal {
                Button { onPickMeal(m) } label: { MealCard(meal: m) }.buttonStyle(.plain)
            } else {
                NavigationLink(value: MealsRoute.meal(m)) { MealCard(meal: m) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(.system(size: 14)).foregroundStyle(WF.ink3)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity).padding(.horizontal, 30).padding(.top, 70)
    }

    // MARK: facet values

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
                Picker("Sort", selection: $f.sort) {
                    ForEach(RecipeSort.allCases) { s in
                        Label(s.rawValue, systemImage: s.icon).tag(s)
                    }
                }
                // Plates carry no cuisine/protein/dietary metadata, so every structured
                // facet below legitimately drops them — the control that *selects* them
                // has to be a TYPE filter, or it would filter itself out.
                if !pickableMeals.isEmpty {
                    Section("Show") {
                        Picker("Show", selection: $f.type) {
                            ForEach(LibraryType.allCases) { t in Text(t.chip).tag(t) }
                        }
                    }
                }
                Section("Cuisine") { facetToggles(uniqueValues(\.cuisine), $f.cuisine) }
                Section("Protein") { facetToggles(uniqueValues(\.protein), $f.protein) }
                if !allDietary.isEmpty { Section("Dietary") { facetToggles(allDietary, $f.dietary) } }
            } label: {
                pill(systemImage: f.any ? "line.3.horizontal.decrease.circle.fill"
                                        : "line.3.horizontal.decrease.circle",
                     text: f.sort.rawValue, active: f.any)
            }
            Spacer()
            Button { withAnimation(.snappy) { f.onlyNew.toggle() } } label: {
                pill(systemImage: "sparkles", text: "New", active: f.onlyNew)
            }
            Button { withAnimation(.snappy) { f.onlyFavorites.toggle() } } label: {
                pill(systemImage: onlyFavoritesIcon, text: "Favorites", active: f.onlyFavorites)
            }
            // Browsing (not picking for a meal slot) → offer something new to make.
            if onPick == nil {
                Menu {
                    Button { creating = true } label: { Label("New recipe", systemImage: "book") }
                    Button { building = .fresh } label: { Label("New meal", systemImage: "square.stack.3d.up") }
                } label: {
                    pill(systemImage: "plus", text: "New", active: false)
                }
            }
        }
        .padding(.horizontal, 16).padding(.top, 8)
    }

    private var onlyFavoritesIcon: String { f.onlyFavorites ? "heart.fill" : "heart" }

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

    /// A horizontal shortcut strip back to recently-opened recipes. Rendered only
    /// when there IS history — an empty strip under a heading is worse than nothing —
    /// and deliberately smaller than a `RecipeCard`, so it reads as a way back rather
    /// than a second library.
    @ViewBuilder private var recentRail: some View {
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    SectionLabel(text: "Recently viewed")
                    Spacer(minLength: 8)
                    Picker("", selection: $recentScope) {
                        Text("Me").tag("me")
                        Text("Everyone").tag("household")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 156)
                }
                .padding(.horizontal, 16)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(recent) { r in
                            recentTile(r)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .padding(.top, 6).padding(.bottom, 10)
        }
    }

    // Mirrors `card(_:)`: a picker-mode tap hands the recipe back, otherwise it
    // pushes the detail through the same route the grid uses.
    @ViewBuilder private func recentTile(_ r: WaffledAPI.RecipeSummary) -> some View {
        if let onPick {
            Button { onPick(r) } label: { recentTileLabel(r) }.buttonStyle(.plain)
        } else {
            NavigationLink(value: MealsRoute.recipe(r)) { recentTileLabel(r) }.buttonStyle(.plain)
        }
    }

    private func recentTileLabel(_ r: WaffledAPI.RecipeSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // CachedImage for the same reason the grid uses it — these scroll, and
            // AsyncImage would re-decode on every pass.
            CachedImage(r.imageUrl, contentMode: .fill) {
                RecipeGradient.forCategory(r.category)
                    .overlay(Text(r.emoji ?? RecipeGradient.emoji(r.category)).font(.system(size: 26)))
            }
            .frame(width: 104, height: 68).clipped()
            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))

            Text(r.title)
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink)
                .lineLimit(2).multilineTextAlignment(.leading)
                .frame(width: 104, alignment: .leading)
        }
    }

    private func loadRecent() async {
        let scope: WaffledAPI.RecentRecipeScope = recentScope == "household" ? .household : .me
        recent = (try? await WaffledAPI().recentRecipes(scope: scope)) ?? []
    }

    /// Inline chips for whatever's active, with a one-tap Clear (shown only when
    /// at least one filter is on).
    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if f.type != .all { activeChip(f.type.chip) { f.type = .all } }
                if f.onlyFavorites { activeChip("❤️ Favorites") { f.onlyFavorites = false } }
                if f.onlyNew { activeChip("🆕 New") { f.onlyNew = false } }
                ForEach(Array(f.cuisine).sorted(), id: \.self) { v in
                    activeChip("🌍 \(v.capitalized)") { f.cuisine.remove(v) }
                }
                ForEach(Array(f.protein).sorted(), id: \.self) { v in
                    activeChip("🥩 \(v.capitalized)") { f.protein.remove(v) }
                }
                ForEach(Array(f.dietary).sorted(), id: \.self) { v in
                    activeChip(v.capitalized) { f.dietary.remove(v) }
                }
                Button {
                    withAnimation { f = LibraryFilters(query: f.query, sort: f.sort) }
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
                // CachedImage (NSCache-backed, resolves relative /media URLs) shows the real
                // photo when there is one; otherwise the category gradient + emoji. Cards
                // live in a LazyVGrid, so AsyncImage would re-fetch on every scroll/keystroke.
                CachedImage(recipe.imageUrl, contentMode: .fill) {
                    RecipeGradient.forCategory(recipe.category)
                        .overlay(Text(recipe.emoji ?? RecipeGradient.emoji(recipe.category)).font(.system(size: 42)))
                }
                .frame(height: 104).frame(maxWidth: .infinity).clipped()
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

/// A saved plate in the recipe library — same tile shape as `RecipeCard`, with the
/// type badge that tells the two apart.
struct MealCard: View {
    let meal: WaffledAPI.MealDTO

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                RecipeGradient.forCategory("dinner")
                    .overlay(
                        Text(meal.emojis.isEmpty ? "🍽️" : meal.emojis.prefix(3).joined())
                            .font(.system(size: 34)).lineLimit(1)
                    )
                    .frame(height: 104).frame(maxWidth: .infinity).clipped()
                // Plates and recipes share one grid, so each plate says what it is.
                Text("🍽️ Meal")
                    .font(.system(size: 10, weight: .heavy)).foregroundStyle(WF.onInk)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(WF.ink).clipShape(Capsule())
                    .padding(7)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(meal.name).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    .lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, minHeight: 40, maxHeight: 40, alignment: .topLeading)
                HStack(spacing: 8) {
                    meta("🥘", "\(meal.recipeCount) \(meal.recipeCount == 1 ? "dish" : "dishes")")
                    if let t = meal.totalMinutes, t > 0 { meta("🕐", "\(t)m") }
                    meta("🍽️", "\(meal.servings)")
                }
                .lineLimit(1)
                // Keeps every card the same height as a RecipeCard's collection line.
                Text(" ").font(.system(size: 11, weight: .medium)).foregroundStyle(WF.ink3)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.horizontal, 11).padding(.top, 9).padding(.bottom, 12)
        }
        .wfField()
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
