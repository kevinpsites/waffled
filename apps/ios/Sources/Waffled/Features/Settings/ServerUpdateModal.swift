import SwiftUI

/// App-wide "a newer Waffled server is available" modal, mirroring the web's UpdateModal.
/// Admin-only (only an admin can run the upgrade, and `/api/updates` is admin-gated). It
/// pops once per new release: dismissing (×) remembers the tag so it won't nag again until
/// an even newer version ships; "Remind me later" just closes for this launch. Mounted on
/// the app roots so it can appear over any screen. The upgrade itself runs on the host
/// (`./waffled upgrade`) — this is the nudge, the same as on web.
struct ServerUpdateModal: View {
    @Environment(\.openURL) private var openURL

    @State private var info: WaffledAPI.UpdateInfo?
    @State private var open = false
    @State private var copied = false

    private static let dismissKey = "waffled.update.dismissed"
    private static let upgradeGuideURL = "https://docs.waffled.app/operations/upgrading/"

    var body: some View {
        ZStack {
            if open, let latest = info?.latest {
                Color.black.opacity(0.45).ignoresSafeArea()
                    .transition(.opacity)
                    .onTapGesture { snooze() }
                card(latest)
                    .transition(.scale(scale: 0.94).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: open)
        // Runs once per mount — and each fresh sign-in remounts AppRoot, so it re-checks
        // after login. No need to wait on identity: /api/updates is admin-gated, so a 200
        // means we're an admin and a 403 (→ nil below) means we're not.
        .task { await check() }
    }

    // MARK: card

    private func card(_ latest: WaffledAPI.UpdateInfo.Release) -> some View {
        let display = latest.tag.hasPrefix("v") || latest.tag.hasPrefix("V")
            ? String(latest.tag.dropFirst()) : latest.tag
        return VStack(spacing: 0) {
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 12) {
                    Text("🧇").font(.system(size: 40))
                        .frame(width: 68, height: 68)
                        .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    Text("UPDATE AVAILABLE")
                        .font(.system(size: 11, weight: .heavy)).tracking(0.6).foregroundStyle(WF.primary)
                    Text("Waffled \(display) is here")
                        .font(WF.serif(24, .bold)).foregroundStyle(WF.ink)
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    Text("You’re on \(info?.current.version ?? "—")")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                .frame(maxWidth: .infinity)

                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                        .frame(width: 30, height: 30).background(WF.panel).clipShape(Circle())
                }.buttonStyle(.plain)
            }
            .padding(.top, 22).padding(.horizontal, 20)

            commandBlock.padding(.horizontal, 20).padding(.top, 18)

            HStack(spacing: 10) {
                Button { openURL(URL(string: latest.url)!) } label: {
                    Text("View changelog").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }.buttonStyle(.plain)
                Button { openURL(URL(string: Self.upgradeGuideURL)!) } label: {
                    Text("How to upgrade").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(WF.primary).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }.buttonStyle(.plain)
            }
            .padding(.horizontal, 20).padding(.top, 14)

            Button { snooze() } label: {
                Text("Remind me later").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    .padding(.vertical, 14)
            }.buttonStyle(.plain)
        }
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 30, y: 12)
        .frame(maxWidth: 420)
        .padding(24)
    }

    private var commandBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("To update, run this on the server that hosts Waffled:")
                .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Text("./waffled upgrade")
                    .font(.system(size: 14, weight: .semibold, design: .monospaced)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = "./waffled upgrade"
                    withAnimation { copied = true }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(copied ? WF.primary : WF.ink3)
                }.buttonStyle(.plain)
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
    }

    // MARK: logic

    private func check() async {
        guard !open else { return }
        // The modal mounts while the app is still booting, so the first /api/updates call
        // can fail transiently (auth/network not ready yet). Retry until it answers, then
        // decide once. Admin-gating is server-side: a 401/403 is a definitive "not you",
        // so stop; any other error is treated as transient and retried.
        for _ in 0..<8 {
            do {
                let r = try await WaffledAPI().updates()
                info = r
                let dismissed = UserDefaults.standard.string(forKey: Self.dismissKey)
                if r.enabled, r.updateAvailable == true, let tag = r.latest?.tag, dismissed != tag {
                    open = true
                }
                return
            } catch let WaffledAPI.APIError.http(code, _) where code == 401 || code == 403 {
                return
            } catch {
                try? await Task.sleep(for: .milliseconds(700))
            }
        }
    }

    /// × / next-version: remember this tag so the modal won't return until a newer one.
    private func dismiss() {
        if let tag = info?.latest?.tag { UserDefaults.standard.set(tag, forKey: Self.dismissKey) }
        open = false
    }

    /// "Remind me later": close for this launch only (reappears next cold start).
    private func snooze() { open = false }
}
