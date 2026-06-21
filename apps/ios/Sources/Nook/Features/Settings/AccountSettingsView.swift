import SwiftUI

/// Accounts panel: who this device is signed in as, the household it's joined to,
/// and **Sign out** (revokes the refresh token, clears the Keychain, wipes the local
/// mirror, and returns to the login screen). Mirrors the web's Settings sign-out.
struct AccountSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @Environment(Session.self) private var session

    @State private var settings: NookAPI.HouseholdSettings?
    @State private var currentId: String?
    @State private var confirmSignOut = false
    @State private var busy = false

    private let api = NookAPI()

    private var me: NookAPI.HouseholdSettings.Member? {
        guard let currentId else { return nil }
        return settings?.members.first { $0.id == currentId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                identityCard
                householdCard
                signOutButton
                Text("Signing out keeps nothing on this device — your family's data re-downloads next time you sign in.")
                    .font(.system(size: 12)).foregroundStyle(NK.ink3)
                    .padding(.horizontal, 4)
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Accounts").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
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

    private var signOutButton: some View {
        Button {
            if confirmSignOut { Task { await signOut() } } else { confirmSignOut = true }
        } label: {
            Text(busy ? "Signing out…" : (confirmSignOut ? "Tap again to sign out" : "Sign out"))
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(confirmSignOut ? .white : NK.primary)
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(confirmSignOut ? NK.primary : NK.card)
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                    .strokeBorder(confirmSignOut ? .clear : NK.primary.opacity(0.4), lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(busy)
        .padding(.top, 4)
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
    }

    private func signOut() async {
        busy = true
        // Flip to login first (clears the Keychain, tears down the authed UI), then
        // disconnect sync in the background. This Button's Task is unstructured, so it
        // runs to completion even though this view is removed when `phase` changes.
        await session.signOut()    // clear Keychain, revoke refresh, → login
        await sync.signOut()       // disconnect PowerSync + reset sync state
    }
}
