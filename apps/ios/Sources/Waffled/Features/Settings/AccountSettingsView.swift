import SwiftUI
import UIKit

/// Households panel: who this device is signed in as, and the households the account
/// belongs to — switch between them, accept invites. (Kiosk-device pairing moved to
/// Display & Kiosk.) Sign out lives on the Settings landing.
struct AccountSettingsView: View {
    @Environment(Session.self) private var session
    @Environment(SyncManager.self) private var sync

    @State private var settings: WaffledAPI.HouseholdSettings?
    @State private var currentId: String?

    // Multi-household: the account's memberships + pending invites (the switcher).
    @State private var overview: WaffledAPI.HouseholdOverview?
    @State private var switchingTo: String?     // householdId mid-switch (spinner)
    @State private var acceptingId: String?     // invite id mid-accept (spinner)
    @State private var actionError: String?

    private let api = WaffledAPI()

    private var me: WaffledAPI.HouseholdSettings.Member? {
        guard let currentId else { return nil }
        return settings?.members.first { $0.id == currentId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                identityCard
                householdCard
                if let overview { householdSwitcher(overview); pendingInvitesSection(overview) }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Households").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var identityCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Signed in as")
                HStack(spacing: 12) {
                    Avatar(colorHex: me?.colorHex, emoji: me?.avatarEmoji ?? "🙂", size: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(me?.name ?? "—").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                        HStack(spacing: 6) {
                            if me?.isOwner == true { tag("Owner", WF.gold) }
                            else if me?.isAdmin == true { tag("Admin", WF.primary) }
                            tag(me?.memberType.capitalized ?? "Member", WF.ink3)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private var householdCard: some View {
        WaffledCard {
            HStack(spacing: 12) {
                Text("🏡").font(.system(size: 22)).frame(width: 40, height: 40)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(settings?.household.name ?? "Household").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    Text(settings?.household.timezone ?? "").font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: households (multi-household switcher)

    /// The account's other households, shown only when there's more than one to switch
    /// between (a single-membership account sees nothing here). Tapping a row switches
    /// the active household and re-scopes sync.
    @ViewBuilder
    private func householdSwitcher(_ o: WaffledAPI.HouseholdOverview) -> some View {
        if o.memberships.count > 1 {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Your households").padding(.top, 6)
                Text("Switch which household this device is showing. Your other households stay signed in.")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(o.memberships) { membershipRow($0, activeId: o.household?.id) }
                if let actionError {
                    Text(actionError).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func membershipRow(_ m: WaffledAPI.Membership, activeId: String?) -> some View {
        let isCurrent = m.householdId == activeId
        let busy = switchingTo == m.householdId
        return Button {
            if !isCurrent { Task { await switchTo(m) } }
        } label: {
            HStack(spacing: 12) {
                Text("🏡").font(.system(size: 20)).frame(width: 40, height: 40)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.householdName).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    Text(m.isAdmin ? "Admin" : m.memberType.capitalized)
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
                if isCurrent { tag("Current", WF.primary) }
                else if busy { ProgressView().controlSize(.small).tint(WF.ink3) }
                else { Image(systemName: "arrow.left.arrow.right").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink3) }
            }
            .padding(12).background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(isCurrent ? WF.primary.opacity(0.4) : WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(isCurrent || switchingTo != nil)
    }

    /// Outstanding invitations addressed to this account — accepting one creates the
    /// membership (it then appears above; it does not switch you into it).
    @ViewBuilder
    private func pendingInvitesSection(_ o: WaffledAPI.HouseholdOverview) -> some View {
        if !o.pendingInvites.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Invitations").padding(.top, 6)
                ForEach(o.pendingInvites) { inviteRow($0) }
            }
        }
    }

    private func inviteRow(_ inv: WaffledAPI.PendingInvite) -> some View {
        HStack(spacing: 12) {
            Text("✉️").font(.system(size: 20)).frame(width: 40, height: 40)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(inv.householdName).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Text("Invited as \(inv.isAdmin ? "Admin" : inv.memberType.capitalized)")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 0)
            Button { Task { await accept(inv) } } label: {
                if acceptingId == inv.id {
                    ProgressView().controlSize(.small).tint(WF.primary)
                } else {
                    Text("Accept").font(.system(size: 12.5, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(WF.primary).clipShape(Capsule())
                }
            }
            .buttonStyle(.plain).disabled(acceptingId != nil)
        }
        .padding(12).background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    /// Switch the active household: mint a token for it, adopt the session, then clear +
    /// re-pull the local mirror against the new household. Blocked while writes are still
    /// queued — clearing the mirror would strand them (the previous household's writes).
    private func switchTo(_ m: WaffledAPI.Membership) async {
        actionError = nil
        guard sync.pendingUploads == 0 else {
            let n = sync.pendingUploads
            actionError = "You have \(n) change\(n == 1 ? "" : "s") still syncing. Wait for sync to finish, then switch."
            return
        }
        switchingTo = m.householdId
        defer { switchingTo = nil }
        do {
            let r = try await api.switchHousehold(householdId: m.householdId)
            session.enterClaimedSession(access: r.accessToken, refresh: r.refreshToken)
            await sync.reauthenticate(clearLocal: true)   // household changed → wipe + re-pull
            await load()
        } catch let WaffledAPI.APIError.http(code, _) {
            actionError = code == 403
                ? "You're no longer a member of that household."
                : "Couldn't switch households (error \(code))."
        } catch {
            actionError = "Couldn't reach the server to switch."
        }
    }

    private func accept(_ inv: WaffledAPI.PendingInvite) async {
        actionError = nil
        acceptingId = inv.id
        defer { acceptingId = nil }
        do {
            try await api.acceptInvite(id: inv.id)
            await load()   // the new membership now shows under "Your households"
        } catch {
            actionError = "Couldn't accept the invitation. Try again."
        }
    }

    private func tag(_ t: String, _ color: Color) -> some View {
        WaffledStatusBadge(text: t, color: color)
    }

    private func load() async {
        async let s = try? await api.householdSettings()
        async let id = try? await api.currentPersonId()
        async let o = try? await api.householdOverview()
        settings = await s
        currentId = await id ?? nil
        overview = await o ?? nil
    }
}

/// Generates a one-time pairing code and waits for a tablet to claim it. Mirrors the
/// web's pairing card: show the code, copy it, and poll until a new device appears.
struct PairKioskSheet: View {
    let onPaired: () async -> Void

    @Environment(\.dismiss) private var dismiss
    private let api = WaffledAPI()

    @State private var code: WaffledAPI.PairingCode?
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
                        Text(error).font(.system(size: 14, weight: .medium)).foregroundStyle(WF.primary).padding(.top, 40)
                    } else {
                        ProgressView().tint(WF.ink3).padding(.top, 48)
                    }
                }
                .padding(24)
            }
            .background(WF.canvas)
            .navigationTitle("Pair a kiosk").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(pairedLabel == nil ? "Cancel" : "Done") { dismiss() } }
            }
        }
        .task { await run() }
    }

    private func codeCard(_ c: WaffledAPI.PairingCode) -> some View {
        VStack(spacing: 16) {
            Text("Enter this code on the new tablet")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                .multilineTextAlignment(.center)
            Text(c.code)
                .font(.system(size: 44, weight: .heavy, design: .monospaced))
                .tracking(6).foregroundStyle(WF.ink)
                .padding(.vertical, 18).frame(maxWidth: .infinity)
                .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            Button {
                UIPasteboard.general.string = c.code; copied = true
            } label: {
                Text(copied ? "Copied ✓" : "Copy code").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.primary)
            }
            .buttonStyle(.plain)
            Text("On the tablet: open this Waffled’s address → “Set up this device as a kiosk” → enter the code. It’s one-time and expires in about 10 minutes.")
                .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 7) {
                ProgressView().controlSize(.small).tint(WF.ink3)
                Text("Waiting for a device to pair…").font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.ink3)
            }
            .padding(.top, 4)
        }
    }

