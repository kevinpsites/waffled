import SwiftUI

/// Loads the household's pending approvals — reward purchases awaiting a yes/no and
/// chore completions awaiting a parent's OK. Online-only (REST), like Chores/Rewards.
@MainActor
@Observable
final class ApprovalsModel {
    private(set) var redemptions: [WaffledAPI.RewardRedemption] = []
    private(set) var chores: [WaffledAPI.ChoreInstanceDTO] = []
    private(set) var loading = true

    private let api = WaffledAPI()

    var total: Int { redemptions.count + chores.count }
    var isEmpty: Bool { total == 0 }

    func load() async {
        async let red = try? await api.redemptions(status: "pending")
        async let ch = try? await api.awaitingChores()
        redemptions = await red ?? []
        chores = await ch ?? []
        loading = false
    }

    func drop(redemption id: String) { redemptions.removeAll { $0.id == id } }
    func drop(chore id: String) { chores.removeAll { $0.id == id } }
}

/// The gold "N to approve" entry card, shown wherever a parent might jump to the
/// approval queue (Today, Chores, Rewards). Self-navigating — it pushes `.approvals`
/// in whatever NavigationStack hosts it — and renders nothing for kids or an empty
/// queue, so callers can drop it in unconditionally. Gold (vs. the review card's
/// purple) flags an action you need to take, not a confirmation.
struct ApprovalsBanner: View {
    let model: ApprovalsModel
    @Environment(SyncManager.self) private var sync

    var body: some View {
        if sync.canApprove && !model.isEmpty {
            NavigationLink(value: HubRoute.approvals) { card }.buttonStyle(.plain)
        }
    }

    private var card: some View {
        HStack(spacing: 13) {
            Image(systemName: "checkmark.seal.fill").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(NK.gold)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(model.total == 1 ? "1 to approve" : "\(model.total) to approve")
                    .font(.system(size: 16, weight: .heavy)).foregroundStyle(NK.ink)
                Text(preview).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3).lineLimit(1)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.system(size: 14, weight: .heavy)).foregroundStyle(NK.gold)
        }
        .padding(14)
        .background(NK.gold.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.gold.opacity(0.30), lineWidth: 1))
    }

    private var preview: String {
        let red = model.redemptions.map { "\($0.personName ?? "Someone")’s \($0.title)" }
        let ch = model.chores.map { "\($0.personName ?? "Someone")’s \($0.choreTitle)" }
        let preview = (red + ch).prefix(3).joined(separator: " · ")
        return preview.isEmpty ? "Tap to review reward purchases & chores" : preview
    }
}

/// The approval queue reached from the Today "Needs your OK" card. Mirrors the
/// goal-calendar `ReviewEventsView` pattern: a focused list you clear one tap at a time.
struct ApprovalsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = ApprovalsModel()
    @State private var reviewing: WaffledAPI.ChoreInstanceDTO?   // open proof review sheet

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // Only surface a queue the signed-in person can actually action — a
                    // chore-only approver never sees reward purchases here, and vice versa.
                    let showRedemptions = sync.can("reward.approve") && !model.redemptions.isEmpty
                    let showChores = sync.can("chore.approve") && !model.chores.isEmpty
                    if model.loading && model.isEmpty {
                        WaffledLoading()
                    } else if !showRedemptions && !showChores {
                        WaffledEmptyState(emoji: "🎉", title: "All caught up",
                                       message: "No reward purchases or chores waiting on you.")
                    } else {
                        if showRedemptions {
                            SectionLabel(text: "Reward purchases")
                            ForEach(model.redemptions) { redemptionRow($0) }
                        }
                        if showChores {
                            SectionLabel(text: "Chore check-offs").padding(.top, showRedemptions ? 8 : 0)
                            ForEach(model.chores) { choreRow($0) }
                        }
                    }
                }
                .padding(16).padding(.bottom, 110)
                // Fill the viewport so the ScrollView is genuinely scrollable even when
                // empty — otherwise iOS won't reveal the pull-to-refresh control.
                .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .top)
            }
            .scrollBounceBehavior(.always)
            .refreshable { await model.load() }
        }
        .background(NK.canvas)
        .navigationTitle("Needs your OK").navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .sheet(item: $reviewing) { c in
            ChoreProofReview(
                chore: c, memberColorHex: nil,
                coin: c.rewardAmount > 0 ? "\(c.rewardAmount)\(sync.currencySymbol(c.rewardCurrency))" : nil,
                onApprove: { decide({ model.drop(chore: c.id) }) { await sync.approveChore(id: c.id) } },
                onReject: { decide({ model.drop(chore: c.id) }) { await sync.rejectChore(id: c.id) } })
        }
    }

    // MARK: rows

    private func redemptionRow(_ r: WaffledAPI.RewardRedemption) -> some View {
        rowCard {
            header(emoji: r.personAvatar, color: r.personColor,
                   who: r.personName, wants: "\(r.emoji ?? "🎁") \(r.title)",
                   coin: "\(r.cost)\(sync.currencySymbol(r.currency))")
            actions(
                denyLabel: "Deny",
                deny: { decide({ model.drop(redemption: r.id) }) { await sync.denyRedemption(id: r.id) } },
                approve: { decide({ model.drop(redemption: r.id) }) { await sync.approveRedemption(id: r.id) } })
        }
    }

    private func choreRow(_ c: WaffledAPI.ChoreInstanceDTO) -> some View {
        rowCard {
            HStack(spacing: 10) {
                header(emoji: c.emoji, color: nil,
                       who: c.personName, wants: "\(c.emoji ?? "🧹") \(c.choreTitle)",
                       coin: c.rewardAmount > 0 ? "\(c.rewardAmount)\(sync.currencySymbol(c.rewardCurrency))" : nil,
                       verb: "finished")
                // Photo-proof chores get a tappable thumbnail (opens the big review);
                // an expired proof shows "📷 gone"; non-photo chores show nothing here.
                ChoreProofThumb(chore: c) { reviewing = c }
            }
            actions(
                denyLabel: "Not yet",
                deny: { decide({ model.drop(chore: c.id) }) { await sync.rejectChore(id: c.id) } },
                approve: { decide({ model.drop(chore: c.id) }) { await sync.approveChore(id: c.id) } })
        }
    }

    // MARK: row building blocks

    @ViewBuilder
    private func header(emoji: String?, color: String?, who: String?, wants: String, coin: String?, verb: String = "wants") -> some View {
        HStack(spacing: 10) {
            Avatar(colorHex: color, emoji: emoji ?? "🙂", size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(who ?? "Someone") \(verb)").font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                HStack(spacing: 6) {
                    Text(wants).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                    if let coin {
                        Text(coin).font(.system(size: 12.5, weight: .heavy)).foregroundStyle(NK.gold)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(NK.gold.opacity(0.14)).clipShape(Capsule())
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func actions(denyLabel: String, deny: @escaping () -> Void, approve: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Button(action: deny) {
                Text(denyLabel).font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(NK.panel).clipShape(Capsule())
            }.buttonStyle(.plain)
            Button(action: approve) {
                Text("Approve").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(NK.primary).clipShape(Capsule())
            }.buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func rowCard<Content: View>(@ViewBuilder _ content: @escaping () -> Content) -> some View {
        WaffledCard(padding: 14) { VStack(alignment: .leading, spacing: 10) { content() } }
    }

    /// Optimistically clears the row, runs the decision, and restores the true state
    /// (re-fetch) if it failed.
    private func decide(_ drop: () -> Void, _ op: @escaping () async -> Bool) {
        drop()
        Task { if await op() == false { await model.load() } }
    }
}
