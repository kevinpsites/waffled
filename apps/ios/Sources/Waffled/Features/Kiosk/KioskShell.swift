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

    /// Whether the shell should use the portrait (bottom-bar) layout, judged from the
    /// FULL container size — safe-area insets added back — not the safe-area-inset
    /// `geo.size`. The on-screen keyboard insets the *bottom safe area*, so the bare
    /// `height > width` check collapsed by the keyboard height and a portrait iPad
    /// "became landscape" the moment a field was focused. That branch switch rebuilt
    /// the whole page (ConditionalContent), dropping focus and any half-typed text —
    /// felt as "the keyboard hides what I'm typing" on the grocery list. Adding the
    /// insets back means only a real rotation flips the layout.
    static func isPortrait(size: CGSize, safeArea: EdgeInsets) -> Bool {
        (size.height + safeArea.top + safeArea.bottom)
            > (size.width + safeArea.leading + safeArea.trailing)
    }

    var body: some View {
        // Landscape (the usual wall/counter mount) keeps the side rail; portrait — for
        // people who stand the iPad up vertically — moves the nav to a bottom bar like the
        // iPhone, with the page filling the space above it. Switches live on rotation.
        GeometryReader { geo in
            let portrait = Self.isPortrait(size: geo.size, safeArea: geo.safeAreaInsets)
            Group {
                if portrait {
                    VStack(spacing: 0) {
                        detail.frame(maxWidth: .infinity, maxHeight: .infinity)
                        bottomBar
                    }
                } else {
                    HStack(spacing: 0) {
                        rail
                        Rectangle().fill(WF.hair).frame(width: 1).ignoresSafeArea()
                        detail.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(WF.canvas)
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
        .background(WF.panel.ignoresSafeArea())
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
            .background(WF.primary)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .wfShadow1()
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
                    .overlay(Circle().strokeBorder(WF.card, lineWidth: 2))
                if kiosk.isShared {
                    Image(systemName: "arrow.left.arrow.right.circle.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(WF.primary)
                        .background(Circle().fill(WF.panel).frame(width: 17, height: 17))
                        .offset(x: 3, y: 2)
                }
            }
            Text(firstName)
                .font(.system(size: 10.5, weight: .bold)).foregroundStyle(WF.ink2).lineLimit(1)
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
            .foregroundStyle(on ? WF.primary : WF.ink3)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(on ? WF.card : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(on ? WF.hair : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: bottom bar (portrait)

    /// The same destinations as the rail, in the same order, laid out horizontally with the
    /// capture button raised in the middle — so pins stay consistent whichever way you hold it.
    private var bottomBarItems: [KioskNav] {
        [.today, .calendar] + pinnedRailItems + [.more, .settings]
    }

    /// One slot in the bottom bar — a nav destination, or the signed-in user (the rail's
    /// "who's logged in" chip, which on a shared kiosk swaps back to the profile picker).
    private enum BarEntry: Identifiable {
        case nav(KioskNav)
        case user(SyncedMember)
        var id: String { if case .nav(let n) = self { return n.rawValue }; return "__user" }
    }

    private var bottomBar: some View {
        var entries = bottomBarItems.map(BarEntry.nav)
        if let m = currentMember { entries.append(.user(m)) }   // user chip rides at the end, like the rail
        let mid = (entries.count + 1) / 2   // capture FAB sits at the center, splitting the row
        return HStack(alignment: .bottom, spacing: 0) {
            ForEach(entries[..<mid]) { barEntry($0) }
            captureBarButton
            ForEach(entries[mid...]) { barEntry($0) }
        }
        .padding(.horizontal, 6)
        .padding(.top, 8)
        .background(
            WF.card
                .overlay(WF.hair.frame(height: 1), alignment: .top)
                .ignoresSafeArea(edges: .bottom)
        )
    }

    @ViewBuilder private func barEntry(_ entry: BarEntry) -> some View {
        switch entry {
        case .nav(let item): barItem(item)
        case .user(let m): bottomUserChip(m)
        }
    }

    /// The bottom-bar twin of `currentUserChip` — a compact avatar; a tap returns to the
    /// profile picker on a shared kiosk (with the swap badge), a plain indicator otherwise.
    @ViewBuilder private func bottomUserChip(_ m: SyncedMember) -> some View {
        let firstName = m.name.split(separator: " ").first.map(String.init) ?? m.name
        let chip = VStack(spacing: 3) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 25)
                if kiosk.isShared {
                    Image(systemName: "arrow.left.arrow.right.circle.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(WF.primary)
                        .background(Circle().fill(WF.card).frame(width: 13, height: 13))
                        .offset(x: 2, y: 1)
                }
            }
            Text(firstName).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(WF.ink3).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 5)
        .contentShape(Rectangle())

        if kiosk.isShared {
            Button { Task { await kiosk.returnToPicker(sync: sync) } } label: { chip }.buttonStyle(.plain)
        } else {
            chip
        }
    }

    private func barItem(_ item: KioskNav) -> some View {
        let on = selection == item
        return Button { tapRail(item) } label: {
            VStack(spacing: 3) {
                Image(systemName: item.icon).font(.system(size: 20, weight: .semibold))
                Text(item.label).font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
            }
            .foregroundStyle(on ? WF.primary : WF.ink3)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The raised coral ✨ capture FAB — the bottom-bar twin of `captureRailButton`.
    private var captureBarButton: some View {
        Button { dictateOnOpen = false; showCapture = true } label: {
            Image(systemName: "sparkles").font(.system(size: 22, weight: .bold)).foregroundStyle(.white)
                .frame(width: 54, height: 54)
                .background(WF.primary).clipShape(Circle())
                .wfShadow1()
        }
        .buttonStyle(.plain)
        .offset(y: -16)
        .padding(.horizontal, 8)
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

#Preview(traits: .landscapeLeft) {
    KioskShell()
        .environment(SyncManager())
}
