import SwiftUI

/// A destination within the Meals tab's shared navigation stack.
enum MealsRoute: Hashable {
    case recipes                      // the full Recipes library (pushed)
    case recipe(NookAPI.RecipeSummary) // one recipe's detail
}

/// Meals tab. A single NavigationStack hosts a **This week** planner and the
/// **Recipes** library (switched by a segmented control), both drilling into the
/// same recipe detail. The recipe `model` and nav `path` are owned here and shared
/// so either screen can open a recipe and the planner's picker reuses the library.
struct MealsView: View {
    @Binding var path: [MealsRoute]
    @State private var model = RecipesModel()
    @State private var section = 0   // 0 = Week, 1 = Month, 2 = Recipes

    /// Fire the headless deep-link at most once per process.
    private static var didDeepLink = false

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if section == 0 {
                    WeekPlannerView(recipes: model, path: $path)
                } else if section == 1 {
                    MonthPlannerView(recipes: model, path: $path)
                } else {
                    RecipesLibraryView(model: model)
                }
            }
            .background(NK.canvas)
            // Inline title (no large-title gap); the segmented control is the only
            // nav-bar item and neither screen adds trailing buttons, so it stays
            // centered instead of jumping.
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("", selection: $section) {
                        Text("Week").tag(0)
                        Text("Month").tag(1)
                        Text("Recipes").tag(2)
                    }
                    .pickerStyle(.segmented).frame(width: 260)
                }
            }
            .navigationDestination(for: MealsRoute.self) { route in
                switch route {
                case .recipes: RecipesLibraryView(model: model)
                case .recipe(let r): RecipeDetailView(summary: r, model: model)
                }
            }
        }
        .task { await model.load(); deepLinkIfNeeded() }
    }

    /// Headless verification: NOOK_OPEN_RECIPE=<title substring> pushes that recipe.
    private func deepLinkIfNeeded() {
        guard !Self.didDeepLink, let want = DemoHooks.openRecipe?.lowercased() else { return }
        if let match = model.recipes.first(where: { $0.title.lowercased().contains(want) }) {
            Self.didDeepLink = true
            section = 2
            path = [.recipe(match)]
        }
    }
}
