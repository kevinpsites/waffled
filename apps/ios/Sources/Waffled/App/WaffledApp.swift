import SwiftUI

/// Waffled — the capture-companion phone app. Entry point.
///
/// Phase 0 is a static, mock-faithful shell (no data layer yet). Phase 1 adds the
/// PowerSync-backed model into the environment here.
@main
struct WaffledApp: App {
    @State private var sync = SyncManager()
    @State private var session = Session()
    @State private var notifications = NotificationManager()
    @State private var kiosk = KioskMode()
    /// The light/dark/system choice, persisted. Drives `.preferredColorScheme` below.
    @State private var theme = ThemeStore()
    /// The active Cook Mode session, hoisted app-level so Cook Mode + its running timers
    /// survive the app backgrounding (and a tapped timer notification can re-open it).
    @State private var cook = CookSessionStore()
    /// Cold-launch splash (bouncing logo on cream). Shown once per launch, then faded.
    @State private var showSplash = true

    var body: some Scene {
        WindowGroup {
            ZStack {
                // KioskGate wraps the auth gate: a shared-kiosk iPad with nobody claimed in
                // shows the profile picker INSTEAD of the login screen. On iPhone (and a
                // single-login iPad) it's a transparent passthrough.
                KioskGate {
                    AuthGate {
                        RootView()
                            .task { await sync.start() }   // connect PowerSync once signed in
                    }
                }
                if showSplash {
                    SplashView()
                        .transition(.opacity)
                        .zIndex(1)
                        // Guarantee the bounce is seen even if bootstrap is instant, then fade.
                        .task {
                            try? await Task.sleep(for: .seconds(1.35))
                            withAnimation(.easeOut(duration: 0.45)) { showSplash = false }
                        }
                }
            }
            .environment(sync)
            .environment(session)
            .environment(notifications)
            .environment(kiosk)
            .environment(cook)
            .environment(theme)
            .tint(WF.primary)
            .preferredColorScheme(theme.colorScheme)   // light / dark / follow-device (Settings → Appearance)
            .task { await session.bootstrap() }    // read the Keychain / probe auth status
        }
    }
}

/// Gates a shared-kiosk iPad to its profile picker. When this device is paired as a
/// family kiosk and no profile is currently claimed, the picker takes over the whole
/// window (the per-person session, and thus login, doesn't exist yet). Otherwise it
/// renders its content unchanged — so iPhone and single-login iPads are untouched.
struct KioskGate<Content: View>: View {
    @Environment(KioskMode.self) private var kiosk
    @ViewBuilder var content: () -> Content

    var body: some View {
        if kiosk.needsPicker {
            KioskProfilePickerView()
        } else {
            content()
        }
    }
}

/// Picks the per-device experience once we're past the auth gate: the iPhone
/// *planner* (`AppRoot`) or the iPad family *display* (`KioskRoot`). The split is by
/// device idiom — see `DeviceExperience` and `apps/ios/IPAD_ROADMAP.md`.
struct RootView: View {
    @Environment(NotificationManager.self) private var notifications
    @Environment(CookSessionStore.self) private var cook

    var body: some View {
        Group {
            switch DeviceExperience.current {
            case .planner: AppRoot()
            case .kiosk:   KioskRoot()
            }
        }
        // Cook Mode is presented HERE, at the app root — above both the phone planner
        // and the iPad kiosk shell — so it (and its running timers) survives the app
        // backgrounding. The inner navigation may reset to Today on return; this cover
        // stays put because it's driven by the durable `CookSessionStore`, not transient
        // view `@State`. Closing it (✕/Finish) clears the store.
        .fullScreenCover(isPresented: cookPresented) { CookModeView() }
        // After a Cook Mode finish, offer the same "Used from your pantry" reconcile the
        // recipe screen's Mark-cooked uses — the back half of the pantry↔meal loop —
        // reusing the shared CookConfirmSheet (only when the server returned matches).
        .sheet(item: pantryReconcile) { rec in
            CookConfirmSheet(title: rec.title, matches: rec.matches)
        }
        // A tapped cook-timer notification re-opens Cook Mode at the fired step.
        .onChange(of: notifications.pendingCookTimer) { _, link in
            guard let link else { return }
            cook.openFromNotification(link)
            notifications.pendingCookTimer = nil
        }
    }

    private var cookPresented: Binding<Bool> {
        Binding(get: { cook.isActive }, set: { if !$0 { cook.end() } })
    }

    private var pantryReconcile: Binding<CookSessionStore.PantryReconcile?> {
        Binding(get: { cook.pendingPantryReconcile }, set: { cook.pendingPantryReconcile = $0 })
    }
}
