import SwiftUI

/// Nook — the capture-companion phone app. Entry point.
///
/// Phase 0 is a static, mock-faithful shell (no data layer yet). Phase 1 adds the
/// PowerSync-backed model into the environment here.
@main
struct NookApp: App {
    var body: some Scene {
        WindowGroup {
            AppRoot()
                .tint(NK.primary)
                .preferredColorScheme(.light)   // warm-white canvas is a light theme
        }
    }
}
