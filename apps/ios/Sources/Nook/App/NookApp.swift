import SwiftUI

/// Nook — the capture-companion phone app. Entry point.
///
/// Phase 0 is a static, mock-faithful shell (no data layer yet). Phase 1 adds the
/// PowerSync-backed model into the environment here.
@main
struct NookApp: App {
    @State private var sync = SyncManager()

    var body: some Scene {
        WindowGroup {
            AppRoot()
                .environment(sync)
                .tint(NK.primary)
                .preferredColorScheme(.light)   // warm-white canvas is a light theme
                .task { await sync.start() }     // connect PowerSync + start watching
        }
    }
}
