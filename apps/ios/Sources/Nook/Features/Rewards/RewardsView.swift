import SwiftUI
import Observation

/// Loads the household reward economy — the currency catalog, every person's
/// per-currency balances, the rewards catalog, and pending redemptions. Shared by
/// the Rewards overview and each person's shop; both reload on `sync.rewardsRev`.
@MainActor
@Observable
final class RewardsModel {
    private(set) var currencies: [NookAPI.Currency] = []
    private(set) var people: [NookAPI.PersonBalance] = []
    private(set) var rewards: [NookAPI.Reward] = []
    private(set) var pending: [NookAPI.RewardRedemption] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = NookAPI()

    func load() async {
        loading = true
        do {
            async let bal = api.balancesSummary()
            async let cat = api.rewardsCatalog()
            async let pend = api.redemptions(status: "pending")
            let (b, c, p) = try await (bal, cat, pend)
            currencies = b.currencies
            people = b.people
            rewards = c.sorted { $0.sortOrder < $1.sortOrder }
            pending = p
            error = false
        } catch {
            self.error = true
        }
        loading = false
    }

    func currency(_ key: String) -> NookAPI.Currency? { currencies.first { $0.key == key } }
    func person(_ id: String) -> NookAPI.PersonBalance? { people.first { $0.personId == id } }
    func balance(_ personId: String, _ currency: String) -> Int {
        person(personId)?.balances.first { $0.currency == currency }?.balance ?? 0
    }
}

/// A currency amount rendered like the web `Coin` — the currency's symbol + the
/// number, tinted with the currency's color.
struct CoinChip: View {
    let symbol: String
    let colorHex: String?
    let amount: Int

    var body: some View {
        let tint = Color(hexString: colorHex) ?? NK.ink2
        HStack(spacing: 4) {
            Text(symbol).font(.system(size: 12.5))
            Text("\(amount)").font(.system(size: 13.5, weight: .bold)).foregroundStyle(tint)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(tint.opacity(0.12))
        .clipShape(Capsule())
    }
}

/// Rewards overview — the Rewards tab landing on a parent's phone. Shows pending
/// requests the kids filed (approve/deny) and each family member's balances; tap a
/// person to open their reward shop.
struct RewardsView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model = RewardsModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !model.pending.isEmpty { approvalsCard }

                SectionLabel(text: "Family balances")
                if model.people.isEmpty && model.loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                } else {
                    ForEach(model.people) { p in personRow(p) }
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Rewards").navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await model.load() } }
    }

    // MARK: approvals

    private var approvalsCard: some View {
        NookCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Text("Needs your OK").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                    Text("\(model.pending.count)").font(.system(size: 12, weight: .heavy)).foregroundStyle(NK.primary)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(NK.primary.opacity(0.12)).clipShape(Capsule())
                }
                ForEach(Array(model.pending.enumerated()), id: \.element.id) { idx, r in
                    if idx > 0 { Divider().background(NK.hair) }
                    approvalRow(r)
                }
            }
        }
    }

    private func approvalRow(_ r: NookAPI.RewardRedemption) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(colorHex: r.personColor, emoji: r.personAvatar ?? "🙂", size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(r.personName ?? "Someone") wants")
                        .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                    HStack(spacing: 6) {
                        Text("\(r.emoji ?? "🎁") \(r.title)")
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                        coin(r.currency, r.cost)
                    }
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                Button { act { await sync.denyRedemption(id: r.id) } } label: {
                    Text("Deny").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(NK.panel).clipShape(Capsule())
                }.buttonStyle(.plain)
                Button { act { await sync.approveRedemption(id: r.id) } } label: {
                    Text("Approve").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(NK.primary).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
        }
    }

    // MARK: balances

    private func personRow(_ p: NookAPI.PersonBalance) -> some View {
        Button { path.append(.rewardShop(p.personId)) } label: {
            HStack(spacing: 12) {
                Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 44)
                Text(p.name ?? "—").font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
                Spacer(minLength: 8)
                HStack(spacing: 6) { ForEach(p.balances) { b in coin(b.currency, b.balance) } }
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
            }
            .padding(14)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func coin(_ key: String, _ amount: Int) -> CoinChip {
        let c = model.currency(key)
        return CoinChip(symbol: c?.symbol ?? "⭐", colorHex: c?.color, amount: amount)
    }

    /// Run a reward action then reload (the rev bus also nudges the person shop).
    private func act(_ work: @escaping () async -> Bool) {
        Task { _ = await work(); await model.load() }
    }
}

/// One person's reward shop — their balances and the catalog they can redeem from.
/// Affordable rewards get a Redeem button (debits on confirm); the rest show how
/// far off they are. Mirrors the design's per-kid shop (saving-toward hero pending
/// a backend endpoint).
struct RewardShopView: View {
    let personId: String
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model = RewardsModel()
    @State private var overview: NookAPI.PersonOverview?
    @State private var confirm: NookAPI.Reward?
    @State private var giving = false
    @State private var showSavingPicker = false

