import SwiftUI

/// Nook — the capture-companion phone app. Entry point.
///
/// Phase 0 is a static, mock-faithful shell (no data layer yet). Phase 1 adds the
/// PowerSync-backed model into the environment here.
@main
struct NookApp: App {
    @State private var sync = SyncManager()
    @State private var session = Session()
    @State private var notifications = NotificationManager()

    var body: some Scene {
        WindowGroup {
            AuthGate {
                RootView()
                    .task { await sync.start() }   // connect PowerSync once signed in
            }
            .environment(sync)
            .environment(session)
            .environment(notifications)
            .tint(NK.primary)
            .preferredColorScheme(.light)          // warm-white canvas is a light theme
            .task { await session.bootstrap() }    // read the Keychain / probe auth status
        }
    }
}

/// Picks the per-device experience once we're past the auth gate: the iPhone
/// *planner* (`AppRoot`) or the iPad family *display* (`KioskRoot`). The split is by
/// device idiom — see `DeviceExperience` and `apps/ios/IPAD_ROADMAP.md`.
struct RootView: View {
    var body: some View {
        switch DeviceExperience.current {
        case .planner: AppRoot()
        case .kiosk:   KioskRoot()
        }
    }
}
