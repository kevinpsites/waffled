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
    @State private var awarding = false
    @State private var managing = false                 // "Manage rewards" sheet (add/edit/archive)
    @State private var activePersonId: String?          // whose shop the tab is showing

    /// What the reward editor sheet is doing.
    private enum EditorMode: Identifiable {
        case new
        case edit(WaffledAPI.Reward)
        var id: String { if case .edit(let r) = self { return r.id }; return "new" }
        var reward: WaffledAPI.Reward? { if case .edit(let r) = self { return r }; return nil }
    }

    var body: some View {
        // The Rewards tab IS the shop now: person tabs pinned on top (like the calendar
        // filters), the selected person's shop below. Web-parity.
        VStack(spacing: 0) {
            if isKiosk {
                KioskPageHeader("Rewards", "Spend stars on what your family loves.") {
                    actionButtons
                }
                .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 4)
            }
            personSelector
            Divider().background(WF.hair)
            shopArea
        }
        .background(WF.canvas)
        .navigationTitle("Rewards").navigationBarTitleDisplayMode(.inline)
        .toolbar(isKiosk ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            if !isKiosk { ToolbarItemGroup(placement: .primaryAction) { actionButtons } }
        }
        .task { await model.load(); ensureActive() }
        .refreshable { await model.load(); ensureActive() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await model.load(); ensureActive() } }
        .sheet(item: $editor) { mode in
            RewardEditorSheet(editing: mode.reward, currencies: model.spendableCurrencies) {
                Task { await model.load() }
            }
        }
        .sheet(isPresented: $awarding) {
            AwardStarsPickerSheet(people: model.people, currencies: model.currencies) {
                await model.load()
            }
        }
        .sheet(isPresented: $managing) {
            NavigationStack {
                ScrollView { catalogSection.padding(16).padding(.bottom, 40) }
                    .background(WF.canvas)
                    .navigationTitle("Manage rewards").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { managing = false } } }
            }
        }
    }

    // MARK: person tabs + shop

    /// The person-tab strip at the top of the Rewards tab — pick whose shop to view.
    private var personSelector: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.people) { p in
                    let on = p.personId == activePersonId
                    Button { withAnimation(.snappy) { activePersonId = p.personId } } label: {
                        HStack(spacing: 7) {
                            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 26)
                            Text(p.name ?? "—").font(.system(size: 14, weight: .bold))
                        }
                        .foregroundStyle(on ? .white : WF.ink)
                        .padding(.leading, 6).padding(.trailing, 13).padding(.vertical, 6)
                        .background(on ? WF.ink : WF.card)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
        .background(WF.canvas)
    }

    @ViewBuilder private var shopArea: some View {
        if let pid = activePersonId {
            RewardShopView(personId: pid, embedded: true,
                           canManage: sync.can("reward.manage"),
                           onEdit: { editor = .edit($0) })
        } else if model.loading {
            VStack { WaffledLoading(top: 60); Spacer() }
        } else {
            VStack(spacing: 8) {
                Spacer()
                Text("🎁").font(.system(size: 40))
                Text("No family members yet.").font(.system(size: 14)).foregroundStyle(WF.ink3)
                Spacer()
            }
        }
    }

    /// Award (spot) · Manage · Approvals — shared by the iPhone toolbar + iPad header.
    @ViewBuilder private var actionButtons: some View {
        if sync.can("reward.approve") && !model.pending.isEmpty {
            Button { path.append(.approvals) } label: {
                Image(systemName: "bell.badge").overlay(alignment: .topTrailing) {
                    WaffledStatusBadge(text: "\(model.pending.count)", color: WF.primary, size: 11, weight: .heavy).offset(x: 7, y: -7)
                }
            }
        }
        if sync.can("reward.grant") && !model.people.isEmpty {
            Button { awarding = true } label: { Image(systemName: "star.fill").foregroundStyle(WF.gold) }
        }
        if sync.can("reward.manage") {
            Button { managing = true } label: { Image(systemName: "slider.horizontal.3") }
        }
    }

    private func ensureActive() {
        if let id = activePersonId, model.people.contains(where: { $0.personId == id }) { return }
        activePersonId = model.people.first?.personId
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
    var embedded = false                              // rendered inside the Rewards tab (no own header/navbar)
    var canManage = false                             // managers get an edit ✎ on tiles
    var onEdit: ((WaffledAPI.Reward) -> Void)? = nil
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @State private var model = RewardsModel()
    @State private var overview: WaffledAPI.PersonOverview?
    @State private var conversions: [WaffledAPI.Conversion] = []
    @State private var category = "all"                 // selected category chip
    @State private var redeemFor: WaffledAPI.Reward?     // redeem-confirm sheet
    @State private var celebrate: Celebrated?            // success sheet
    @State private var giving = false
    @State private var showSavingPicker = false
    @State private var showTrade = false

    struct Celebrated: Identifiable {
        let reward: WaffledAPI.Reward; let pending: Bool; let balanceBefore: Int
        var id: String { reward.id }
    }

    private let api = WaffledAPI()
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        // Standalone (pushed) draws its own header + hides the nav bar; embedded in the
        // Rewards tab it's just the scroll (the tab owns the chrome + person tabs).
        if embedded { content }
        else { content.navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .navigationBar) }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let p = model.person(personId) {
                    if !embedded { header(p) }
                    heroCard(p)
                    if !presentCategories.isEmpty { categoryChips }
                    if rewards.isEmpty {
                        emptyState
                    } else {
                        ForEach(groupedSections, id: \.cat.key) { s in
                            categorySection(s.cat, s.items)
                        }
                    }
                } else if model.loading {
                    WaffledLoading(top: 60)
                }
            }
            .padding(16).padding(.bottom, embedded ? 32 : 110)
        }
        .scrollBounceBehavior(.always)
        .background(WF.canvas)
        .task(id: personId) { await reload() }
        .refreshable { await reload() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await reload() } }
        .sheet(item: $redeemFor) { r in
            RedeemShopSheet(reward: r, category: ShopCategory.of(r.category),
                            currency: model.currency(r.currency), balance: balance(r.currency),
                            busy: giving,
                            onCancel: { redeemFor = nil },
                            onConfirm: { Task { await redeem(r) } })
                .presentationDetents([.height(440)])
        }
        .sheet(item: $celebrate) { c in
            ShopCelebrationView(reward: c.reward, category: ShopCategory.of(c.reward.category),
                                currency: model.currency(c.reward.currency),
                                balanceBefore: c.balanceBefore, pending: c.pending) { celebrate = nil }
                .presentationDetents([.height(440)])
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

    // MARK: shop data

    private var rewards: [WaffledAPI.Reward] { model.rewards }
    private func balance(_ currency: String) -> Int { model.balance(personId, currency) }
    private func affordable(_ r: WaffledAPI.Reward) -> Bool { balance(r.currency) >= r.cost }
    private var defaultCurrencyKey: String {
        model.currencies.first { $0.isDefault }?.key ?? model.currencies.first?.key ?? "stars"
    }

    /// Reward-shop categories that actually have rewards (+ an Other bucket when some
    /// reward is uncategorised / unknown) — only these get filter chips.
    private var presentCategories: [ShopCategory] {
        let keys = Set(rewards.compactMap { $0.category })
        var cats = ShopCategory.all.filter { keys.contains($0.key) }
        if rewards.contains(where: { ShopCategory.byKey[$0.category ?? ""] == nil }) { cats.append(.other) }
        return cats
    }

    private func catKey(_ r: WaffledAPI.Reward) -> String { ShopCategory.of(r.category).key }

    /// Sections to render: under "All", every present category; under a chip, just it.
    private var groupedSections: [(cat: ShopCategory, items: [WaffledAPI.Reward])] {
        let cats = category == "all" ? presentCategories : presentCategories.filter { $0.key == category }
        return cats.compactMap { c in
            let items = rewards.filter { catKey($0) == c.key }.sorted { $0.sortOrder < $1.sortOrder }
            return items.isEmpty ? nil : (c, items)
        }
    }

    // MARK: header + hero

    private func header(_ p: WaffledAPI.PersonBalance) -> some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(width: 36, height: 36).background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain)
            Text("Reward shop").font(WF.serif(26)).foregroundStyle(WF.ink)
            Spacer()
            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 40)
        }
    }

    /// The wallet hero — this person's balance in the saving-toward (or default)
    /// currency + a "N to go for {reward}" nudge.
    private func heroCard(_ p: WaffledAPI.PersonBalance) -> some View {
        let saving = overview?.savingToward
        let key = saving?.currency ?? defaultCurrencyKey
        let cur = model.currency(key)
        let bal = balance(key)
        return HStack(spacing: 14) {
            ZStack {
                Circle().fill(.white.opacity(0.22)).frame(width: 56, height: 56)
                Text(cur?.symbol ?? "⭐").font(.system(size: 26))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("\((p.name ?? "My").uppercased())’S \((cur?.label ?? "Stars").uppercased())")
                    .font(.system(size: 12, weight: .heavy)).tracking(0.5).foregroundStyle(.white.opacity(0.85))
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(bal)").font(.system(size: 34, weight: .heavy)).foregroundStyle(.white)
                    Text(cur?.symbol ?? "★").font(.system(size: 18)).foregroundStyle(.white.opacity(0.9))
                }
                Button { showSavingPicker = true } label: {
                    Text(saving.map { "🚀 \($0.toGo) to go for \($0.title)" } ?? "＋ Pick something to save toward")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.92)).lineLimit(1)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 4)
            if !conversions.isEmpty {
                Button { showTrade = true } label: {
                    Image(systemName: "arrow.left.arrow.right").font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white).frame(width: 34, height: 34)
                        .background(.white.opacity(0.18)).clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [Color(hex: 0x9169EA), Color(hex: 0x7B54E8)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
    }

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("all", "All", nil)
                ForEach(presentCategories) { c in chip(c.key, c.label, c.emoji) }
            }
            .padding(.vertical, 1)
        }
    }

    private func chip(_ key: String, _ label: String, _ emoji: String?) -> some View {
        let on = category == key
        return Button { withAnimation(.snappy) { category = key } } label: {
            HStack(spacing: 5) {
                if let emoji { Text(emoji).font(.system(size: 13)) }
                Text(label).font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(on ? .white : WF.ink)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(on ? WF.ink : WF.card)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var emptyState: some View {
        Text("No rewards yet — a parent can add them.")
            .font(.system(size: 14)).foregroundStyle(WF.ink3)
            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 30)
    }

    private func categorySection(_ cat: ShopCategory, _ items: [WaffledAPI.Reward]) -> some View {
        let canGet = items.filter(affordable).count
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(cat.emoji) \(cat.label)").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                Spacer()
                Text("\(canGet) you can get").font(.system(size: 13)).foregroundStyle(WF.ink3)
            }
            LazyVGrid(columns: cols, spacing: 12) {
                ForEach(items) { r in rewardCard(r, cat) }
            }
        }
    }

    // MARK: a reward tile

    private func rewardCard(_ r: WaffledAPI.Reward, _ cat: ShopCategory) -> some View {
        let cur = model.currency(r.currency)
        let bal = balance(r.currency)
        let can = bal >= r.cost
        let need = max(0, r.cost - bal)
        let pct = r.cost > 0 ? min(1.0, Double(bal) / Double(r.cost)) : 1.0
        return VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Rectangle().fill(can ? AnyShapeStyle(cat.gradient) : AnyShapeStyle(WF.panel))
                Text(r.emoji ?? "🎁").font(.system(size: 38)).opacity(can ? 1 : 0.55)
            }
            .frame(height: 92)
            .overlay(alignment: .topLeading) {
                if !can { Text("🔒").font(.system(size: 14)).padding(7) }
            }
            .overlay(alignment: .topTrailing) {
                HStack(spacing: 3) {
                    Text(cur?.symbol ?? "★").font(.system(size: 11))
                    Text("\(r.cost)").font(.system(size: 12, weight: .heavy))
                }
                .foregroundStyle(WF.ink)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(.white).clipShape(Capsule())
                .padding(7)
            }
            .overlay(alignment: .bottomTrailing) {
                if canManage, let onEdit {
                    Button { onEdit(r) } label: {
                        Image(systemName: "pencil").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(width: 28, height: 28).background(.white.opacity(0.9)).clipShape(Circle())
                    }
                    .buttonStyle(.plain).padding(6)
                }
            }
            VStack(alignment: .leading, spacing: 7) {
                Text(r.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                Text(cat.label.uppercased()).font(.system(size: 10, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
                if can {
                    Button { redeemFor = r } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "star.fill").font(.system(size: 11, weight: .bold))
                            Text("Get it").font(.system(size: 14, weight: .bold))
                        }
                        .foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(WF.primary).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(giving)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        ZStack(alignment: .leading) {
                            Capsule().fill(WF.panel).frame(height: 6)
                            GeometryReader { g in Capsule().fill(WF.primary).frame(width: g.size.width * pct, height: 6) }
                                .frame(height: 6)
                        }
                        Text("\(need) more to unlock").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(11)
        }
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        .wfShadow1()
    }

    private func reload() async {
        await model.load()
        overview = try? await api.personOverview(id: personId)
        conversions = (try? await api.conversions()) ?? []
    }

    private func redeem(_ r: WaffledAPI.Reward) async {
        giving = true
        let before = balance(r.currency)
        _ = await sync.giveReward(rewardId: r.id, personId: personId)
        giving = false
        redeemFor = nil
        try? await Task.sleep(for: .milliseconds(350))   // let the confirm sheet dismiss first
        celebrate = Celebrated(reward: r, pending: r.requiresApproval, balanceBefore: before)
        await reload()
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
    @State private var category: String?          // reward-shop category (nil = uncategorised)
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
        _category = State(initialValue: editing?.category)
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

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Category (for the shop)")
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            categoryChip(nil, "None", "🚫")
                            ForEach(ShopCategory.all) { c in categoryChip(c.key, c.label, c.emoji) }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

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

    private func categoryChip(_ key: String?, _ label: String, _ emoji: String) -> some View {
        let on = category == key
        return Button { category = key } label: {
            HStack(spacing: 5) {
                Text(emoji).font(.system(size: 13))
                Text(label).font(.system(size: 14, weight: on ? .bold : .medium))
            }
            .foregroundStyle(on ? WF.ink : WF.ink2)
            .padding(.horizontal, 13).padding(.vertical, 8)
            .background(on ? WF.primary.opacity(0.14) : WF.panel)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(on ? WF.primary.opacity(0.5) : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func save() async {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        busy = true
        let e = emoji.trimmingCharacters(in: .whitespaces)
        let ok: Bool
        if let editing {
            ok = await sync.updateReward(id: editing.id, title: t, emoji: e.isEmpty ? nil : e, cost: max(0, cost), currency: currencyKey, category: category, requiresApproval: requiresApproval)
        } else {
            ok = await sync.createReward(title: t, emoji: e.isEmpty ? nil : e, cost: max(0, cost), currency: currencyKey, category: category, requiresApproval: requiresApproval)
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

/// Hand out ad-hoc "spot" stars from the Rewards page — pick a family member, an
/// amount + currency, and an optional reason. Gated by `reward.grant` at the call
/// site; mirrors the person-profile Award sheet but adds a person picker. Writes a
/// positive `spot_award` ledger entry (advances the recipient's saving-toward jar).
struct AwardStarsPickerSheet: View {
    let people: [WaffledAPI.PersonBalance]
    let currencies: [WaffledAPI.Currency]
    let onDone: () async -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var selectedPersonId: String
    @State private var amount = 5
    @State private var currency: String
    @State private var note = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var noteFocused: Bool

    init(people: [WaffledAPI.PersonBalance], currencies: [WaffledAPI.Currency], onDone: @escaping () async -> Void) {
        self.people = people; self.currencies = currencies; self.onDone = onDone
        _selectedPersonId = State(initialValue: people.first?.personId ?? "")
        let def = currencies.first { $0.isDefault } ?? currencies.first
        _currency = State(initialValue: def?.key ?? "stars")
    }

    private var cur: WaffledAPI.Currency? { currencies.first { $0.key == currency } }
    private var symbol: String { cur?.symbol ?? "⭐" }
    private var selectedPerson: WaffledAPI.PersonBalance? { people.first { $0.personId == selectedPersonId } }
    private var canAward: Bool { amount > 0 && !selectedPersonId.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Award stars").font(WF.serif(22)).foregroundStyle(WF.ink)
                        Text("Hand out ad-hoc stars for something great.").font(.system(size: 13)).foregroundStyle(WF.ink3)
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "To")
                        Menu {
                            ForEach(people) { p in
                                Button { selectedPersonId = p.personId } label: { Text(p.name ?? "—") }
                            }
                        } label: {
                            HStack(spacing: 10) {
                                Avatar(colorHex: selectedPerson?.colorHex, emoji: selectedPerson?.avatarEmoji ?? "🙂", size: 32)
                                Text(selectedPerson?.name ?? "Pick a person").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "How many")
                        HStack(spacing: 14) {
                            Button { amount = max(1, amount - 1) } label: { stepGlyph("minus") }
                            HStack(spacing: 4) {
                                Text(symbol).font(.system(size: 18))
                                Text("\(amount)").font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink).frame(minWidth: 30)
                            }
                            Button { amount += 1 } label: { stepGlyph("plus") }
                            Spacer()
                            if currencies.count > 1 {
                                Menu {
                                    ForEach(currencies) { c in Button("\(c.symbol) \(c.label)") { currency = c.key } }
                                } label: {
                                    HStack(spacing: 5) {
                                        Text("\(symbol) \(cur?.label ?? "Stars")").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
                                    }
                                    .padding(.horizontal, 12).padding(.vertical, 9)
                                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Note (optional)")
                        TextField("e.g. so helpful today", text: $note)
                            .font(.system(size: 15)).focused($noteFocused).submitLabel(.done)
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }

                    if let error { Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary) }

                    Button { Task { await award() } } label: {
                        Text(busy ? "Awarding…" : "Award \(amount) \(symbol)")
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(canAward ? WF.primary : WF.ink3)
                            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(!canAward || busy)
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Award stars").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func stepGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
            .frame(width: 36, height: 36).background(WF.panel).clipShape(Circle())
    }

    private func award() async {
        guard canAward else { return }
        busy = true; error = nil
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let ok = await sync.awardSpot(personId: selectedPersonId, amount: amount, currency: currency,
                                      note: trimmed.isEmpty ? nil : trimmed)
        busy = false
        if ok { await onDone(); dismiss() }
        else { error = "Couldn’t award those stars. Try again." }
    }
}

/// The reward-shop categories (mirrors the web `SHOP_CATEGORIES`): a key the backend
/// stores + an emoji, label, and per-category thumb gradient. Unknown/null → Other.
struct ShopCategory: Identifiable, Hashable {
    let key: String
    let label: String
    let emoji: String
    let grad: [UInt32]
    var id: String { key }

    static let all: [ShopCategory] = [
        .init(key: "treats", label: "Treats", emoji: "🍦", grad: [0xFBDCC4, 0xF3B183]),
        .init(key: "screen", label: "Screen time", emoji: "📺", grad: [0xD3E2FB, 0x9DC0F2]),
        .init(key: "adventures", label: "Adventures", emoji: "🎢", grad: [0xD9EDD2, 0xA9D59A]),
        .init(key: "toys", label: "Toys", emoji: "🧸", grad: [0xEEDAF7, 0xCFA9E8]),
        .init(key: "privileges", label: "Privileges", emoji: "👑", grad: [0xFBDCC4, 0xF3B183]),
    ]
    static let other = ShopCategory(key: "other", label: "Other", emoji: "🎁", grad: [0xEEDAF7, 0xCFA9E8])
    static let byKey: [String: ShopCategory] = Dictionary(uniqueKeysWithValues: all.map { ($0.key, $0) })
    static func of(_ key: String?) -> ShopCategory { byKey[key ?? ""] ?? .other }

    var gradient: LinearGradient {
        LinearGradient(colors: grad.map { Color(hex: $0) }, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// The redeem-confirm sheet — mirrors the web RedeemSheet: a gradient well + emoji,
/// the price, a "balance → left" line, an approval note when the reward needs it, and
/// Not yet / Redeem it! actions.
struct RedeemShopSheet: View {
    let reward: WaffledAPI.Reward
    let category: ShopCategory
    let currency: WaffledAPI.Currency?
    let balance: Int
    let busy: Bool
    let onCancel: () -> Void
    let onConfirm: () -> Void

    private var sym: String { currency?.symbol ?? "★" }
    private var left: Int { balance - reward.cost }

    var body: some View {
        VStack(spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous).fill(category.gradient).frame(width: 92, height: 92)
                Text(reward.emoji ?? "🎁").font(.system(size: 44))
            }
            .padding(.top, 26)
            Text("Redeem \(reward.title)?").font(WF.serif(24)).foregroundStyle(WF.ink).multilineTextAlignment(.center)
            HStack(spacing: 5) {
                Text(sym).font(.system(size: 13))
                Text("\(reward.cost) \(currency?.label.lowercased() ?? "stars")").font(.system(size: 15, weight: .bold))
            }
            .foregroundStyle(WF.ink2)
            .padding(.horizontal, 14).padding(.vertical, 7).background(WF.panel).clipShape(Capsule())
            Text("\(balance) \(sym) → \(left) \(sym) left").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
            if reward.requiresApproval {
                Label("Mom & Dad will get a ping to approve", systemImage: "checkmark.circle.fill")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 8).background(WF.panel).clipShape(Capsule())
            }
            Spacer(minLength: 0)
            HStack(spacing: 10) {
                Button(action: onCancel) {
                    Text("Not yet").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain)
                Button(action: onConfirm) {
                    Text(busy ? "Redeeming…" : "Redeem it!").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(WF.primary).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain).disabled(busy)
            }
        }
        .padding(.horizontal, 20).padding(.bottom, 20)
        .frame(maxWidth: .infinity)
        .background(WF.canvas)
    }
}

/// The post-redeem celebration — a confetti burst over the reward, a balance line, an
/// approval-aware pill, and Back to shop. Mirrors the web Celebration.
struct ShopCelebrationView: View {
    let reward: WaffledAPI.Reward
    let category: ShopCategory
    let currency: WaffledAPI.Currency?
    let balanceBefore: Int
    let pending: Bool
    let onClose: () -> Void

    private var sym: String { currency?.symbol ?? "★" }
    private var left: Int { balanceBefore - reward.cost }

    var body: some View {
        VStack(spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous).fill(category.gradient).frame(width: 92, height: 92)
                Text(reward.emoji ?? "🎁").font(.system(size: 44))
            }
            .padding(.top, 30)
            Text("\(reward.title) unlocked! 🎉").font(WF.serif(24)).foregroundStyle(WF.ink).multilineTextAlignment(.center)
            Text("\(balanceBefore) \(sym) → \(left) \(sym) left").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
            Label(pending ? "We told Mom & Dad — enjoy!" : "Enjoy!", systemImage: "checkmark.circle.fill")
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.primary)
                .padding(.horizontal, 12).padding(.vertical, 8).background(WF.primary.opacity(0.12)).clipShape(Capsule())
            Spacer(minLength: 0)
            Button(action: onClose) {
                Text("Back to shop").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(WF.primary).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20).padding(.bottom, 20)
        .frame(maxWidth: .infinity)
        .overlay(ConfettiView().allowsHitTesting(false))
        .background(WF.canvas)
    }
}

/// A lightweight one-shot confetti burst (no dependency) — colored bits fall from the
/// top on appear.
struct ConfettiView: View {
    @State private var fall = false
    private let colors: [Color] = [0xEC6049, 0x8A5CF0, 0xF3A93B, 0x25A368, 0x2F7FED, 0xE0548B].map { Color(hex: $0) }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(0..<26, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(colors[i % colors.count])
                        .frame(width: 7, height: 11)
                        .rotationEffect(.degrees(Double((i * 47) % 360)))
                        .position(x: CGFloat((i * 37 + 11) % 100) / 100 * max(geo.size.width, 1),
                                  y: fall ? geo.size.height + 24 : -24)
                        .opacity(fall ? 0 : 1)
                        .animation(.easeIn(duration: 1.15).delay(Double(i % 6) * 0.05), value: fall)
                }
            }
        }
        .onAppear { fall = true }
    }
}
