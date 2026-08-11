import SwiftUI

/// A saved **plate**: its dishes grouped by role, each with its own cook and its own
/// Cook button, plus Schedule / Add-to-list / Edit.
///
/// Meals are REST-only by design (decision 9), so this reloads over the network on
/// appear rather than reading a synced mirror.
struct MealDetailView: View {
    /// The plate as the library knew it — shown immediately, then reloaded by id
    /// (the library list carries fewer dish fields than the detail does).
    let summary: WaffledAPI.MealDTO
    let recipes: RecipesModel

    @Environment(SyncManager.self) private var sync
    /// Cook Mode is presented from the app root off this store, so it survives
    /// backgrounding; the Cook button just hands it one loaded dish.
    @Environment(CookSessionStore.self) private var cook

    @State private var meal: WaffledAPI.MealDTO
    @State private var groups: [PlateGroup]
    @State private var scheduling = false
    @State private var editing = false
    @State private var busyDish: String?
    @State private var message: String?

    private let api = WaffledAPI()

    init(summary: WaffledAPI.MealDTO, recipes: RecipesModel) {
        self.summary = summary
        self.recipes = recipes
        _meal = State(initialValue: summary)
        _groups = State(initialValue: PlateRoles.groups(of: summary.recipes))
    }

    var body: some View {
        List {
            headerSection
            ForEach(groups) { group in
                if !group.dishes.isEmpty {
                    Section {
                        ForEach(group.dishes) { dish in
                            PlateDishRow(dish: dish, members: sync.members,
                                         onCook: { startCook(dish) })
                                .listRowBackground(WF.card)
                                .opacity(busyDish == dish.recipeId ? 0.5 : 1)
                        }
                    } header: { SectionLabel(text: group.role.label) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(WF.canvas)
        .navigationTitle(meal.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { scheduling = true } label: { Label("Schedule…", systemImage: "calendar") }
                    Button { addToList() } label: { Label("Add plate to list", systemImage: "cart.badge.plus") }
                    Button { editing = true } label: { Label("Edit meal", systemImage: "pencil") }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(WF.ink2) }
            }
        }
        .task { await reload() }
        .refreshable { await reload() }
        .overlay(alignment: .top) { toast }
        .fullScreenCover(isPresented: $editing) {
            NavigationStack {
                MealBuilderView(start: .editing(meal), recipes: recipes)
            }
            // The builder repaints from its own writes, so pull the plate back in on
            // the way out rather than trying to mirror each edit as it happens.
            .onDisappear { Task { await reload() } }
        }
        .sheet(isPresented: $scheduling) {
            RecipeScheduleSheet(title: meal.name, recipeId: meal.id,
                                eyebrow: "Schedule this meal",
                                perform: { date, mealType in
                                    // Scheduling a SAVED plate copies it, so the plate
                                    // that comes back is next week's copy — this screen
                                    // deliberately keeps showing the template.
                                    _ = try await api.scheduleMeal(id: meal.id, date: date, mealType: mealType)
                                }) { label in
                message = "Scheduled for \(label)."
            }
            .presentationDetents([.medium, .large])
        }
    }

    private var headerSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(meal.emojis.isEmpty ? "🍽️" : meal.emojis.joined()).font(.system(size: 28))
                Text(meal.name).font(WF.serif(22, .bold)).foregroundStyle(WF.ink)
                HStack(spacing: 8) {
                    PlanTag(text: "🍽️ Serves \(meal.servings)")
                    PlanTag(text: "🥘 \(meal.recipeCount) \(meal.recipeCount == 1 ? "dish" : "dishes")")
                    if let t = meal.totalMinutes, t > 0 {
                        PlanTag(text: "🕐 \(MealBuilderModel.hoursMinutes(t))")
                    }
                }
                plateShopping
            }
            .listRowBackground(WF.card)
        }
    }

    /// Plate-level counts dedupe shared ingredients across dishes — two dishes both
    /// wanting mayonnaise is ONE thing to buy. With the pantry off there is no on-hand
    /// claim to make at all.
    @ViewBuilder private var plateShopping: some View {
        switch OnHandClaim.of(onHand: meal.onHand, toBuy: meal.toBuy) {
        case .nothingToSay: EmptyView()
        case .allOnHand:
            Text("✓ Everything for this meal is on hand")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.success)
        case .toBuy(let n):
            VStack(alignment: .leading, spacing: 3) {
                Text("\(n) to buy")
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink)
                // A bare count names nothing — the plate carries the actual shopping.
                Text(meal.toBuyNames.joined(separator: ", "))
                    .font(.system(size: 12)).foregroundStyle(WF.ink3).lineLimit(3)
            }
        }
    }

    @ViewBuilder private var toast: some View {
        if let text = message {
            Text(text)
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.onInk)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(WF.ink).clipShape(Capsule())
                .padding(.top, 8)
                .task(id: text) {
                    try? await Task.sleep(for: .seconds(4))
                    withAnimation { message = nil }
                }
        }
    }

    // MARK: actions

    private func reload() async {
        guard let fresh = try? await api.meal(id: meal.id) else { return }
        meal = fresh
        groups = PlateRoles.groups(of: fresh.recipes)
    }

    private func addToList() {
        Task {
            do {
                let added = try await api.addMealToGrocery(id: meal.id)
                message = added == 1 ? "Added 1 item to the grocery list"
                                     : "Added \(added) items to the grocery list"
            } catch {
                message = "Couldn’t add this plate to the list."
            }
        }
    }

    /// Cook ONE dish. Uses the existing single-recipe cook session — a plate-wide Cook
    /// Mode is being built separately, so nothing here anticipates its API.
    private func startCook(_ dish: WaffledAPI.MealDishDTO) {
        guard busyDish == nil else { return }
        busyDish = dish.recipeId
        Task {
            defer { busyDish = nil }
            guard let d = try? await api.recipeDetail(id: dish.recipeId), !d.steps.isEmpty else {
                message = "That recipe has no method steps to cook yet."
                return
            }
            cook.start(id: d.recipe.id, title: d.recipe.title, steps: d.steps, ingredients: d.ingredients)
        }
    }
}
