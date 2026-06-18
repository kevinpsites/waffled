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
    private(set) var archived: [NookAPI.Reward] = []
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
        archived = (try? await api.archivedRewards()) ?? []   // best-effort (admin-only)
        loading = false
    }

    func currency(_ key: String) -> NookAPI.Currency? { currencies.first { $0.key == key } }
    var spendableCurrencies: [NookAPI.Currency] { currencies.filter { $0.spendable } }
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

/// The saving-toward block, shared by the reward shop and the person spotlight so
/// both read identically: a violet hero when a target is pinned (tap to change), or
/// a dashed "pick one" prompt when not. Renders nothing if there's no target and no
/// rewards to pick. `colorHex`/`label` describe the target's currency.
struct SavingTowardCard: View {
    let saving: NookAPI.PersonOverview.SavingToward?
    let colorHex: String?
    let label: String?
    let canPick: Bool
    let onTap: () -> Void

    var body: some View {
        if let s = saving {
            Button(action: onTap) { hero(s) }.buttonStyle(.plain)
        } else if canPick {
            Button(action: onTap) { prompt }.buttonStyle(.plain)
        }
    }

    private func hero(_ s: NookAPI.PersonOverview.SavingToward) -> some View {
        let tint = Color(hexString: colorHex) ?? NK.ai
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
            Text(s.have >= s.cost ? "Ready to redeem! 🎉" : "\(s.have) of \(s.cost) \(label?.lowercased() ?? "")")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [tint.opacity(0.92), tint],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
    }

    private var prompt: some View {
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
        case edit(NookAPI.Reward)
        var id: String { if case .edit(let r) = self { return r.id }; return "new" }
        var reward: NookAPI.Reward? { if case .edit(let r) = self { return r }; return nil }
    }

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

