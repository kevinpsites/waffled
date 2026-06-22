import SwiftUI

/// Accounts panel: who this device is signed in as and the household it's joined to.
/// (Sign out lives on the Settings landing, like the web.)
struct AccountSettingsView: View {
    @State private var settings: NookAPI.HouseholdSettings?
    @State private var currentId: String?

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
}
