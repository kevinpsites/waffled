import SwiftUI
import UIKit

/// Settings → Permissions. A home for the **device** permissions Waffled uses (Apple
/// Health, notifications, camera, mic). iOS only lets a user change these in the Settings
/// app — and never re-prompts once a choice is made — so every row just deep-links to
/// Waffled's page in Settings, where the toggles live. All local; nothing server-side.
struct PermissionsSettingsView: View {
    private var healthAvailable: Bool { HealthKitBridge.shared.isAvailable }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("These are permissions you grant **on this device**. iOS only lets you change them in the Settings app — tap **Open** on any of them to jump straight to Waffled's settings page.")
                    .font(.system(size: 13)).foregroundStyle(WF.ink2)
                    .fixedSize(horizontal: false, vertical: true)

                card {
                    if healthAvailable {
                        permRow("⌚", "Apple Health", "Auto-fill step, flight & exercise goals from your iPhone & Apple Watch.")
                        divider
                    }
                    permRow("🔔", "Notifications", "Reminders before your calendar events.")
                    divider
                    permRow("📷", "Camera", "Chore photo-proof and grocery barcode scanning.")
                    divider
                    permRow("🎤", "Microphone", "Speak an event into the capture bar.")
                }

                Text(healthAvailable
                     ? "Apple Health is iPhone-only. If you turned a metric off (or off by accident), flip it back on here — the app can't re-ask on its own."
                     : "Apple Health isn't available on this device (iPhone only).")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Permissions").navigationBarTitleDisplayMode(.inline)
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private func permRow(_ emoji: String, _ title: String, _ sub: String) -> some View {
        HStack(spacing: 12) {
            WaffledEmojiTile(emoji: emoji)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Text(sub).font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button { openSettings() } label: {
                Text("Open").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.primary)
                    .padding(.horizontal, 13).padding(.vertical, 7)
                    .background(WF.primary.opacity(0.10)).clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 14)
    }

    private var divider: some View { Rectangle().fill(WF.hair).frame(height: 1) }

    @ViewBuilder
    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(.horizontal, 18)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }
}
