import SwiftUI

/// The iPad family-display root — the kiosk experience.
///
/// **Phase 0 scaffold.** Right now this just confirms the universal app boots into
/// the kiosk fork on iPad (vs. the iPhone planner). It deliberately reuses the data
/// layer already in the environment (`SyncManager`) so later phases only add screens:
/// - Phase 1 — single-profile persistent login (no picker).
/// - Phase 2 — the wall-sized dashboard (agenda · meals · chores · goals), sized for
///   across-the-room reading.
/// - Phase 3 — native screensaver / idle reset / night-dim, driven by `DisplayConfig`.
///
/// See `apps/ios/IPAD_ROADMAP.md`.
struct KioskRoot: View {
    var body: some View {
        ZStack {
            NK.canvas.ignoresSafeArea()
            VStack(spacing: 14) {
                Text("Nook")
                    .font(NK.serif(72))
                    .foregroundStyle(NK.ink)
                Text("Family display")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(NK.ink2)
                Text("iPad kiosk — dashboard arrives in Phase 2")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(NK.ink3)
            }
        }
    }
}

#Preview {
    KioskRoot()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
