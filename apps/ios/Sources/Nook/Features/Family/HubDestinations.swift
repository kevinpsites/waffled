import SwiftUI

/// The launcher tiles on the Family hub. Each pushes a destination in the Family
/// tab's NavigationStack — Lists is built out; the rest are live-summary
/// placeholders until their screens land.
enum HubRoute: Hashable {
    case chores, goals, rewards, lists, photos, settings, pantry
    case list(NookAPI.ListSummary)   // a specific list pushed from the Lists index
    case goal(NookAPI.Goal)          // a specific goal pushed from the Goals screen
    case person(String)              // a person spotlight pushed from the people row
    case recipe(NookAPI.RecipeSummary) // a recipe opened from the grocery meal recap
    case rewardShop(String)          // one person's reward shop (from the Rewards overview)
    case settingsAccount             // Settings → Accounts (sign-in & sign out)
    case settingsFamily              // Settings → Family & people
    case settingsModules             // Settings → Modules (optional features on/off)
    case settingsChoresRewards       // Settings → Chores & rewards (currencies + conversions)
    case settingsCalendars           // Settings → Calendars (Google)
    case settingsAI                  // Settings → AI & capture
    case settingsMeals               // Settings → Meals (calendar)
    case settingsDisplay             // Settings → Display & Kiosk (family-display screensaver)
    case settingsNotifications       // Settings → Notifications (local event reminders)
    case settingsAbout               // Settings → About (version + server address)
    case reviewEvents                // Today → review calendar events that tie to goals
    case approvals                   // Today → pending reward purchases + chore check-offs
}

/// Renders a `HubRoute` destination. Shared by the Family hub and the Today tab so
/// drilling into a person/chores/grocery/recipe stays on whichever tab you started
/// from — Back returns there instead of switching tabs. `hub` is optional: only the
/// placeholder tiles (rewards/photos/settings, reachable from the Family grid) use
/// its summary lines, so Today can omit it.
struct HubDestination: View {
    let route: HubRoute
    @Binding var path: [HubRoute]
    let recipes: RecipesModel
    var hub: FamilyHubModel? = nil

    var body: some View {
        switch route {
        case .lists:            ListsIndexView(path: $path)
        case let .list(list):   ListDetailView(list: list, openRecipe: { path.append(.recipe($0)) })
        case let .recipe(r):    RecipeDetailView(summary: r, model: recipes)
        case .chores:           ChoresView()
        case .pantry:           PantryView()
        case .goals:            GoalsView(path: $path)
        case let .goal(goal):   GoalDetailView(goal: goal, path: $path)
        case let .person(id):   PersonView(personId: id, path: $path)
        case .rewards:          RewardsView(path: $path)
        case let .rewardShop(id): RewardShopView(personId: id, path: $path)
        case .photos:           PhotosView()
        case .settings:         SettingsView(path: $path)
        case .settingsAccount:  AccountSettingsView()
        case .settingsFamily:   FamilyPeopleSettingsView()
        case .settingsModules: ModulesSettingsView()
        case .settingsChoresRewards: ChoresRewardsSettingsView()
        case .settingsCalendars: CalendarsSettingsView()
        case .settingsAI: AISettingsView()
        case .settingsMeals: MealsSettingsView()
        case .settingsDisplay: DisplayKioskSettingsView()
        case .settingsNotifications: NotificationsSettingsView()
        case .settingsAbout: AboutSettingsView()
        case .reviewEvents: ReviewEventsView(path: $path)
        case .approvals: ApprovalsView()
        }
    }
}

/// A consistent "screen coming soon" destination that still surfaces the tile's
/// real summary line, so the hub never navigates into a dead end.
struct HubPlaceholder: View {
    let emoji: String
    let title: String
    let summary: String

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Text(emoji)
                    .font(.system(size: 52))
                    .frame(width: 96, height: 96)
                    .background(NK.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .padding(.top, 28)
                Text(summary)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(NK.ink2)
                    .multilineTextAlignment(.center)
                Text("This screen is coming soon.")
                    .font(.system(size: 13))
                    .foregroundStyle(NK.ink3)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