    private func success(_ label: String) -> some View {
        VStack(spacing: 12) {
            Text("✅").font(.system(size: 48))
            Text("A device just paired").font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink)
            Text(label).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(WF.panel).clipShape(Capsule())
            Text("If you’re still naming it on the tablet, the name updates here. Tap Done when you’re finished.")
                .font(.system(size: 13)).foregroundStyle(WF.ink3).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 40)
    }

    /// Create the code, then poll for the new device that claims it — and keep polling
    /// after, so the name stays live while it's still being set on the tablet (the row
    /// is created with a default label the instant it pairs). Stops when the sheet's
    /// task is cancelled (on dismiss).
    private func run() async {
        knownIds = Set(((try? await api.kioskDevices()) ?? []).map(\.id))
        do { code = try await api.createPairingCode(label: nil) }
        catch { self.error = "Couldn’t create a pairing code. Admins only."; return }
        var pairedId: String?
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(pairedId == nil ? 5 : 3))
            guard let fresh = try? await api.kioskDevices() else { continue }
            if pairedId == nil {
                guard let paired = fresh.first(where: { !knownIds.contains($0.id) }) else { continue }
                pairedId = paired.id
                pairedLabel = paired.label
                await onPaired()
            } else if let d = fresh.first(where: { $0.id == pairedId }), d.label != pairedLabel {
                pairedLabel = d.label    // they renamed it on the tablet — reflect it live
                await onPaired()
            }
        }
    }
}
