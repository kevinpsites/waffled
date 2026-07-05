import SwiftUI

/// A destination within the Meals tab's shared navigation stack.
enum MealsRoute: Hashable {
    case recipes                      // the full Recipes library (pushed)
    case recipe(WaffledAPI.RecipeSummary) // one recipe's detail
}

/// Meals tab. A single NavigationStack hosts a **This week** planner and the
/// **Recipes** library (switched by a segmented control), both drilling into the
/// same recipe detail. The recipe `model` and nav `path` are owned here and shared
/// so either screen can open a recipe and the planner's picker reuses the library.
struct MealsView: View {
    @Binding var path: [MealsRoute]
    @State private var model = RecipesModel()
    @State private var section = MealsView.initialSection   // 0 = Week, 1 = Month, 2 = Recipes

    private static var initialSection: Int {
        switch DemoHooks.mealsSection { case "month": return 1; case "recipes": return 2; default: return 0 }
    }

    /// Fire the headless deep-link at most once per process.
    private static var didDeepLink = false

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if isKiosk {
                    // iPad gets a proper page header (title + subtitle) with the
                    // Week/Month/Recipes segment in its trailing slot — web-like, and it
                    // no longer floats alone in the nav bar. The section's own Plan CTA
                    // sits in the planner header just below.
                    VStack(spacing: 0) {
                        KioskPageHeader("Meals", "Plan the week, fill the month, and find something to cook.") {
                            sectionPicker.frame(width: 300)
                        }
                        .padding(.horizontal, 24).padding(.top, 20)
                        sectionView
                    }
                } else {
                    sectionView
                }
            }
            .background(WF.canvas)
            // Inline title (no large-title gap); the segmented control is the only
            // nav-bar item and neither screen adds trailing buttons, so it stays
            // centered instead of jumping. On iPad the segment lives in the page header
            // instead, so the nav bar is hidden.
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !isKiosk {
                    ToolbarItem(placement: .principal) {
                        sectionPicker.frame(width: 260)
                    }
                }
            }
            .toolbar(isKiosk ? .hidden : .visible, for: .navigationBar)
            .navigationDestination(for: MealsRoute.self) { route in
                switch route {
                case .recipes: RecipesLibraryView(model: model)
                case .recipe(let r): RecipeDetailView(summary: r, model: model)
                }
            }
        }
        .task { await model.load(); deepLinkIfNeeded() }
    }

    private var sectionPicker: some View {
        Picker("", selection: $section) {
            Text("Week").tag(0)
            Text("Month").tag(1)
            Text("Recipes").tag(2)
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder private var sectionView: some View {
        if section == 0 {
            WeekPlannerView(recipes: model, path: $path)
        } else if section == 1 {
            MonthPlannerView(recipes: model, path: $path)
        } else {
            RecipesLibraryView(model: model)
        }
    }

    /// Headless verification: WAFFLED_OPEN_RECIPE=<title substring> pushes that recipe.
    private func deepLinkIfNeeded() {
        guard !Self.didDeepLink, let want = DemoHooks.openRecipe?.lowercased() else { return }
        if let match = model.recipes.first(where: { $0.title.lowercased().contains(want) }) {
            Self.didDeepLink = true
            section = 2
            path = [.recipe(match)]
        }
    }
}
