import SwiftUI

/// The iPad app root — the full, interactive, web-like experience.
///
/// Hosts `KioskShell` (the nav rail + every page). `KioskDashboard` is the shell's
/// Today page. `.kioskScreensaver()` layers the idle family-display screensaver over the
/// whole shell (photos slideshow + clock · weather · next event), honoring the Display &
/// Kiosk config. The data layer (`SyncManager`) is shared with the iPhone planner — see
/// `apps/ios/IPAD_ROADMAP.md`.
struct KioskRoot: View {
    var body: some View {
        KioskShell()
            .kioskScreensaver()
    }
}

#Preview {
    KioskRoot()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
