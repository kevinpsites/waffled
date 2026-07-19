import SwiftUI

/// A slim, app-wide status strip: shown when the device is offline (so the synced
/// surfaces are trusted to be cached, not stale-and-silent) or when local writes
/// are still queued to upload. Reads SyncManager's PowerSync connection status and
/// the `ps_crud` upload-queue depth — one component, mounted once in AppRoot.
struct OfflineBanner: View {
    @Environment(SyncManager.self) private var sync
    /// "Not synced" only shows after `OfflineBannerGate.gracePeriod` of
    /// *continuous* disconnect, so reconnect blips (PowerSync retries, app
    /// foregrounding, network hand-offs) and a normal startup connect never
    /// flash the bar. Covers true device-offline and can't-reach-server alike.
    @State private var gate = OfflineBannerGate()
    /// The single pending grace-deadline re-check; replaced (after cancel) on
    /// every status change so stale sleeps can't flip the banner.
    @State private var graceTask: Task<Void, Never>?

    var body: some View {
        Group {
            if gate.isShowingBanner {
                bar(icon: "wifi.slash", bg: WF.ink2, text: sync.pendingUploads > 0
                    ? "Offline · \(changeCount) saved, will sync when you're back"
                    : "Offline · showing your saved data")
            } else if sync.pendingUploads > 0 {
                bar(icon: "arrow.triangle.2.circlepath", bg: FamilyColor.person3.solid,
                    text: "Syncing \(changeCount)…")
            }
        }
        .animation(.easeInOut(duration: 0.25), value: gate.isShowingBanner)
        .animation(.easeInOut(duration: 0.25), value: sync.pendingUploads)
        .task { evaluate(sync.status) }
        .onChange(of: sync.status) { _, s in evaluate(s) }
        .onDisappear { graceTask?.cancel() }
    }

    /// Feed the gate; connected clears immediately, disconnected arms a single
    /// cancellable sleep until the gate's grace deadline, then re-evaluates.
    /// SuspendingClock so backgrounded time never burns the grace window (a
    /// continuous clock would resume past-deadline on wake and flash the bar
    /// before PowerSync reconnects).
    private func evaluate(_ s: SyncManager.Status) {
        graceTask?.cancel()
        graceTask = nil
        let clock = SuspendingClock()
        guard let deadline = gate.connectivityChanged(
            isConnected: s == .connected, now: clock.now) else { return }
        graceTask = Task {
            try? await clock.sleep(until: deadline)
            guard !Task.isCancelled else { return }
            _ = gate.connectivityChanged(
                isConnected: sync.status == .connected, now: clock.now)
        }
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
