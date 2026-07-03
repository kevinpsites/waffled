import SwiftUI

/// The iPad app shell — a fixed left nav rail + a detail pane, mirroring the web
/// (`KioskLayout`'s rail + routed outlet). Every page is reachable and interactive;
/// the rail stays visible like the web's. Pages reuse the existing feature views:
/// self-contained ones (`CalendarView`, `MealsView`, `FamilyView`) render directly;
/// the hub views (`GoalsView`, `ListsIndexView`, `SettingsView`) are inner views, so
/// they get a host `NavigationStack` + the shared `HubRoute` destination. See
/// `apps/ios/IPAD_ROADMAP.md` (Phase 3).
struct KioskShell: View {
    @Environment(SyncManager.self) private var sync
    @Environment(KioskMode.self) private var kiosk
    @State private var selection: KioskNav = KioskNav(rawValue: DemoHooks.kioskPage ?? "") ?? .today

    /// Per-device list of user-pinned rail destinations (comma-joined `KioskNav`
    /// rawValues) — see `KioskRail`. Editing it in Display & Kiosk re-renders the rail
    /// and the More grid live via `@AppStorage`'s own invalidation.
    @AppStorage(KioskRail.storageKey) private var railItemsRaw = KioskRail.defaultRaw

    // Shared models / per-page nav stacks for the reused feature views.
    @State private var recipes = RecipesModel()
    @State private var goalsPath: [HubRoute] = []
    @State private var rewardsPath: [HubRoute] = []
    @State private var settingsPath: [HubRoute] = []
    @State private var familyPath: [HubRoute] = []
    @State private var mealsPath: [MealsRoute] = []

    // Global AI capture — reachable from every page via the rail (the iPad twin of the
    // phone's always-present capture FAB). Today also has its own inline "Add anything"
    // bar; both open this same sheet.
    @State private var showCapture = false
    @State private var dictateOnOpen = false

    /// Bumped to pop a self-contained tab (Today/Calendar/Chores/Lists/Photos) back to its
    /// root when its rail item is re-tapped — the bound-path tabs clear their path instead.
    @State private var navReset = 0

    /// The signed-in person — drives the rail's "who's logged in" avatar.
    private var currentMember: SyncedMember? {
        sync.members.first { $0.id == sync.currentPersonId }
    }

