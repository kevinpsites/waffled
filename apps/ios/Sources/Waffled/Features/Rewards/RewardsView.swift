import SwiftUI
import Observation

/// Loads the household reward economy — the currency catalog, every person's
/// per-currency balances, the rewards catalog, and pending redemptions. Shared by
/// the Rewards overview and each person's shop; both reload on `sync.rewardsRev`.
@MainActor
@Observable
final class RewardsModel {
    private(set) var currencies: [WaffledAPI.Currency] = []
    private(set) var people: [WaffledAPI.PersonBalance] = []
    private(set) var rewards: [WaffledAPI.Reward] = []
    private(set) var archived: [WaffledAPI.Reward] = []
    private(set) var pending: [WaffledAPI.RewardRedemption] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = WaffledAPI()

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
        archived = (try? await api.archivedRewards()) ?? []   // best-effort (admin-only)
        loading = false
    }

    func currency(_ key: String) -> WaffledAPI.Currency? { currencies.first { $0.key == key } }
    var spendableCurrencies: [WaffledAPI.Currency] { currencies.filter { $0.spendable } }
    func person(_ id: String) -> WaffledAPI.PersonBalance? { people.first { $0.personId == id } }
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
        let tint = Color(hexString: colorHex) ?? WF.gold
        HStack(spacing: 4) {
            Text(symbol).font(.system(size: 12.5))
            Text("\(amount)").font(.system(size: 13.5, weight: .bold)).foregroundStyle(tint)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(tint.opacity(0.12))
        .clipShape(Capsule())
    }
}

/// A jar that fills from the bottom to `pct` — the goal-jar take on "saving toward".
/// A white jar on the currency-tinted hero, filled with the currency color (web parity).
struct JarView: View {
    let pct: Int
    let fill: Color

    var body: some View {
        let f = max(0, min(100, Double(pct)))
        VStack(spacing: 3) {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(Color(red: 0.80, green: 0.73, blue: 0.61)).frame(width: 26, height: 6) // lid
            ZStack(alignment: .bottom) {
                Rectangle().fill(.white)
                Rectangle().fill(fill.opacity(0.85)).frame(height: 60 * f / 100)
            }
            .frame(width: 48, height: 60)
            .overlay(Text("\(Int(f))%").font(.system(size: 13, weight: .heavy))
                .foregroundStyle(f > 55 ? .white : WF.ink))
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Color(white: 0.88), lineWidth: 2.5))
        }
    }
}

/// The saving-toward block, shared by the reward shop and the person spotlight so
/// both read identically: a currency-tinted hero when a target is pinned — with a Bar/Jar
/// progress toggle, a **Redeem** button once it's affordable, and **Change** — or a
/// dashed "pick one" prompt when not. `colorHex`/`symbol` describe the currency.
struct SavingTowardCard: View {
    let saving: WaffledAPI.PersonOverview.SavingToward?
    let colorHex: String?
    let symbol: String?
    let canPick: Bool
    let onChange: () -> Void
    let onRedeem: () -> Void

    @AppStorage("waffled.savingJar") private var jar = false

    var body: some View {
        if let s = saving { hero(s) }
        else if canPick { Button(action: onChange) { prompt }.buttonStyle(.plain) }
    }

