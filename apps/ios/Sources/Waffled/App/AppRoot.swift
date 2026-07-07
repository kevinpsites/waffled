import SwiftUI

/// The five surfaces of the phone app, mirroring the handoff tab bar:
/// Today · Calendar · (✨ capture) · [flex module] · Family.
enum Tab: Hashable {
    case today, calendar, flex, family
}

/// The 4th bottom-bar slot is a *flex module slot*: Meals when that module is on,
/// otherwise it backfills with the first enabled of Goals → Chores → Lists → Pantry.
/// Keeping the bar at five slots means the raised ✨ capture button stays centered —
/// dropping a slot used to shove it off to one side. Icon + label follow the module.
enum FlexSlot: Hashable {
    case meals, goals, chores, lists, pantry

    var icon: String {
        switch self {
        case .meals:  return "fork.knife"
        case .goals:  return "target"
        case .chores: return "checkmark.circle.fill"
        case .lists:  return "list.bullet"
        case .pantry: return "archivebox.fill"
        }
    }
    var label: String {
        switch self {
        case .meals:  return "Meals"
        case .goals:  return "Goals"
        case .chores: return "Chores"
        case .lists:  return "Lists"
        case .pantry: return "Pantry"
        }
    }
}

/// Root navigation: the current screen filling the canvas, with a custom bottom
/// tab bar whose raised center button opens the AI capture sheet.
struct AppRoot: View {
    @Environment(SyncManager.self) private var sync
    @Environment(NotificationManager.self) private var notifications
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: Tab = AppRoot.initialTab
    @State private var showCapture = false
    /// Set when a reminder is tapped — routes the Calendar tab to open that event.
    @State private var calendarOpenEventId: String?
    /// The Family tab's nav stack, lifted here so other tabs (e.g. a Today card)
    /// can jump straight into a hub destination, and re-tapping Family pops to root.
    @State private var familyPath: [HubRoute] = []
    /// The Meals tab's nav stack, lifted here so the Today meal card can open a
    /// recipe, and re-tapping Meals pops to root.
    @State private var mealsPath: [MealsRoute] = []
    /// The Today tab's nav stack — its summary cards (tonight's meal, chores,
    /// grocery) and the greeting avatar push here (as `HubRoute`s), lifted so
    /// re-tapping Today pops back to the dashboard.
    @State private var todayPath: [HubRoute] = []
    /// The flex slot's own nav stack + a recipes model — used when the 4th tab backfills
    /// to a hub module (Goals/Chores/Lists/Pantry) because Meals is turned off.
    @State private var modulePath: [HubRoute] = []
    @State private var recipes = RecipesModel()
    /// Household-wide pending approvals, driving the app-icon + Family-tab badge so a
    /// parent sees there's something to OK without opening the app.
    @State private var approvals = ApprovalsModel()

    /// Only those who can approve owe approvals — and the badge counts just the items
    /// they can actually action (chore check-offs and/or reward purchases).
    private var approvalCount: Int {
        // No chores module ⇒ nothing to approve; keep the badge reactively at 0 even
        // before the next approvals reload lands.
        guard sync.module(.chores) else { return 0 }
        return (sync.can("chore.approve") ? approvals.chores.count : 0)
            + (sync.can("reward.approve") ? approvals.redemptions.count : 0)
    }

    /// What the 4th ("flex") tab currently is: Meals if that module is on, else the
    /// first enabled backfill module, else nil (hide the slot — only happens when
    /// Meals + Goals + Chores + Lists + Pantry are *all* off).
    private var flexSlot: FlexSlot? {
        if sync.module(.meals) { return .meals }
        if sync.module(.goals) { return .goals }
        if sync.module(.chores) { return .chores }
        if sync.module(.lists) { return .lists }
        if sync.module(.pantry) { return .pantry }
        return nil
    }

