import SwiftUI

/// The iPad app root — the full, interactive, web-like experience.
///
/// Hosts `KioskShell` (the nav rail + every page). `KioskDashboard` is the shell's
/// Today page. `.kioskScreensaver()` layers the idle family-display screensaver over the
/// whole shell (photos slideshow + clock · weather · next event), honoring the Display &
/// Kiosk config. The data layer (`SyncManager`) is shared with the iPhone planner — see
/// `apps/ios/IPAD_ROADMAP.md`.
struct KioskRoot: View {
    @Environment(SyncManager.self) private var sync

    var body: some View {
        KioskShell()
            .kioskScreensaver()
            // A branded loading cover for the cold-start window, so the wall display
            // shows the nest (not empty "Loading…" cards) while PowerSync first connects.
            // Lifts as soon as the sync connects or falls back to offline.
            .overlay {
                if booting { KioskBootCover().transition(.opacity) }
            }
            .animation(.easeInOut(duration: 0.4), value: booting)
    }

    private var booting: Bool {
        sync.members.isEmpty && (sync.status == .idle || sync.status == .connecting)
    }
}

/// The cold-start cover for the iPad family hub — the nest with a gentle breathing
/// pulse while the first sync lands. (Debug builds also pay an un-optimized launch
/// cost before this even appears; a release build starts noticeably faster.)
struct KioskBootCover: View {
    @State private var pulse = false

    var body: some View {
        ZStack {
            NK.canvas.ignoresSafeArea()
            VStack(spacing: 18) {
                Text("🪺").font(.system(size: 72))
                    .scaleEffect(pulse ? 1.08 : 0.94)
                    .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: pulse)
                Text("Setting up your family hub…")
                    .font(.system(size: 17, weight: .semibold)).foregroundStyle(NK.ink3)
            }
        }
        .onAppear { pulse = true }
    }
}

#Preview {
    KioskRoot()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