    private let api = NookAPI()
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let p = model.person(personId) {
                    header(p)
                    if let s = overview?.savingToward {
                        Button { showSavingPicker = true } label: { savingHero(s) }.buttonStyle(.plain)
                    } else if !(overview?.rewardShop.isEmpty ?? true) {
                        savingPrompt
                    }
                    shopHead
                    if model.rewards.isEmpty {
                        Text("No rewards yet — a parent can add them on the web.")
                            .font(.system(size: 14)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 30)
                    } else {
                        LazyVGrid(columns: cols, spacing: 12) {
                            ForEach(model.rewards) { r in rewardCard(r) }
                        }
                    }
                } else if model.loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 60)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle(model.person(personId)?.name ?? "Reward shop")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await reload() } }
        .confirmationDialog(confirm.map { "Redeem \($0.title)?" } ?? "",
                            isPresented: Binding(get: { confirm != nil },
                                                 set: { if !$0 { confirm = nil } }),
                            presenting: confirm) { r in
            Button("Redeem · \(model.currency(r.currency)?.symbol ?? "⭐") \(r.cost)") {
                Task { await give(r) }
            }
            Button("Cancel", role: .cancel) { confirm = nil }
        } message: { r in
            Text("Uses \(r.cost) \(model.currency(r.currency)?.label ?? "stars") from \(model.person(personId)?.name ?? "their")’s balance.")
        }
        .sheet(isPresented: $showSavingPicker) {
            SavingTowardPicker(rewards: overview?.rewardShop ?? [],
                               currencies: overview?.currencies ?? [],
                               current: overview?.savingToward?.id) { rewardId in
                Task { _ = await sync.setSavingToward(personId: personId, rewardId: rewardId); await reload() }
            }
        }
    }

    // MARK: header

    private func header(_ p: NookAPI.PersonBalance) -> some View {
        HStack(spacing: 14) {
            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 58)
            VStack(alignment: .leading, spacing: 6) {
                Text(p.name ?? "—").font(NK.serif(26)).foregroundStyle(NK.ink)
                HStack(spacing: 8) {
                    ForEach(displayBalances(p)) { b in
                        let c = model.currency(b.currency)
                        CoinChip(symbol: c?.symbol ?? "⭐", colorHex: c?.color, amount: b.balance)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    /// Balances to show in the header: every catalog currency, so a 0 still reads.
    private func displayBalances(_ p: NookAPI.PersonBalance) -> [NookAPI.PersonBalance.CurrencyBalance] {
        let byKey = Dictionary(uniqueKeysWithValues: p.balances.map { ($0.currency, $0) })
        let ordered = model.currencies.isEmpty ? p.balances.map(\.currency) : model.currencies.map(\.key)
        return ordered.map { key in byKey[key] ?? .init(currency: key, balance: 0) }
    }

    // MARK: saving-toward hero

    private func savingHero(_ s: NookAPI.PersonOverview.SavingToward) -> some View {
        let cur = model.currency(s.currency)
        let tint = Color(hexString: cur?.color) ?? NK.ai
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("SAVING TOWARD")
                    .font(.system(size: 11, weight: .heavy)).tracking(0.6).foregroundStyle(.white.opacity(0.85))
                Spacer()
                Text("Change").font(.system(size: 12, weight: .bold)).foregroundStyle(.white.opacity(0.9))
            }
            HStack(spacing: 9) {
                Text(s.emoji ?? "🎁").font(.system(size: 24))
                Text(s.title).font(NK.serif(22)).foregroundStyle(.white).lineLimit(2)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.28))
                    Capsule().fill(.white)
                        .frame(width: geo.size.width * max(0.02, min(1, Double(s.pct) / 100)))
                }
            }
            .frame(height: 9)
            Text("\(s.have) of \(s.cost) \(cur?.label.lowercased() ?? "")")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [tint.opacity(0.92), tint],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
    }

    /// Shown when the person has no target yet — a dashed prompt to pick one.
    private var savingPrompt: some View {
        Button { showSavingPicker = true } label: {
            HStack(spacing: 11) {
                Image(systemName: "target").font(.system(size: 18)).foregroundStyle(NK.ai)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pick something to save toward")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    Text("Track progress to a reward").font(.system(size: 12)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(NK.ai.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous)
                .strokeBorder(NK.ai.opacity(0.25), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])))
        }
        .buttonStyle(.plain)
    }

    private var shopHead: some View {
        HStack {
            Text("Reward shop").font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink)
            Spacer()
            Text("Set by parents").font(.system(size: 13)).foregroundStyle(NK.ink3)
        }
    }

    private func reload() async {
        await model.load()
        overview = try? await api.personOverview(id: personId)
    }

    // MARK: a reward

    private func rewardCard(_ r: NookAPI.Reward) -> some View {
        let bal = model.balance(personId, r.currency)
        let cur = model.currency(r.currency)
        let canAfford = bal >= r.cost
        return VStack(spacing: 9) {
            Text(r.emoji ?? "🎁").font(.system(size: 40)).frame(height: 54)
            Text(r.title).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                .multilineTextAlignment(.center).lineLimit(2)
            Text("\(r.cost) \(cur?.label.lowercased() ?? "")")
                .font(.system(size: 13)).foregroundStyle(NK.ink3)
            Spacer(minLength: 0)
            if canAfford {
                Button { confirm = r } label: {
                    HStack(spacing: 5) {
                        Text("Redeem").font(.system(size: 15, weight: .bold))
                        Text("\(cur?.symbol ?? "⭐") \(r.cost)").font(.system(size: 15, weight: .bold))
                    }
                    .foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(NK.primary).clipShape(Capsule())
                }
                .buttonStyle(.plain).disabled(giving)
            } else {
                Text("\(r.cost - bal) to go")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(NK.panel).clipShape(Capsule())
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 196)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .nkShadow1()
    }

    private func give(_ r: NookAPI.Reward) async {
        giving = true
        _ = await sync.giveReward(rewardId: r.id, personId: personId)
        confirm = nil
        giving = false
        await model.load()
    }
}

