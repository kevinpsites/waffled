import SwiftUI

/// The iPad app root — the full, interactive, web-like experience.
///
/// Hosts `KioskShell` (the nav rail + every page). `KioskDashboard` is the shell's
/// Today page. A family-display / screensaver overlay may layer over this later
/// (Phase 5, low priority). The data layer (`SyncManager`) is shared with the iPhone
/// planner — see `apps/ios/IPAD_ROADMAP.md`.
struct KioskRoot: View {
    var body: some View {
        KioskShell()
    }
}

#Preview {
    KioskRoot()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