    private func hero(_ s: WaffledAPI.PersonOverview.SavingToward) -> some View {
        let tint = Color(hexString: colorHex) ?? WF.gold   // orange when the currency has no color
        let ready = s.have >= s.cost
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("SAVING TOWARD")
                    .font(.system(size: 11, weight: .heavy)).tracking(0.6).foregroundStyle(.white.opacity(0.85))
                Spacer()
                toggle(tint)
            }
            HStack(alignment: .center, spacing: 13) {
                if jar { JarView(pct: s.pct, fill: tint) }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 9) {
                        Text(s.emoji ?? "🎁").font(.system(size: 22))
                        Text(s.title).font(WF.serif(20)).foregroundStyle(.white).lineLimit(2)
                    }
                    if !jar {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(.white.opacity(0.28))
                                Capsule().fill(.white)
                                    .frame(width: geo.size.width * max(0.02, min(1, Double(s.pct) / 100)))
                            }
                        }
                        .frame(height: 9)
                    }
                    Text(ready ? "Ready to redeem! 🎉"
                               : "\(s.have) of \(s.cost) \(symbol ?? "⭐") · \(s.toGo) to go")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.92))
                }
                Spacer(minLength: 0)
                VStack(spacing: 7) {
                    if ready {
                        Button(action: onRedeem) { pill("Redeem", bg: WF.primary, outline: false) }
                            .buttonStyle(.plain)
                    }
                    Button(action: onChange) { pill("Change", bg: .white.opacity(0.18), outline: true) }
                        .buttonStyle(.plain)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [tint.opacity(0.92), tint],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
    }

    private func pill(_ t: String, bg: Color, outline: Bool) -> some View {
        Text(t).font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(bg).clipShape(Capsule())
            .overlay(outline ? AnyView(Capsule().strokeBorder(.white.opacity(0.4), lineWidth: 1)) : AnyView(EmptyView()))
    }

    private func toggle(_ tint: Color) -> some View {
        HStack(spacing: 0) {
            seg("Bar", on: !jar, tint: tint) { jar = false }
            seg("Jar", on: jar, tint: tint) { jar = true }
        }
        .padding(2).background(.white.opacity(0.22)).clipShape(Capsule())
    }

    private func seg(_ t: String, on: Bool, tint: Color, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(t).font(.system(size: 12, weight: .bold))
                .foregroundStyle(on ? tint : .white.opacity(0.85))
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(on ? AnyView(Capsule().fill(.white)) : AnyView(Color.clear))
        }
        .buttonStyle(.plain)
    }

    private var prompt: some View {
        HStack(spacing: 11) {
            Image(systemName: "target").font(.system(size: 18)).foregroundStyle(WF.ai)
            VStack(alignment: .leading, spacing: 2) {
                Text("Pick something to save toward")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Text("Track progress to a reward").font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .background(WF.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
            .strokeBorder(WF.ai.opacity(0.25), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])))
    }
}

