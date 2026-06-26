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
    @State private var kiosk = KioskMode()

    var body: some Scene {
        WindowGroup {
            // KioskGate wraps the auth gate: a shared-kiosk iPad with nobody claimed in
            // shows the profile picker INSTEAD of the login screen. On iPhone (and a
            // single-login iPad) it's a transparent passthrough.
            KioskGate {
                AuthGate {
                    RootView()
                        .task { await sync.start() }   // connect PowerSync once signed in
                }
            }
            .environment(sync)
            .environment(session)
            .environment(notifications)
            .environment(kiosk)
            .tint(NK.primary)
            .preferredColorScheme(.light)          // warm-white canvas is a light theme
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
    var body: some View {
        switch DeviceExperience.current {
        case .planner: AppRoot()
        case .kiosk:   KioskRoot()
        }
    }
}
