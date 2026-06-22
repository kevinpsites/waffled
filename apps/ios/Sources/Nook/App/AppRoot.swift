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
                case .family:   FamilyView(path: $familyPath)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // App-wide offline / pending-sync strip, pushed below the status bar.
            .safeAreaInset(edge: .top, spacing: 0) { OfflineBanner() }

            NookTabBar(tab: $tab, onCapture: { showCapture = true },
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
        }
        .onChange(of: sync.events) { _, _ in Task { await reconcileReminders() } }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await notifications.refreshAuthorization(); await reconcileReminders() }
        }
        // A tapped reminder deep-links to its event on the Calendar tab.
        .onChange(of: notifications.pendingEventId) { _, id in
            guard let id else { return }
            tab = .calendar
            calendarOpenEventId = id
            notifications.pendingEventId = nil
        }
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
    var onCapture: () -> Void
    var onReselect: (Tab) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            item(.today, "house.fill", "Today")
            item(.calendar, "calendar", "Calendar")
            captureButton
            item(.meals, "fork.knife", "Meals")
            item(.family, "checklist", "Family")
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .background(
            NK.card
                .overlay(NK.hair.frame(height: 1), alignment: .top)
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private func item(_ t: Tab, _ icon: String, _ label: String) -> some View {
        let on = tab == t
        return Button {
            if tab == t { onReselect(t) } else { tab = t }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 20))
                Text(label).font(.system(size: 10.5, weight: .semibold))
            }
            .foregroundStyle(on ? NK.primary : NK.ink3)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
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