    private static var initialTab: Tab {
        switch DemoHooks.startTab {
        case "calendar": return .calendar
        case "meals": return .flex
        case "family": return .family
        default: return .today
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            WF.canvas.ignoresSafeArea()

            // Active screen. Each tab keeps its own NavigationStack later; for the
            // scaffold they're simple views.
            Group {
                switch tab {
                case .today:    TodayView(path: $todayPath, openCalendar: { tab = .calendar })
                case .calendar: CalendarView(openEventId: $calendarOpenEventId)
                case .flex:
                    // The 4th slot follows the household's modules: Meals if on, else a
                    // backfill (Goals/Chores/Lists/Pantry). If every candidate is off
                    // there's nothing to show — self-correct back to Today.
                    switch flexSlot {
                    case .meals:          MealsView(path: $mealsPath)
                    case .some(let slot): FlexModuleView(slot: slot, path: $modulePath, recipes: recipes)
                    case .none:           Color.clear.onAppear { tab = .today }
                    }
                case .family:   FamilyView(path: $familyPath, approvals: approvals)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // App-wide offline / pending-sync strip, pushed below the status bar.
            .safeAreaInset(edge: .top, spacing: 0) { OfflineBanner() }

            WaffledTabBar(tab: $tab, familyBadge: approvalCount,
                       flexSlot: flexSlot,
                       onCapture: { showCapture = true },
                       onReselect: {
                           if $0 == .family { familyPath = [] }
                           if $0 == .flex { mealsPath = []; modulePath = [] }
                           if $0 == .today { todayPath = [] }
                       })
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet()
                .presentationDragIndicator(.visible)
        }
        // App-wide "a newer Waffled server is available" nudge (admin-only), like web.
        .overlay { ServerUpdateModal() }
        .onAppear { if DemoHooks.openCapture { showCapture = true } }
        // Local event reminders (6.7-ios): keep the schedule in step with the synced
        // events, the signed-in person, and permission changes.
        .task {
            await notifications.refreshAuthorization()
            await sync.loadIdentity()
            await reconcileReminders()
            await refreshApprovalBadge()
        }
        .onChange(of: sync.events) { _, _ in Task { await reconcileReminders() } }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await notifications.refreshAuthorization(); await reconcileReminders(); await refreshApprovalBadge() }
        }
        // Re-count whenever an approval lands or sign-in changes who we are.
        .onChange(of: sync.choresRev) { _, _ in Task { await refreshApprovalBadge() } }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await refreshApprovalBadge() } }
        .onChange(of: sync.currentPersonId) { _, _ in Task { await refreshApprovalBadge() } }
        // A tapped reminder deep-links to its event on the Calendar tab.
        .onChange(of: notifications.pendingEventId) { _, id in
            guard let id else { return }
            tab = .calendar
            calendarOpenEventId = id
            notifications.pendingEventId = nil
        }
    }

    /// Reload pending approvals and push the count to the app-icon badge. Kids (and the
    /// signed-out state) resolve to 0, which clears any stale badge.
    private func refreshApprovalBadge() async {
        await approvals.load()
        await notifications.setBadge(approvalCount)
    }

    /// Rebuild the local reminder schedule from the current synced state.
    private func reconcileReminders() async {
        let names = Dictionary(sync.members.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        await notifications.reconcile(
            events: sync.events, tz: sync.householdTz,
            myPersonId: sync.currentPersonId, names: names)
    }
}

/// Custom bottom bar — stock `TabView` can't do the raised center FAB the design
/// calls for, so we draw our own and overlay the floating capture button.
struct WaffledTabBar: View {
    @Binding var tab: Tab
    var familyBadge: Int = 0
    var flexSlot: FlexSlot? = .meals
    var onCapture: () -> Void
    var onReselect: (Tab) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            item(.today, "house.fill", "Today")
            item(.calendar, "calendar", "Calendar")
            captureButton
            if let slot = flexSlot { item(.flex, slot.icon, slot.label) }
            item(.family, "checklist", "Family", badge: familyBadge)
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .background(
            WF.card
                .overlay(WF.hair.frame(height: 1), alignment: .top)
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private func item(_ t: Tab, _ icon: String, _ label: String, badge: Int = 0) -> some View {
        let on = tab == t
        return Button {
            if tab == t { onReselect(t) } else { tab = t }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 20))
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 { badgeCount(badge).offset(x: 11, y: -6) }
                    }
                Text(label).font(.system(size: 10.5, weight: .semibold))
            }
            .foregroundStyle(on ? WF.primary : WF.ink3)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    /// A small count pill (max "9+") on a tab icon — the in-app twin of the app badge.
    private func badgeCount(_ n: Int) -> some View {
        Text(n > 9 ? "9+" : "\(n)")
            .font(.system(size: 11, weight: .heavy)).foregroundStyle(.white)
            .padding(.horizontal, n > 9 ? 4 : 5).padding(.vertical, 1.5)
            .background(Capsule().fill(WF.gold))
            .overlay(Capsule().stroke(WF.card, lineWidth: 1.5))
            .fixedSize()
    }

    private var captureButton: some View {
        Button(action: onCapture) {
            ZStack {
                Circle().fill(WF.primary)
                Image(systemName: "sparkles")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 54, height: 54)
            .wfShadow3()
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .offset(y: -18)
    }
}

/// Hosts the flex tab's backfill module (Goals/Chores/Lists/Pantry) in its own
/// navigation stack, reusing the shared `HubDestination` routing so drill-ins (a goal,
/// a list, a recipe) push here and Back returns to the module root — the same wiring
/// the Family hub uses.
private struct FlexModuleView: View {
    let slot: FlexSlot
    @Binding var path: [HubRoute]
    let recipes: RecipesModel

    var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: HubRoute.self) { route in
                    HubDestination(route: route, path: $path, recipes: recipes)
                }
        }
    }

    @ViewBuilder private var root: some View {
        switch slot {
        case .goals:  GoalsView(path: $path)
        case .chores: ChoresView()
        case .lists:  ListsIndexView(path: $path)
        case .pantry: PantryView()
        case .meals:  EmptyView()   // Meals renders via MealsView on its own path
        }
    }
}

#Preview {
    AppRoot().tint(WF.primary).environment(SyncManager())
}