                catalogSection
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Rewards").navigationBarTitleDisplayMode(.inline)
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
                Button { editor = .new } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus").font(.system(size: 12, weight: .bold))
                        Text("Add").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(NK.primary)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 4)

            if model.rewards.isEmpty {
                Text("No rewards yet — tap Add to create one.")
                    .font(.system(size: 13)).foregroundStyle(NK.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            } else {
                ForEach(model.rewards) { r in catalogRow(r) }
            }

            if !model.archived.isEmpty {
                Button { withAnimation { showArchived.toggle() } } label: {
                    HStack(spacing: 5) {
                        Image(systemName: showArchived ? "chevron.down" : "chevron.right")
                            .font(.system(size: 11, weight: .bold))
                        Text("Archived (\(model.archived.count))").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(NK.ink3)
                }
                .buttonStyle(.plain).padding(.top, 2)
                if showArchived { ForEach(model.archived) { r in archivedRow(r) } }
            }
        }
    }

    private func catalogRow(_ r: NookAPI.Reward) -> some View {
        Button { editor = .edit(r) } label: {
            HStack(spacing: 12) {
                Text(r.emoji ?? "🎁").font(.system(size: 22))
                    .frame(width: 40, height: 40).background(NK.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text(r.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                Spacer(minLength: 8)
                coin(r.currency, r.cost)
                Image(systemName: "pencil").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            .padding(12)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func archivedRow(_ r: NookAPI.Reward) -> some View {
        HStack(spacing: 12) {
            Text(r.emoji ?? "🎁").font(.system(size: 18)).opacity(0.6)
                .frame(width: 34, height: 34).background(NK.panel)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            Text(r.title).font(.system(size: 14, weight: .medium)).foregroundStyle(NK.ink2).lineLimit(1)
            Spacer(minLength: 8)
            Button { Task { _ = await sync.restoreReward(id: r.id); await model.load() } } label: {
                Text("Restore").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ai)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
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
    @State private var confirm: NookAPI.PersonOverview.ShopReward?
    @State private var giving = false
    @State private var showSavingPicker = false

    private let api = NookAPI()
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let p = model.person(personId) {
                    header(p)
                    SavingTowardCard(saving: overview?.savingToward, colorHex: savingCur?.color,
                                     label: savingCur?.label,
                                     canPick: !(overview?.rewardShop.isEmpty ?? true)) { showSavingPicker = true }
                    shopHead
                    let shop = overview?.rewardShop ?? []
                    if shop.isEmpty {
                        Text("No rewards yet — a parent can add them.")
                            .font(.system(size: 14)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 30)
                    } else {
                        LazyVGrid(columns: cols, spacing: 12) {
                            ForEach(shop) { r in rewardCard(r) }
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

    /// The currency definition for the current saving-toward target.
    private var savingCur: NookAPI.PersonOverview.Currency? {
        guard let key = overview?.savingToward?.currency else { return nil }
        return overview?.currencies.first { $0.key == key }
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

    private func rewardCard(_ r: NookAPI.PersonOverview.ShopReward) -> some View {
        let cur = model.currency(r.currency)
        let canAfford = r.have >= r.cost   // server-computed have/toGo
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
                Text("\(r.toGo) to go")
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

    private func give(_ r: NookAPI.PersonOverview.ShopReward) async {
        giving = true
        _ = await sync.giveReward(rewardId: r.id, personId: personId)
        confirm = nil
        giving = false
        await reload()
    }
}


/// Add or edit a reward (admins). Emoji + title + cost, a currency picker when the
/// household has more than one spendable currency, and Archive when editing.
/// Mirrors the web RewardModal. Writes via SyncManager (bumps rewardsRev).
struct RewardEditorSheet: View {
    let editing: NookAPI.Reward?
    let currencies: [NookAPI.Currency]   // spendable only
    let onDone: () -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var emoji: String
    @State private var title: String
    @State private var cost: Int
    @State private var currencyKey: String
    @State private var busy = false
    @State private var confirmArchive = false
    @FocusState private var titleFocused: Bool

    init(editing: NookAPI.Reward?, currencies: [NookAPI.Currency], onDone: @escaping () -> Void) {
        self.editing = editing
        self.currencies = currencies
        self.onDone = onDone
        _emoji = State(initialValue: editing?.emoji ?? "🎁")
        _title = State(initialValue: editing?.title ?? "")
        _cost = State(initialValue: editing?.cost ?? 10)
        let def = currencies.first(where: { $0.isDefault }) ?? currencies.first
        _currencyKey = State(initialValue: editing?.currency ?? def?.key ?? "stars")
    }

    private var selectedCur: NookAPI.Currency? { currencies.first { $0.key == currencyKey } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    HStack(spacing: 14) {
                        TextField("🎁", text: $emoji)
                            .font(.system(size: 34)).multilineTextAlignment(.center)
                            .frame(width: 70, height: 70)
                            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                        TextField("Movie night, 30 min screen time…", text: $title)
                            .font(.system(size: 17, weight: .semibold)).focused($titleFocused)
                            .padding(.horizontal, 14).padding(.vertical, 14)
                            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
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
                                            .foregroundStyle(on ? NK.ink : NK.ink2)
                                            .padding(.horizontal, 13).padding(.vertical, 8)
                                            .background(on ? (Color(hexString: c.color) ?? NK.ai).opacity(0.16) : NK.panel)
                                            .clipShape(Capsule())
                                            .overlay(Capsule().strokeBorder(on ? (Color(hexString: c.color) ?? NK.ai).opacity(0.5) : .clear, lineWidth: 1))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    NookCard(padding: 14) {
                        HStack {
                            Text("Cost").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Spacer()
                            Text(selectedCur?.symbol ?? "⭐").font(.system(size: 16))
                            TextField("0", value: $cost, format: .number)
                                .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                                .font(.system(size: 17, weight: .bold)).frame(width: 64)
                            Stepper("", value: $cost, in: 0...100000).labelsHidden()
                        }
                    }

                    Button { Task { await save() } } label: {
                        Text(busy ? "Saving…" : (editing == nil ? "Add reward" : "Save"))
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(title.trimmingCharacters(in: .whitespaces).isEmpty ? NK.ink3 : NK.primary)
                            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)

                    if editing != nil {
                        Button(role: .destructive) {
                            if confirmArchive { Task { await archive() } } else { confirmArchive = true }
                        } label: {
                            Text(confirmArchive ? "Tap again to archive" : "Archive reward")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(confirmArchive ? NK.primary : NK.ink3)
                        }
                        .buttonStyle(.plain)
                        Text("Archived rewards keep their redemption history and can be restored.")
                            .font(.system(size: 11)).foregroundStyle(NK.ink3).multilineTextAlignment(.center)
                            .padding(.horizontal, 30)
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle(editing == nil ? "New reward" : "Edit reward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { if editing == nil { titleFocused = true } }
        }
    }

    private func save() async {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        busy = true
        let e = emoji.trimmingCharacters(in: .whitespaces)
        let ok: Bool
        if let editing {
            ok = await sync.updateReward(id: editing.id, title: t, emoji: e.isEmpty ? nil : e, cost: max(0, cost), currency: currencyKey)
        } else {
            ok = await sync.createReward(title: t, emoji: e.isEmpty ? nil : e, cost: max(0, cost), currency: currencyKey)
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
