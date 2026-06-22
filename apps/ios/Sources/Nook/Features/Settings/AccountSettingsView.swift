import SwiftUI
import UIKit

/// Accounts panel: who this device is signed in as, the household it's joined to, and
/// (for admins) kiosk device pairing — mirrors the web's Sign-in & security. Sign out
/// lives on the Settings landing.
struct AccountSettingsView: View {
    @State private var settings: NookAPI.HouseholdSettings?
    @State private var currentId: String?
    @State private var devices: [NookAPI.KioskDevice] = []
    @State private var showPair = false
    @State private var confirmRevoke: String?

    private let api = NookAPI()

    private var me: NookAPI.HouseholdSettings.Member? {
        guard let currentId else { return nil }
        return settings?.members.first { $0.id == currentId }
    }
    private var isAdmin: Bool { me?.isAdmin ?? false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                identityCard
                householdCard
                if isAdmin { kioskSection }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Accounts").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(isPresented: $showPair) {
            PairKioskSheet { await loadDevices() }
        }
    }

    private var identityCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Signed in as")
                HStack(spacing: 12) {
                    Avatar(colorHex: me?.colorHex, emoji: me?.avatarEmoji ?? "🙂", size: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(me?.name ?? "—").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                        HStack(spacing: 6) {
                            if me?.isOwner == true { tag("Owner", NK.gold) }
                            else if me?.isAdmin == true { tag("Admin", NK.primary) }
                            tag(me?.memberType.capitalized ?? "Member", NK.ink3)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private var householdCard: some View {
        NookCard {
            HStack(spacing: 12) {
                Text("🏡").font(.system(size: 22)).frame(width: 40, height: 40)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(settings?.household.name ?? "Household").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    Text(settings?.household.timezone ?? "").font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: kiosk devices

    private var kioskSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Kiosk devices").padding(.top, 6)
            Text("Pair a shared tablet to this household so it shows a profile picker instead of a single login.")
                .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(devices) { d in deviceRow(d) }

            Button { showPair = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                    Text("Pair a new device").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(NK.ink2).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(NK.card2)
                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(NK.hair))
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).padding(.top, 2)
        }
    }

    private func deviceRow(_ d: NookAPI.KioskDevice) -> some View {
        HStack(spacing: 12) {
            Text("🖥️").font(.system(size: 20)).frame(width: 40, height: 40)
                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(d.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                Text(lastSeen(d.lastSeenAt)).font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
            Spacer(minLength: 0)
            Button {
                if confirmRevoke == d.id { Task { await revoke(d.id) } } else { confirmRevoke = d.id }
            } label: {
                Text(confirmRevoke == d.id ? "Tap again" : "Unpair")
                    .font(.system(size: 12.5, weight: .bold))
                    .foregroundStyle(confirmRevoke == d.id ? NK.primary : NK.ink3)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(NK.panel).clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(12).background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func lastSeen(_ iso: String?) -> String {
        guard let iso, let d = EventTime.parse(iso) else { return "Never connected" }
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .short
        return "Last seen \(f.localizedString(for: d, relativeTo: Date()))"
    }

    private func tag(_ t: String, _ color: Color) -> some View {
        Text(t).font(.system(size: 11, weight: .bold)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 2).background(color.opacity(0.12)).clipShape(Capsule())
    }

    private func load() async {
        async let s = try? await api.householdSettings()
        async let id = try? await api.currentPersonId()
        settings = await s
        currentId = await id ?? nil
        if isAdmin { await loadDevices() }
    }

    private func loadDevices() async {
        devices = (try? await api.kioskDevices()) ?? []
    }

    private func revoke(_ id: String) async {
        confirmRevoke = nil
        try? await api.revokeKioskDevice(id: id)
        await loadDevices()
    }
}

/// Generates a one-time pairing code and waits for a tablet to claim it. Mirrors the
/// web's pairing card: show the code, copy it, and poll until a new device appears.
struct PairKioskSheet: View {
    let onPaired: () async -> Void

    @Environment(\.dismiss) private var dismiss
    private let api = NookAPI()

    @State private var code: NookAPI.PairingCode?
    @State private var error: String?
    @State private var pairedLabel: String?
    @State private var copied = false
    @State private var knownIds: Set<String> = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if let pairedLabel {
                        success(pairedLabel)
                    } else if let code {
                        codeCard(code)
                    } else if let error {
                        Text(error).font(.system(size: 14, weight: .medium)).foregroundStyle(NK.primary).padding(.top, 40)
                    } else {
                        ProgressView().tint(NK.ink3).padding(.top, 48)
                    }
                }
                .padding(24)
            }
            .background(NK.canvas)
            .navigationTitle("Pair a kiosk").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(pairedLabel == nil ? "Cancel" : "Done") { dismiss() } }
            }
        }
        .task { await run() }
    }

    private func codeCard(_ c: NookAPI.PairingCode) -> some View {
        VStack(spacing: 16) {
            Text("Enter this code on the new tablet")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink2)
                .multilineTextAlignment(.center)
            Text(c.code)
                .font(.system(size: 44, weight: .heavy, design: .monospaced))
                .tracking(6).foregroundStyle(NK.ink)
                .padding(.vertical, 18).frame(maxWidth: .infinity)
                .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
            Button {
                UIPasteboard.general.string = c.code; copied = true
            } label: {
                Text(copied ? "Copied ✓" : "Copy code").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.primary)
            }
            .buttonStyle(.plain)
            Text("On the tablet: open this Nook’s address → “Set up this device as a kiosk” → enter the code. It’s one-time and expires in about 10 minutes.")
                .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 7) {
                ProgressView().controlSize(.small).tint(NK.ink3)
                Text("Waiting for a device to pair…").font(.system(size: 12.5, weight: .medium)).foregroundStyle(NK.ink3)
            }
            .padding(.top, 4)
        }
    }

    private func success(_ label: String) -> some View {
        VStack(spacing: 12) {
            Text("✅").font(.system(size: 48))
            Text("“\(label)” is paired").font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink)
            Text("The tablet can now show your family’s profile picker.")
                .font(.system(size: 13)).foregroundStyle(NK.ink3).multilineTextAlignment(.center)
        }
        .padding(.top, 40)
    }

    /// Create the code, then poll for the new device that claims it.
    private func run() async {
        knownIds = Set(((try? await api.kioskDevices()) ?? []).map(\.id))
        do { code = try await api.createPairingCode(label: nil) }
        catch { self.error = "Couldn’t create a pairing code. Admins only."; return }
        while pairedLabel == nil && !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            if let fresh = try? await api.kioskDevices(),
               let paired = fresh.first(where: { !knownIds.contains($0.id) }) {
                pairedLabel = paired.label
                await onPaired()
            }
        }
    }
}
