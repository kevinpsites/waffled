import SwiftUI

/// The iPad family-display root — the kiosk experience.
///
/// Hosts the wall-sized dashboard (Phase 2). Phase 3 will layer the screensaver /
/// idle reset / night-dim over this same root, driven by `DisplayConfig`. The data
/// layer (`SyncManager`) is shared with the iPhone planner — see
/// `apps/ios/IPAD_ROADMAP.md`.
struct KioskRoot: View {
    var body: some View {
        KioskDashboard()
    }
}

#Preview {
    KioskRoot()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