/// Rewards overview — the Rewards tab landing on a parent's phone. Shows pending
/// requests the kids filed (approve/deny) and each family member's balances; tap a
/// person to open their reward shop.
struct RewardsView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model = RewardsModel()
    @State private var editor: EditorMode?
    @State private var showArchived = false

    /// What the reward editor sheet is doing.
    private enum EditorMode: Identifiable {
        case new
        case edit(WaffledAPI.Reward)
        var id: String { if case .edit(let r) = self { return r.id }; return "new" }
        var reward: WaffledAPI.Reward? { if case .edit(let r) = self { return r }; return nil }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if isKiosk {
                    KioskPageHeader("Rewards", "Spend stars on what your family loves.") {
                        if sync.can("reward.manage") {
                            KioskHeaderButton(icon: "plus", label: "New reward") { editor = .new }
                        }
                    }
                }
                if sync.can("reward.approve") && !model.pending.isEmpty {
                    // Cap + center the approval card on iPad so it reads identically to the
                    // Chores tab's card (same component) instead of stretching full-bleed and
                    // throwing the Deny/Approve buttons out to the screen edge.
                    approvalsCard
                        .frame(maxWidth: isKiosk ? 760 : .infinity)
                        .frame(maxWidth: .infinity, alignment: isKiosk ? .center : .leading)
                }

                SectionLabel(text: "Family balances")
                if model.people.isEmpty && model.loading {
                    WaffledLoading(top: 40)
                } else {
                    ForEach(model.people) { p in personRow(p) }
                }

                catalogSection
            }
            .padding(16).padding(.bottom, 110)
        }
        .scrollBounceBehavior(.always)
        .background(WF.canvas)
        .navigationTitle("Rewards").navigationBarTitleDisplayMode(.inline)
        .toolbar(isKiosk ? .hidden : .visible, for: .navigationBar)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await model.load() } }
        .sheet(item: $editor) { mode in
            RewardEditorSheet(editing: mode.reward, currencies: model.spendableCurrencies) {
                Task { await model.load() }
            }
        }
    }

    // MARK: catalog management

    private var catalogSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel(text: "Rewards")
                Spacer()
                // Creating/editing rewards is manage-only; everyone can still see the
                // catalog (so they know what to save toward) and redeem from it.
                if sync.can("reward.manage") {
                    Button { editor = .new } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus").font(.system(size: 12, weight: .bold))
                            Text("Add").font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(WF.primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)

            if model.rewards.isEmpty {
                Text("No rewards yet — tap Add to create one.")
                    .font(.system(size: 13)).foregroundStyle(WF.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            } else {
                ForEach(model.rewards) { r in catalogRow(r) }
            }

            if !model.archived.isEmpty && sync.can("reward.manage") {
                Button { withAnimation { showArchived.toggle() } } label: {
                    HStack(spacing: 5) {
                        Image(systemName: showArchived ? "chevron.down" : "chevron.right")
                            .font(.system(size: 11, weight: .bold))
                        Text("Archived (\(model.archived.count))").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(WF.ink3)
                }
                .buttonStyle(.plain).padding(.top, 2)
                if showArchived { ForEach(model.archived) { r in archivedRow(r) } }
            }
        }
    }

    private func catalogRow(_ r: WaffledAPI.Reward) -> some View {
        // Only managers can open the editor — others see the same row without the
        // pencil affordance, and tapping does nothing (no dead-end into a 403).
        let canManage = sync.can("reward.manage")
        return Button { if canManage { editor = .edit(r) } } label: {
            HStack(spacing: 12) {
                WaffledEmojiTile(emoji: r.emoji ?? "🎁")
                Text(r.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Spacer(minLength: 8)
                coin(r.currency, r.cost)
                if canManage {
                    Image(systemName: "pencil").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                }
            }
            .padding(12)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(!canManage)
    }

    private func archivedRow(_ r: WaffledAPI.Reward) -> some View {
        HStack(spacing: 12) {
            WaffledEmojiTile(emoji: r.emoji ?? "🎁", size: 18, frame: 34, cornerRadius: 9, emojiOpacity: 0.6)
            Text(r.title).font(.system(size: 14, weight: .medium)).foregroundStyle(WF.ink2).lineLimit(1)
            Spacer(minLength: 8)
            Button { Task { _ = await sync.restoreReward(id: r.id); await model.load() } } label: {
                Text("Restore").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ai)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    // MARK: approvals

    private var approvalsCard: some View {
        WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Text("Needs your OK").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    WaffledStatusBadge(text: "\(model.pending.count)", color: WF.primary, size: 12, weight: .heavy)
                }
                ForEach(Array(model.pending.enumerated()), id: \.element.id) { idx, r in
                    if idx > 0 { Divider().background(WF.hair) }
                    approvalRow(r)
                }
            }
        }
    }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    @ViewBuilder
    private func approvalRow(_ r: WaffledAPI.RewardRedemption) -> some View {
        if isKiosk {
            // Compact single line on iPad — full-width buttons read as excessive there.
            HStack(spacing: 12) {
                Avatar(colorHex: r.personColor, emoji: r.personAvatar ?? "🙂", size: 34)
                approvalText(r)
                Spacer(minLength: 8)
                ApprovalActionPair(
                    denyLabel: "Deny", isKiosk: true,
                    onDeny: { act { await sync.denyRedemption(id: r.id) } },
                    onApprove: { act { await sync.approveRedemption(id: r.id) } }
                )
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Avatar(colorHex: r.personColor, emoji: r.personAvatar ?? "🙂", size: 36)
                    approvalText(r)
                    Spacer(minLength: 0)
                }
                ApprovalActionPair(
                    denyLabel: "Deny", isKiosk: false,
                    onDeny: { act { await sync.denyRedemption(id: r.id) } },
                    onApprove: { act { await sync.approveRedemption(id: r.id) } }
                )
            }
        }
    }

    private func approvalText(_ r: WaffledAPI.RewardRedemption) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(r.personName ?? "Someone") wants")
                .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
            HStack(spacing: 6) {
                Text("\(r.emoji ?? "🎁") \(r.title)")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                coin(r.currency, r.cost)
            }
        }
    }

    // MARK: balances

    private func personRow(_ p: WaffledAPI.PersonBalance) -> some View {
        Button { path.append(.rewardShop(p.personId)) } label: {
            HStack(spacing: 12) {
                Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 44)
                Text(p.name ?? "—").font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                HStack(spacing: 6) { ForEach(p.balances) { b in coin(b.currency, b.balance) } }
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(14)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
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
    @State private var overview: WaffledAPI.PersonOverview?
    @State private var conversions: [WaffledAPI.Conversion] = []
    @State private var confirm: WaffledAPI.PersonOverview.ShopReward?
    @State private var giving = false
    @State private var showSavingPicker = false
    @State private var showTrade = false

    private let api = WaffledAPI()
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let p = model.person(personId) {
                    header(p)
                    SavingTowardCard(saving: overview?.savingToward, colorHex: savingCur?.color,
                                     symbol: savingCur?.symbol,
                                     canPick: !(overview?.rewardShop.isEmpty ?? true),
                                     onChange: { showSavingPicker = true },
                                     onRedeem: redeemSaving)
                    shopHead
                    let shop = overview?.rewardShop ?? []
                    if shop.isEmpty {
                        Text("No rewards yet — a parent can add them.")
                            .font(.system(size: 14)).foregroundStyle(WF.ink3)
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 30)
                    } else {
                        LazyVGrid(columns: cols, spacing: 12) {
                            ForEach(shop) { r in rewardCard(r) }
                        }
                    }
                } else if model.loading {
                    WaffledLoading(top: 60)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .scrollBounceBehavior(.always)
        .background(WF.canvas)
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
        .sheet(isPresented: $showTrade) {
            TradeSheet(personName: model.person(personId)?.name ?? "",
                       personId: personId,
                       currencies: overview?.currencies ?? [],
                       balances: overview?.balances ?? [],
                       conversions: conversions) { await reload() }
        }
    }

    // MARK: header

    private func header(_ p: WaffledAPI.PersonBalance) -> some View {
        HStack(spacing: 14) {
            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 58)
            VStack(alignment: .leading, spacing: 6) {
                Text(p.name ?? "—").font(WF.serif(26)).foregroundStyle(WF.ink)
                HStack(spacing: 8) {
                    ForEach(displayBalances(p)) { b in
                        let c = model.currency(b.currency)
                        CoinChip(symbol: c?.symbol ?? "⭐", colorHex: c?.color, amount: b.balance)
                    }
                }
            }
            Spacer(minLength: 8)
            if !conversions.isEmpty {
                Button { showTrade = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.left.arrow.right").font(.system(size: 12, weight: .bold))
                        Text("Trade").font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(WF.ai)
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .background(WF.ai.opacity(0.12)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Balances to show in the header: every catalog currency, so a 0 still reads.
    private func displayBalances(_ p: WaffledAPI.PersonBalance) -> [WaffledAPI.PersonBalance.CurrencyBalance] {
        let byKey = Dictionary(uniqueKeysWithValues: p.balances.map { ($0.currency, $0) })
        let ordered = model.currencies.isEmpty ? p.balances.map(\.currency) : model.currencies.map(\.key)
        return ordered.map { key in byKey[key] ?? .init(currency: key, balance: 0) }
    }

    /// The currency definition for the current saving-toward target.
    private var savingCur: WaffledAPI.PersonOverview.Currency? {
        guard let key = overview?.savingToward?.currency else { return nil }
        return overview?.currencies.first { $0.key == key }
    }

    private var shopHead: some View {
        HStack {
            Text("Reward shop").font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink)
            Spacer()
            Text("Set by parents").font(.system(size: 13)).foregroundStyle(WF.ink3)
        }
    }

    private func reload() async {
        await model.load()
        overview = try? await api.personOverview(id: personId)
        conversions = (try? await api.conversions()) ?? []
    }

    // MARK: a reward

    private func rewardCard(_ r: WaffledAPI.PersonOverview.ShopReward) -> some View {
        let cur = model.currency(r.currency)
        let canAfford = r.have >= r.cost   // server-computed have/toGo
        return VStack(spacing: 9) {
            Text(r.emoji ?? "🎁").font(.system(size: 40)).frame(height: 54)
            Text(r.title).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                .multilineTextAlignment(.center).lineLimit(2)
            Text("\(r.cost) \(cur?.label.lowercased() ?? "")")
                .font(.system(size: 13)).foregroundStyle(WF.ink3)
            Spacer(minLength: 0)
            if canAfford {
                Button { confirm = r } label: {
                    HStack(spacing: 5) {
                        Text("Redeem").font(.system(size: 15, weight: .bold))
                        Text("\(cur?.symbol ?? "⭐") \(r.cost)").font(.system(size: 15, weight: .bold))
                    }
                    .foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(WF.primary).clipShape(Capsule())
                }
                .buttonStyle(.plain).disabled(giving)
            } else {
                Text("\(r.toGo) to go")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(WF.panel).clipShape(Capsule())
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 196)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .wfShadow1()
    }

    private func give(_ r: WaffledAPI.PersonOverview.ShopReward) async {
        giving = true
        _ = await sync.giveReward(rewardId: r.id, personId: personId)
        confirm = nil
        giving = false
        await reload()
    }

    /// Redeem the pinned saving-toward reward directly (web parity — no extra
    /// confirm; the button only appears once it's affordable).
    private func redeemSaving() {
        guard let s = overview?.savingToward else { return }
        Task { _ = await sync.giveReward(rewardId: s.id, personId: personId); await reload() }
    }
}


/// Add or edit a reward (admins). Emoji + title + cost, a currency picker when the
/// household has more than one spendable currency, and Archive when editing.
/// Mirrors the web RewardModal. Writes via SyncManager (bumps rewardsRev).
struct RewardEditorSheet: View {
    let editing: WaffledAPI.Reward?
    let currencies: [WaffledAPI.Currency]   // spendable only
    let onDone: () -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var emoji: String
    @State private var title: String
    @State private var cost: Int
    @State private var currencyKey: String
    @State private var requiresApproval: Bool
    @State private var busy = false
    @State private var confirmArchive = false
    @FocusState private var titleFocused: Bool

    private let api = WaffledAPI()

    init(editing: WaffledAPI.Reward?, currencies: [WaffledAPI.Currency], onDone: @escaping () -> Void) {
        self.editing = editing
        self.currencies = currencies
        self.onDone = onDone
        _emoji = State(initialValue: editing?.emoji ?? "🎁")
        _title = State(initialValue: editing?.title ?? "")
        _cost = State(initialValue: editing?.cost ?? 10)
        let def = currencies.first(where: { $0.isDefault }) ?? currencies.first
        _currencyKey = State(initialValue: editing?.currency ?? def?.key ?? "stars")
        // New rewards inherit the household default below (.task); edits keep their value.
        _requiresApproval = State(initialValue: editing?.requiresApproval ?? true)
    }

    private var selectedCur: WaffledAPI.Currency? { currencies.first { $0.key == currencyKey } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    HStack(spacing: 14) {
                        TextField("🎁", text: $emoji)
                            .font(.system(size: 34)).multilineTextAlignment(.center)
                            .frame(width: 70, height: 70)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                        TextField("Movie night, 30 min screen time…", text: $title)
                            .font(.system(size: 17, weight: .semibold)).focused($titleFocused)
                            .padding(.horizontal, 14).padding(.vertical, 14)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }

                    if currencies.count > 1 {
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Currency")
                            ChipFlow(spacing: 8, lineSpacing: 8) {
                                ForEach(currencies) { c in
                                    let on = c.key == currencyKey
                                    Button { currencyKey = c.key } label: {
                                        Text("\(c.symbol) \(c.label)")
                                            .font(.system(size: 14, weight: on ? .bold : .medium))
                                            .foregroundStyle(on ? WF.ink : WF.ink2)
                                            .padding(.horizontal, 13).padding(.vertical, 8)
                                            .background(on ? (Color(hexString: c.color) ?? WF.gold).opacity(0.16) : WF.panel)
                                            .clipShape(Capsule())
                                            .overlay(Capsule().strokeBorder(on ? (Color(hexString: c.color) ?? WF.gold).opacity(0.5) : .clear, lineWidth: 1))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    WaffledCard(padding: 14) {
                        HStack {
                            Text("Cost").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer()
                            Text(selectedCur?.symbol ?? "⭐").font(.system(size: 16))
                            TextField("0", value: $cost, format: .number)
                                .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                                .font(.system(size: 17, weight: .bold)).frame(width: 64)
                            Stepper("", value: $cost, in: 0...100000).labelsHidden()
                        }
                    }

                    WaffledCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Needs a parent’s OK").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                                Spacer()
                                Toggle("", isOn: $requiresApproval).labelsHidden().tint(WF.primary)
                            }
                            Text(requiresApproval ? "Redeeming waits for a parent to approve."
                                                  : "Redeems instantly if they can afford it.")
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }

                    Button { Task { await save() } } label: {
                        Text(busy ? "Saving…" : (editing == nil ? "Add reward" : "Save"))
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(title.trimmingCharacters(in: .whitespaces).isEmpty ? WF.ink3 : WF.primary)
                            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)

                    if editing != nil {
                        Button(role: .destructive) {
                            if confirmArchive { Task { await archive() } } else { confirmArchive = true }
                        } label: {
                            Text(confirmArchive ? "Tap again to archive" : "Archive reward")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(confirmArchive ? WF.primary : WF.ink3)
                        }
                        .buttonStyle(.plain)
                        Text("Archived rewards keep their redemption history and can be restored.")
                            .font(.system(size: 11)).foregroundStyle(WF.ink3).multilineTextAlignment(.center)
                            .padding(.horizontal, 30)
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle(editing == nil ? "New reward" : "Edit reward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { if editing == nil { titleFocused = true } }
            .task {
                // New rewards default to the household's setting (Settings → Chores & rewards).
                if editing == nil, let s = try? await api.rewardSettings() { requiresApproval = s.requireApproval }
            }
        }
    }

    private func save() async {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        busy = true
        let e = emoji.trimmingCharacters(in: .whitespaces)
        let ok: Bool
        if let editing {
            ok = await sync.updateReward(id: editing.id, title: t, emoji: e.isEmpty ? nil : e, cost: max(0, cost), currency: currencyKey, requiresApproval: requiresApproval)
        } else {
            ok = await sync.createReward(title: t, emoji: e.isEmpty ? nil : e, cost: max(0, cost), currency: currencyKey, requiresApproval: requiresApproval)
        }
        busy = false
        if ok { onDone(); dismiss() }
    }

    private func archive() async {
        guard let editing else { return }
        busy = true
        let ok = await sync.archiveReward(id: editing.id)
        busy = false
        if ok { onDone(); dismiss() }
    }
}
