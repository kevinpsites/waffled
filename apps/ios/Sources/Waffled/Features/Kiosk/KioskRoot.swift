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
    @Environment(Session.self) private var session
    /// Flips true if we're still on the boot cover after a grace period — turns the
    /// branded "loading" nest into an escapable error state. Without this, a session
    /// that can't authenticate (stale/revoked token) leaves the iPad stuck on the cover
    /// forever with no way back to login.
    @State private var bootStalled = false

    var body: some View {
        KioskShell()
            .kioskScreensaver()
            // A branded loading cover for the cold-start window, so the wall display
            // shows the nest (not empty "Loading…" cards) while PowerSync first connects.
            // Lifts as soon as the sync connects or falls back to offline; if it can't
            // connect within the grace period, it offers Retry / Sign out instead.
            .overlay {
                if booting {
                    KioskBootCover(
                        stalled: bootStalled,
                        detail: sync.lastError,
                        onRetry: { bootStalled = false; Task { await sync.start() } },
                        onSignOut: { Task { await session.signOut() } }
                    )
                    .transition(.opacity)
                }
            }
            // App-wide server-update nudge (admin-only), matching the iPhone + web apps.
            .overlay { ServerUpdateModal() }
            .animation(.easeInOut(duration: 0.4), value: booting)
            .animation(.easeInOut(duration: 0.3), value: bootStalled)
            // Re-armed whenever `booting` toggles: if we're still booting after the grace
            // period, surface the escape. Cancelled (and reset) the moment sync lands.
            .task(id: booting) {
                guard booting else { bootStalled = false; return }
                try? await Task.sleep(for: .seconds(8))
                if !Task.isCancelled, booting { bootStalled = true }
            }
    }

    private var booting: Bool {
        sync.members.isEmpty && (sync.status == .idle || sync.status == .connecting)
    }
}

/// The cold-start cover for the iPad family hub — the nest with a gentle breathing
/// pulse while the first sync lands. (Debug builds also pay an un-optimized launch
/// cost before this even appears; a release build starts noticeably faster.)
///
/// After the grace period (`stalled`) it becomes an escape hatch: a plain-language
/// "couldn't connect" message plus Retry and Sign out, so a device whose token can't
/// authenticate is never trapped here.
struct KioskBootCover: View {
    var stalled: Bool = false
    var detail: String? = nil
    var onRetry: (() -> Void)? = nil
    var onSignOut: (() -> Void)? = nil

    @State private var pulse = false

    var body: some View {
        ZStack {
            WF.canvas.ignoresSafeArea()
            if stalled { stalledBody } else { loadingBody }
        }
        .onAppear { pulse = true }
    }

    private var loadingBody: some View {
        VStack(spacing: 18) {
            Image("WaffledMark").resizable().scaledToFit()
                .frame(width: 116, height: 116)
                .scaleEffect(pulse ? 1.08 : 0.94)
                .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: pulse)
            Text("Setting up your family hub…")
                .font(.system(size: 17, weight: .semibold)).foregroundStyle(WF.ink3)
        }
    }

    private var stalledBody: some View {
        VStack(spacing: 16) {
            Image("WaffledMark").resizable().scaledToFit()
                .frame(width: 96, height: 96)
                .opacity(0.7)
            Text("Couldn’t reach your hub")
                .font(.system(size: 20, weight: .bold)).foregroundStyle(WF.ink)
            Text("Still connecting to sync. Check this device’s Server address and your network — or sign out and back in.")
                .font(.system(size: 14)).foregroundStyle(WF.ink3)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 420)
            if let detail, !detail.isEmpty {
                Text(detail).font(.system(size: 11, design: .monospaced)).foregroundStyle(WF.ink3.opacity(0.7))
                    .multilineTextAlignment(.center).lineLimit(3).frame(maxWidth: 420)
            }
            HStack(spacing: 12) {
                Button { onRetry?() } label: {
                    Text("Retry").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                        .padding(.horizontal, 22).padding(.vertical, 12)
                        .background(WF.card).clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                }
                .buttonStyle(.plain)
                Button { onSignOut?() } label: {
                    Text("Sign out").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 22).padding(.vertical, 12)
                        .background(WF.primary).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 4)
        }
        .padding(28)
    }
}

#Preview("loading") {
    KioskBootCover()
        .previewInterfaceOrientation(.landscapeLeft)
}

#Preview("stalled") {
    KioskBootCover(stalled: true, detail: "PSYNC_S2101: token signature failed")
        .previewInterfaceOrientation(.landscapeLeft)
}
