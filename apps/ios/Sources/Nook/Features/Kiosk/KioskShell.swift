import SwiftUI

/// The iPad app shell — a fixed left nav rail + a detail pane, mirroring the web
/// (`KioskLayout`'s rail + routed outlet). Every page is reachable and interactive;
/// the rail stays visible like the web's. Pages reuse the existing feature views:
/// self-contained ones (`CalendarView`, `MealsView`, `FamilyView`) render directly;
/// the hub views (`GoalsView`, `ListsIndexView`, `SettingsView`) are inner views, so
/// they get a host `NavigationStack` + the shared `HubRoute` destination. See
/// `apps/ios/IPAD_ROADMAP.md` (Phase 3).
struct KioskShell: View {
    @State private var selection: KioskNav = KioskNav(rawValue: DemoHooks.kioskPage ?? "") ?? .today

    // Shared models / per-page nav stacks for the reused feature views.
    @State private var recipes = RecipesModel()
    @State private var approvals = ApprovalsModel()
    @State private var goalsPath: [HubRoute] = []
    @State private var listsPath: [HubRoute] = []
    @State private var settingsPath: [HubRoute] = []
    @State private var familyPath: [HubRoute] = []
    @State private var mealsPath: [MealsRoute] = []
    @State private var calendarEventId: String?

    var body: some View {
        HStack(spacing: 0) {
            rail
            Rectangle().fill(NK.hair).frame(width: 1).ignoresSafeArea()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(NK.canvas)
    }

    // MARK: nav rail

    private var rail: some View {
        VStack(spacing: 6) {
            logo.padding(.top, 16).padding(.bottom, 12)
            ForEach(KioskNav.primary) { railItem($0) }
            Spacer(minLength: 8)
            railItem(.settings)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 16)
        .frame(width: 120)
        .frame(maxHeight: .infinity)
        .background(NK.panel.ignoresSafeArea())
    }

    private var logo: some View {
        Text("N")
            .font(NK.serif(26)).foregroundStyle(.white)
            .frame(width: 46, height: 46)
            .background(NK.ink)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private func railItem(_ item: KioskNav) -> some View {
        let on = selection == item
        return Button { selection = item } label: {
            VStack(spacing: 5) {
                Image(systemName: item.icon).font(.system(size: 21, weight: .semibold))
                Text(item.label).font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(on ? NK.primary : NK.ink3)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(on ? NK.card : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(on ? NK.hair : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: detail pages

    @ViewBuilder private var detail: some View {
        switch selection {
        case .today:
            KioskDashboard(navigate: { selection = $0 })
        case .calendar:
            CalendarView(openEventId: $calendarEventId)
        case .tasks:
            NavigationStack { ChoresView() }
        case .goals:
            NavigationStack(path: $goalsPath) {
                GoalsView(path: $goalsPath).hubDestination($goalsPath, recipes)
            }
        case .family:
            FamilyView(path: $familyPath, approvals: approvals)
        case .meals:
            MealsView(path: $mealsPath)
        case .lists:
            NavigationStack(path: $listsPath) {
                ListsIndexView(path: $listsPath).hubDestination($listsPath, recipes)
            }
        case .photos:
            NavigationStack {
                HubPlaceholder(emoji: "📷", title: "Photos", summary: "Family photos")
            }
        case .settings:
            NavigationStack(path: $settingsPath) {
                SettingsView(path: $settingsPath).hubDestination($settingsPath, recipes)
            }
        }
    }
}

/// The rail items, in web order (`apps/web/src/kiosk/nav.ts`). Settings is pinned to
/// the bottom of the rail, so it's separated out from `primary`.
enum KioskNav: String, CaseIterable, Identifiable {
    case today, calendar, tasks, goals, family, meals, lists, photos, settings
    var id: String { rawValue }

    /// Everything above the bottom-pinned Settings.
    static let primary: [KioskNav] = [.today, .calendar, .tasks, .goals, .family, .meals, .lists, .photos]

    var label: String {
        switch self {
        case .today: return "Today"
        case .calendar: return "Calendar"
        case .tasks: return "Chores"
        case .goals: return "Goals"
        case .family: return "Family"
        case .meals: return "Meals"
        case .lists: return "Lists"
        case .photos: return "Photos"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .today: return "house.fill"
        case .calendar: return "calendar"
        case .tasks: return "checklist"
        case .goals: return "target"
        case .family: return "person.2.fill"
        case .meals: return "fork.knife"
        case .lists: return "list.bullet"
        case .photos: return "photo"
        case .settings: return "gearshape.fill"
        }
    }
}

private extension View {
    /// Hosts the shared `HubRoute` destination for the inner hub views (Goals, Lists,
    /// Settings) so their pushes resolve when shown standalone in the rail's detail.
    func hubDestination(_ path: Binding<[HubRoute]>, _ recipes: RecipesModel) -> some View {
        navigationDestination(for: HubRoute.self) { route in
            HubDestination(route: route, path: path, recipes: recipes)
        }
    }
}

#Preview {
    KioskShell()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