    var body: some View {
        HStack(spacing: 0) {
            rail
            Rectangle().fill(NK.hair).frame(width: 1).ignoresSafeArea()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(NK.canvas)
        .task { await sync.loadIdentity(); correctSelection() }
        .onChange(of: sync.modulesRev) { _, _ in correctSelection() }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
    }

    /// Whether a rail item's optional module is enabled (Today/Calendar/Family/Photos
    /// are core and never gated). Mirrors the web rail filter — see `KioskRail`.
    private func moduleEnabled(_ nav: KioskNav) -> Bool {
        KioskRail.moduleEnabled(nav, sync: sync)
    }

    /// The user-pinned rail destinations (between Today/Calendar and More/Settings),
    /// module-filtered — see `KioskRail`.
    private var pinnedRailItems: [KioskNav] {
        KioskRail.pinned(raw: railItemsRaw, sync: sync)
    }

    /// If the current selection points at a now-disabled module, fall back to Today.
    private func correctSelection() {
        if !moduleEnabled(selection) { selection = .today }
    }

    // MARK: nav rail

    private var rail: some View {
        VStack(spacing: 6) {
            Color.clear.frame(height: 12)   // top breathing room (logo removed)
            // Today & Calendar are always pinned at the top, then the user's picks,
            // then the "More" hub (holds everything choosable-but-unpinned).
            railItem(.today)
            railItem(.calendar)
            ForEach(pinnedRailItems) { railItem($0) }
            railItem(.more)
            Spacer(minLength: 8)
            captureRailButton
            if let m = currentMember { currentUserChip(m) }
            railItem(.settings)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 16)
        .frame(width: 120)
        .frame(maxHeight: .infinity)
        .background(NK.panel.ignoresSafeArea())
    }

    /// The always-present AI capture entry — a coral ✨ pill pinned in the rail so
    /// "Add anything" is one tap away on every page (Today's inline bar opens the same sheet).
    private var captureRailButton: some View {
        Button { dictateOnOpen = false; showCapture = true } label: {
            VStack(spacing: 5) {
                Image(systemName: "sparkles").font(.system(size: 20, weight: .bold))
                Text("Add").font(.system(size: 11, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(NK.primary)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .nkShadow1()
        }
        .buttonStyle(.plain)
        .padding(.bottom, 4)
    }

    /// "Who's logged in" — the signed-in person's avatar at the bottom of the rail. On a
    /// shared kiosk it's a button (with a swap badge) that returns to the profile picker so
    /// the next person can tap in; on a normal single-login iPad it's just an indicator.
    @ViewBuilder
    private func currentUserChip(_ m: SyncedMember) -> some View {
        let firstName = m.name.split(separator: " ").first.map(String.init) ?? m.name
        let chip = VStack(spacing: 4) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 40)
                    .overlay(Circle().strokeBorder(NK.card, lineWidth: 2))
                if kiosk.isShared {
                    Image(systemName: "arrow.left.arrow.right.circle.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(NK.primary)
                        .background(Circle().fill(NK.panel).frame(width: 17, height: 17))
                        .offset(x: 3, y: 2)
                }
            }
            Text(firstName)
                .font(.system(size: 10.5, weight: .bold)).foregroundStyle(NK.ink2).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)

        if kiosk.isShared {
            // Tap the avatar → straight back to the picker (the swap badge signals it).
            Button { Task { await kiosk.returnToPicker(sync: sync) } } label: { chip }
                .buttonStyle(.plain)
        } else {
            chip
        }
    }

    /// Rail tap: switch tabs, or — if the tab is already active — return it to its root
    /// (pop the nav stack), so re-tapping the current tab is a quick "back to top".
    private func tapRail(_ item: KioskNav) {
        guard selection == item else { selection = item; return }
        switch item {
        case .goals:    goalsPath = []
        case .rewards:  rewardsPath = []
        case .family:   familyPath = []
        case .settings: settingsPath = []
        case .meals:    mealsPath = []
        case .today, .calendar, .tasks, .lists, .pantry, .photos, .more: navReset &+= 1
        }
    }

    private func railItem(_ item: KioskNav) -> some View {
        let on = selection == item
        return Button { tapRail(item) } label: {
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
            KioskDashboard(navigate: { selection = $0 }).id(navReset)
        case .more:
            KioskMoreView(navigate: { selection = $0 }).id(navReset)
        case .calendar:
            KioskCalendarView().id(navReset)
        case .tasks:
            NavigationStack { ChoresView() }.id(navReset)
        case .goals:
            NavigationStack(path: $goalsPath) {
                GoalsView(path: $goalsPath).hubDestination($goalsPath, recipes)
            }
        case .rewards:
            NavigationStack(path: $rewardsPath) {
                RewardsView(path: $rewardsPath).hubDestination($rewardsPath, recipes)
            }
        case .family:
            NavigationStack(path: $familyPath) {
                KioskFamilyView(path: $familyPath)
                    .hubDestination($familyPath, recipes)
            }
        case .meals:
            MealsView(path: $mealsPath)
        case .lists:
            KioskListsView(openRecipe: { recipe in
                mealsPath = [.recipe(recipe)]
                selection = .meals
            })
            .id(navReset)
        case .pantry:
            NavigationStack {
                PantryView()
            }
            .id(navReset)
        case .photos:
            NavigationStack {
                PhotosView()
            }
            .id(navReset)
        case .settings:
            NavigationStack(path: $settingsPath) {
                SettingsView(path: $settingsPath).hubDestination($settingsPath, recipes)
            }
        }
    }
}

/// The rail items, in web order (`apps/web/src/kiosk/nav.ts`). Today/Calendar are
/// always pinned at the top and More/Settings at the bottom; the middle is
/// user-customizable per device — see `KioskRail`.
enum KioskNav: String, CaseIterable, Identifiable {
    case today, calendar, tasks, rewards, goals, family, meals, lists, pantry, photos, more, settings
    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return "Today"
        case .calendar: return "Calendar"
        case .tasks: return "Chores"
        case .rewards: return "Rewards"
        case .goals: return "Goals"
        case .family: return "Family"
        case .meals: return "Meals"
        case .lists: return "Lists"
        case .pantry: return "Pantry"
        case .photos: return "Photos"
        case .more: return "More"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .today: return "house.fill"
        case .calendar: return "calendar"
        case .tasks: return "checklist"
        case .rewards: return "star.fill"
        case .goals: return "target"
        case .family: return "person.2.fill"
        case .meals: return "fork.knife"
        case .lists: return "list.bullet"
        case .pantry: return "shippingbox.fill"
        case .photos: return "photo"
        case .more: return "square.grid.2x2"
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
