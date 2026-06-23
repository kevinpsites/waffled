import SwiftUI

/// The five surfaces of the phone app, mirroring the handoff tab bar:
/// Today · Calendar · (✨ capture) · Meals · Family.
enum Tab: Hashable {
    case today, calendar, meals, family
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
    /// Household-wide pending approvals, driving the app-icon + Family-tab badge so a
    /// parent sees there's something to OK without opening the app.
    @State private var approvals = ApprovalsModel()

    /// Only adults owe approvals (and only they should see the badge).
    private var approvalCount: Int { sync.isParent ? approvals.total : 0 }

    private static var initialTab: Tab {
        switch DemoHooks.startTab {
        case "calendar": return .calendar
        case "meals": return .meals
        case "family": return .family
        default: return .today
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            NK.canvas.ignoresSafeArea()

            // Active screen. Each tab keeps its own NavigationStack later; for the
            // scaffold they're simple views.
            Group {
                switch tab {
                case .today:    TodayView(path: $todayPath, openCalendar: { tab = .calendar })
                case .calendar: CalendarView(openEventId: $calendarOpenEventId)
                case .meals:    MealsView(path: $mealsPath)
                case .family:   FamilyView(path: $familyPath, approvals: approvals)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // App-wide offline / pending-sync strip, pushed below the status bar.
            .safeAreaInset(edge: .top, spacing: 0) { OfflineBanner() }

            NookTabBar(tab: $tab, familyBadge: approvalCount,
                       onCapture: { showCapture = true },
                       onReselect: {
                           if $0 == .family { familyPath = [] }
                           if $0 == .meals { mealsPath = [] }
                           if $0 == .today { todayPath = [] }
                       })
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet()
                .presentationDragIndicator(.visible)
        }
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
struct NookTabBar: View {
    @Binding var tab: Tab
    var familyBadge: Int = 0
    var onCapture: () -> Void
    var onReselect: (Tab) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            item(.today, "house.fill", "Today")
            item(.calendar, "calendar", "Calendar")
            captureButton
            item(.meals, "fork.knife", "Meals")
            item(.family, "checklist", "Family", badge: familyBadge)
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .background(
            NK.card
                .overlay(NK.hair.frame(height: 1), alignment: .top)
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
            .foregroundStyle(on ? NK.primary : NK.ink3)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    /// A small count pill (max "9+") on a tab icon — the in-app twin of the app badge.
    private func badgeCount(_ n: Int) -> some View {
        Text(n > 9 ? "9+" : "\(n)")
            .font(.system(size: 11, weight: .heavy)).foregroundStyle(.white)
            .padding(.horizontal, n > 9 ? 4 : 5).padding(.vertical, 1.5)
            .background(Capsule().fill(NK.gold))
            .overlay(Capsule().stroke(NK.card, lineWidth: 1.5))
            .fixedSize()
    }

    private var captureButton: some View {
        Button(action: onCapture) {
            ZStack {
                Circle().fill(NK.primary)
                Image(systemName: "sparkles")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 54, height: 54)
            .nkShadow3()
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .offset(y: -18)
    }
}

#Preview {
    AppRoot().tint(NK.primary).environment(SyncManager())
}
