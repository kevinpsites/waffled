import SwiftUI

/// Nook — the capture-companion phone app. Entry point.
///
/// Phase 0 is a static, mock-faithful shell (no data layer yet). Phase 1 adds the
/// PowerSync-backed model into the environment here.
@main
struct NookApp: App {
    @State private var sync = SyncManager()
    @State private var session = Session()

    var body: some Scene {
        WindowGroup {
            AuthGate {
                AppRoot()
                    .task { await sync.start() }   // connect PowerSync once signed in
            }
            .environment(sync)
            .environment(session)
            .tint(NK.primary)
            .preferredColorScheme(.light)          // warm-white canvas is a light theme
            .task { await session.bootstrap() }    // read the Keychain / probe auth status
        }
    }
}
