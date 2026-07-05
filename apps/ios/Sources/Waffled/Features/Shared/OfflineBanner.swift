import SwiftUI

/// A slim, app-wide status strip: shown when the device is offline (so the synced
/// surfaces are trusted to be cached, not stale-and-silent) or when local writes
/// are still queued to upload. Reads SyncManager's PowerSync connection status and
/// the `ps_crud` upload-queue depth — one component, mounted once in AppRoot.
struct OfflineBanner: View {
    @Environment(SyncManager.self) private var sync
    /// "Not synced" debounced ~2s, so a normal startup connect doesn't flash the
    /// bar. Covers both true device-offline and can't-reach-server (retry) states.
    @State private var degraded = false

    var body: some View {
        Group {
            if degraded {
                bar(icon: "wifi.slash", bg: WF.ink2, text: sync.pendingUploads > 0
                    ? "Offline · \(changeCount) saved, will sync when you're back"
                    : "Offline · showing your saved data")
            } else if sync.pendingUploads > 0 {
                bar(icon: "arrow.triangle.2.circlepath", bg: FamilyColor.wally.solid,
                    text: "Syncing \(changeCount)…")
            }
        }
        .animation(.easeInOut(duration: 0.25), value: degraded)
        .animation(.easeInOut(duration: 0.25), value: sync.pendingUploads)
        .task { await evaluate(sync.status) }
        .onChange(of: sync.status) { _, s in Task { await evaluate(s) } }
    }

    /// Connected → clear immediately; otherwise wait out the grace period and, if
    /// still not connected, show the bar.
    private func evaluate(_ s: SyncManager.Status) async {
        if s == .connected { degraded = false; return }
        try? await Task.sleep(for: .seconds(2))
        if sync.status != .connected { degraded = true }
    }

    private var changeCount: String {
        "\(sync.pendingUploads) change\(sync.pendingUploads == 1 ? "" : "s")"
    }

    private func bar(icon: String, bg: Color, text: String) -> some View {
        HStack(spacing: 7) {
            Image(systemName: icon).font(.system(size: 12, weight: .bold))
            Text(text).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16).padding(.vertical, 7)
        .frame(maxWidth: .infinity)
        .background(bg)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}
