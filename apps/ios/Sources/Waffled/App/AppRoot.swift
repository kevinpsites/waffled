import SwiftUI

/// The five surfaces of the phone app: Today · Calendar · (✨ capture) · [flex] · Family.
enum Tab: Hashable {
    case today, calendar, flex, family
}

/// The 4th slot is a FLEX MODULE SLOT: Meals when on, else the first enabled of Goals →
/// Chores → Lists → Pantry. Five slots is what keeps the raised ✨ button centered.
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

/// Root navigation: the current screen, plus a custom bottom bar with the capture FAB.
struct AppRoot: View {
    @Environment(SyncManager.self) private var sync
    @Environment(NotificationManager.self) private var notifications
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: Tab = AppRoot.initialTab
    @State private var showCapture = false
    /// Set when a reminder is tapped — routes the Calendar tab to open that event.
    @State private var calendarOpenEventId: String?
    @State private var familyPath: [HubRoute] = []
    @State private var mealsPath: [MealsRoute] = []
    /// The Today tab's nav stack, lifted so re-tapping Today pops back to the dashboard.
    @State private var todayPath: [HubRoute] = []
    /// The flex slot's own nav stack + recipes model, used when the 4th tab backfills.
    @State private var modulePath: [HubRoute] = []
    @State private var recipes = RecipesModel()
    /// Household-wide pending approvals, driving the app-icon and Family-tab badge.
    @State private var approvals = ApprovalsModel()

    /// Only those who can approve owe approvals, and the badge counts what they can action.
    private var approvalCount: Int {
        // No chores module ⇒ nothing to approve; keep the badge reactively at 0.
        guard sync.module(.chores) else { return 0 }
        return (sync.can("chore.approve") ? approvals.chores.count : 0)
            + (sync.rewardsOn && sync.can("reward.approve") ? approvals.redemptions.count : 0)
    }

    /// Meals if on, else the first enabled backfill, else nil — only with all five off.
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

                // Active screen; each tab keeps its own NavigationStack.
            Group {
                switch tab {
                case .today:    TodayView(approvals: approvals, path: $todayPath, openCalendar: { tab = .calendar })
                case .calendar: CalendarView(openEventId: $calendarOpenEventId)
                case .flex:
                        // The 4th slot follows the modules; with every candidate off there is
                        // nothing to show, so self-correct back to Today.
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

            // Gone while a keyboard is docked — see KeyboardState.hidesBottomBar: the bar and
            // its FAB are unreachable during typing and cost 64pt.
            if !KeyboardState.shared.hidesBottomBar {
                WaffledTabBar(tab: $tab, familyBadge: approvalCount,
                       flexSlot: flexSlot,
                       onCapture: { showCapture = true },
                       onReselect: {
                           if $0 == .family { familyPath = [] }
                           if $0 == .flex { mealsPath = []; modulePath = [] }
                           if $0 == .today { todayPath = [] }
                       })
            }
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet()
                .presentationDragIndicator(.visible)
        }
        // App-wide "a newer Waffled server is available" nudge (admin-only), like web.
        .overlay { ServerUpdateModal() }
        .onAppear {
            if DemoHooks.openCapture { showCapture = true }
            // Headless pantry verification: land on the Family hub already pushed into Pantry.
            if DemoHooks.pantryItem != nil { tab = .family; familyPath = [.pantry] }
            // The same, for any hub screen: land on the Family tab already pushed into it.
            if let route = DemoHooks.hubRoute { tab = .family; familyPath = [route] }
        }
        // Local event reminders: keep the schedule in step with the synced events, the person,
        // and permission changes.
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
        .onChange(of: sync.modulesRev) { _, _ in Task { await refreshApprovalBadge() } }
        .onChange(of: sync.currentPersonId) { _, _ in Task { await refreshApprovalBadge() } }
        // A tapped reminder deep-links to its event on the Calendar tab.
        .onChange(of: notifications.pendingEventId) { _, id in
            guard let id else { return }
            tab = .calendar
            calendarOpenEventId = id
            notifications.pendingEventId = nil
        }
    }

    /// Reload pending approvals and push the count to the app-icon badge; kids resolve to 0.
    private func refreshApprovalBadge() async {
        await approvals.load(
            scope: sync.restDataScopeKey,
            choresEnabled: sync.module(.chores),
            rewardsEnabled: sync.rewardsOn
        )
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

/// Custom bottom bar — stock `TabView` can't do the raised center FAB, so we draw our own.
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
                // Shared with WF.tabBarHeight, so a screen's clearance and the bar's height are
                // the same arithmetic rather than two numbers that agree by luck.
        .padding(.top, WF.barTopPadding)
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
                    // The tallest child in the bar — see WF.captureButtonSize. The offset lifts
                    // it visually but not in layout.
            .frame(width: WF.captureButtonSize, height: WF.captureButtonSize)
            .wfShadow3()
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .offset(y: -18)
    }
}

/// Hosts the flex tab's backfill module in its own stack, reusing `HubDestination` routing.
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
