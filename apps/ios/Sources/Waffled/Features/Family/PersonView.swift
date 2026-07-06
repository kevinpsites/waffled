import SwiftUI
import Observation

/// The Family per-person spotlight — tap a kid (or anyone) on the Family hub.
/// Their stars + streak, today's chores and a featured goal, a merged day list
/// (events + chores), the whole-person category balance, their goals, recent stars
/// and reward redemptions. Reads `/api/persons/:id/overview` (+ today's chores);
/// events come from the synced mirror.
@MainActor
@Observable
final class PersonOverviewModel {
    let personId: String
    private(set) var overview: WaffledAPI.PersonOverview?
    private(set) var chores: [WaffledAPI.ChoreInstanceDTO] = []
    private(set) var conversions: [WaffledAPI.Conversion] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = WaffledAPI()
    init(personId: String) { self.personId = personId }

    func load() async {
        async let o = api.personOverview(id: personId)
        async let c = api.choreInstances(date: ChoreDates.today())
        async let cv = api.conversions()
        do {
            overview = try await o
            chores = (try await c).filter { $0.personId == personId }
            error = false
        } catch { self.error = true }
        conversions = (try? await cv) ?? []
        loading = false
    }

    var choresDone: Int { chores.filter { $0.status == "done" }.count }

    /// Optimistic complete/uncomplete from the day list.
    func toggleChore(_ inst: WaffledAPI.ChoreInstanceDTO) async {
        guard let idx = chores.firstIndex(where: { $0.id == inst.id }) else { return }
        let isComplete = inst.status == "done" || inst.status == "awaiting"
        let next = isComplete ? "pending" : (inst.requiresApproval ? "awaiting" : "done")
        withAnimation { chores[idx].status = next }
        do {
            if isComplete { try await api.uncompleteChore(id: inst.id) } else { try await api.completeChore(id: inst.id) }
            await load()
        } catch {
            if let i = chores.firstIndex(where: { $0.id == inst.id }) { withAnimation { chores[i].status = inst.status } }
        }
    }
}

struct PersonView: View {
    @Environment(SyncManager.self) private var sync
    let personId: String
    @Binding var path: [HubRoute]
    @State private var model: PersonOverviewModel
    @State private var showCapture = false
    @State private var editingEvent: SyncedEvent?
    @State private var showSavingPicker = false
    @State private var showTrade = false
    @State private var showAward = false
    // Collapse state for the iPad spotlight's grouped sections.
    @State private var dayOpen = true
    @State private var goalsOpen = true
    @State private var rewardsOpen = true

    init(personId: String, path: Binding<[HubRoute]>) {
        self.personId = personId
        _path = path
        _model = State(initialValue: PersonOverviewModel(personId: personId))
    }

    private var person: WaffledAPI.PersonOverview.Person? { model.overview?.person }
    private var firstName: String { (person?.name ?? "").split(separator: " ").first.map(String.init) ?? (person?.name ?? "") }
    private var color: Color { Color(hexString: person?.colorHex) ?? WF.ink3 }

    /// A person's balances joined to their currency definitions (symbol + color),
    /// in the household's currency order — supports custom currencies, not just stars.
    private struct CurBal: Identifiable { let key, symbol, label: String; let color: Color; let amount, sort: Int; var id: String { key } }
    private func balances(_ ov: WaffledAPI.PersonOverview) -> [CurBal] {
        let defs = Dictionary(ov.currencies.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        return ov.balances.compactMap { b -> CurBal? in
            guard let d = defs[b.currency] else { return nil }
            return CurBal(key: d.key, symbol: d.symbol, label: d.label,
                          color: Color(hexString: d.color) ?? WF.gold, amount: b.balance, sort: d.sortOrder)
        }
        .sorted { $0.sort < $1.sort }
    }
    private func symbol(for currency: String) -> String {
        model.overview?.currencies.first { $0.key == currency }?.symbol ?? "⭐"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                statCards
                if isKiosk {
                    // Grouped into logical sections (Today · Goals & balance · Rewards),
                    // each balanced on its own — and each collapsible.
                    collapsibleSection("\(firstName.uppercased())’S DAY", $dayOpen) {
                        dayContent
                        addButton
                    }
                    if let ov = model.overview {
                        if goalsHasContent(ov) {
                            collapsibleSection("Goals & balance", $goalsOpen) { goalsContent(ov) }
                        }
                        collapsibleSection("Rewards & currencies", $rewardsOpen) { rewardsContent(ov) }
                    }
                } else {
                    if let ov = model.overview {
                        let cur = ov.currencies.first { $0.key == ov.savingToward?.currency }
                        SavingTowardCard(saving: ov.savingToward, colorHex: cur?.color, symbol: cur?.symbol,
                                         canPick: !ov.rewardShop.isEmpty,
                                         onChange: { showSavingPicker = true },
                                         onRedeem: redeemSaving)
                    }
                    daySection
                    if let ov = model.overview {
                        if ov.categoryBalance.contains(where: { $0.goalCount > 0 }) { balanceCard(ov) }
                        if !ov.goals.isEmpty { goalsCard(ov) }
                        starsCard(ov)
                        if !ov.redemptions.isEmpty { redemptionsCard(ov) }
                    }
                    addButton
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle(firstName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .task { await sync.loadCurrencies() }
        .refreshable { await model.load() }
        .sheet(isPresented: $showCapture) { CaptureSheet().presentationDragIndicator(.visible) }
        .sheet(item: $editingEvent) { ev in EventEditSheet(event: ev, initialDate: ev.startsAt ?? Date()) }
        .sheet(isPresented: $showSavingPicker) {
            SavingTowardPicker(rewards: model.overview?.rewardShop ?? [],
                               currencies: model.overview?.currencies ?? [],
                               current: model.overview?.savingToward?.id) { rewardId in
                Task { _ = await sync.setSavingToward(personId: personId, rewardId: rewardId); await model.load() }
            }
        }
        .sheet(isPresented: $showTrade) {
            TradeSheet(personName: firstName, personId: personId,
                       currencies: model.overview?.currencies ?? [],
                       balances: model.overview?.balances ?? [],
                       conversions: model.conversions) { await model.load() }
        }
        .sheet(isPresented: $showAward) {
            AwardStarsSheet(personName: firstName, personId: personId,
                            currencies: model.overview?.currencies ?? []) { await model.load() }
        }
    }

    /// iPad lays the spotlight out two-column (day on the left, rewards/goals/stars on
    /// the right); iPhone is a single column.
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    /// A tappable section header (label + rotating chevron) that shows/hides its content
    /// — used by the iPad spotlight so each group can be collapsed.
    @ViewBuilder private func collapsibleSection<Content: View>(
        _ title: String, _ open: Binding<Bool>, @ViewBuilder content: () -> Content) -> some View {
        Button { withAnimation(.easeInOut(duration: 0.2)) { open.wrappedValue.toggle() } } label: {
            HStack {
                SectionLabel(text: title)
                Spacer()
                DisclosureChevron(isOpen: open.wrappedValue, size: 13)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
        if open.wrappedValue { content() }
    }

    /// Whether the "Goals & balance" section has anything to show.
    private func goalsHasContent(_ ov: WaffledAPI.PersonOverview) -> Bool {
        ov.categoryBalance.contains(where: { $0.goalCount > 0 }) || !ov.goals.isEmpty
    }

    /// "Goals & balance" body — the whole-person balance beside the goals list (or one of
    /// them full-width when the other is absent).
    @ViewBuilder private func goalsContent(_ ov: WaffledAPI.PersonOverview) -> some View {
        let hasBalance = ov.categoryBalance.contains(where: { $0.goalCount > 0 })
        let hasGoals = !ov.goals.isEmpty
        if hasBalance && hasGoals {
            HStack(alignment: .top, spacing: 16) {
                balanceCard(ov).frame(maxWidth: .infinity, alignment: .top)
                goalsCard(ov).frame(maxWidth: .infinity, alignment: .top)
            }
        } else if hasBalance {
            balanceCard(ov)
        } else {
            goalsCard(ov)
        }
    }

    /// "Rewards & currencies" body — saving-toward + redemptions on the left, the currency /
    /// chores balances on the right.
    @ViewBuilder private func rewardsContent(_ ov: WaffledAPI.PersonOverview) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(spacing: 16) {
                let cur = ov.currencies.first { $0.key == ov.savingToward?.currency }
                SavingTowardCard(saving: ov.savingToward, colorHex: cur?.color, symbol: cur?.symbol,
                                 canPick: !ov.rewardShop.isEmpty,
                                 onChange: { showSavingPicker = true },
                                 onRedeem: redeemSaving)
                if !ov.redemptions.isEmpty { redemptionsCard(ov) }
            }
            .frame(maxWidth: .infinity, alignment: .top)
            VStack(spacing: 16) { starsCard(ov) }
                .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    /// Redeem the pinned saving-toward reward directly (only shown when affordable).
    private func redeemSaving() {
        guard let s = model.overview?.savingToward else { return }
        Task { _ = await sync.giveReward(rewardId: s.id, personId: personId); await model.load() }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 14) {
            Avatar(colorHex: person?.colorHex, emoji: person?.avatarEmoji ?? "🙂", size: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(person?.name ?? " ").font(WF.serif(28)).foregroundStyle(WF.ink)
                Text(subtitle).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            Spacer()
            if let ov = model.overview {
                VStack(alignment: .trailing, spacing: 4) {
                    ForEach(balances(ov)) { b in
                        HStack(spacing: 4) {
                            Text(b.symbol).font(.system(size: 15))
                            Text("\(b.amount)").font(.system(size: 20, weight: .heavy)).foregroundStyle(WF.ink)
                            Text(b.label.lowercased()).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                }
            }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let age = person?.age { parts.append("Age \(age)") }
        let streak = model.overview?.topStreak ?? 0
        if streak > 0 { parts.append("🔥 \(streak)-day streak") }
        return parts.isEmpty ? (person?.memberType?.capitalized ?? " ") : parts.joined(separator: " · ")
    }

    // MARK: stat cards (today's chores + featured goal)

    private var statCards: some View {
        HStack(spacing: 12) {
            statCard(title: "Today’s chores",
                     big: model.chores.isEmpty ? "None" : "\(model.choresDone) of \(model.chores.count)",
                     frac: model.chores.isEmpty ? 0 : Double(model.choresDone) / Double(model.chores.count),
                     tint: FamilyColor.wally.solid) { path.append(.chores) }
            if let g = model.overview?.goals.first {
                statCard(title: g.title,
                         big: "\(fmt(g.progress))/\(fmt(g.target))",
                         frac: Double(g.pct ?? 0) / 100,
                         tint: GoalStyle.color(g.category)) { path.append(.goal(g.asGoal)) }
            } else {
                statCard(title: "Goals", big: "—", frac: 0, tint: WF.ink3) { path.append(.goals) }
            }
        }
    }

    private func statCard(title: String, big: String, frac: Double, tint: Color, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2).lineLimit(1)
                Text(big).font(.system(size: 26, weight: .heavy)).foregroundStyle(WF.ink).lineLimit(1).minimumScaleFactor(0.7)
                ProgressBar(value: max(0, min(frac, 1)), tint: tint, track: tint.opacity(0.18))
            }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: day list (events + chores)

    private var personEvents: [SyncedEvent] {
        let today = Agenda.todayKey(sync.householdTz)
        return sync.events
            .filter { ($0.personId == personId || $0.participantIds.contains(personId)) && Agenda.dayKey($0, sync.householdTz) == today }
            .sorted(by: Agenda.before)
    }

    @ViewBuilder private var daySection: some View {
        SectionLabel(text: "\(firstName.uppercased())’S DAY")
        dayContent
    }

    @ViewBuilder private var dayContent: some View {
        let events = personEvents
        if events.isEmpty && model.chores.isEmpty {
            Text(model.loading ? "Loading…" : "Nothing scheduled today.")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3).padding(.vertical, 12)
        } else {
            VStack(spacing: 0) {
                // Events first (time on the left), then chores (a checkbox on the
                // left) so the two are visually distinct at a glance.
                ForEach(Array(events.enumerated()), id: \.element.id) { i, ev in
                    eventRow(ev)
                    if i < events.count - 1 || !model.chores.isEmpty { divider }
                }
                ForEach(Array(model.chores.enumerated()), id: \.element.id) { i, ch in
                    choreRow(ch)
                    if i < model.chores.count - 1 { divider }
                }
            }
            .padding(.vertical, 4)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
    }

    private func eventRow(_ ev: SyncedEvent) -> some View {
        Button { editingEvent = ev } label: {
            HStack(spacing: 12) {
                Text(eventTime(ev)).font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink3)
                    .frame(width: 60, alignment: .leading)
                Text(ev.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: "calendar").font(.system(size: 14)).foregroundStyle(WF.ink3)
            }
            .padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choreRow(_ ch: WaffledAPI.ChoreInstanceDTO) -> some View {
        let done = ch.status == "done"
        let awaiting = ch.status == "awaiting"
        return Button { Task { await model.toggleChore(ch) } } label: {
            HStack(spacing: 12) {
                Image(systemName: awaiting ? "hourglass.circle.fill" : (done ? "checkmark.circle.fill" : "circle"))
                    .font(.system(size: 22))
                    .foregroundStyle(done ? FamilyColor.wally.solid : (awaiting ? WF.gold : WF.ink3))
                Text("\(ch.emoji.map { "\($0) " } ?? "")\(ch.choreTitle)")
                    .font(.system(size: 15, weight: .semibold))
                    .strikethrough(done, color: WF.ink3)
                    .foregroundStyle(done ? WF.ink3 : WF.ink).lineLimit(1)
                Spacer(minLength: 8)
                if ch.rewardAmount > 0 {
                    HStack(spacing: 2) {
                        Text(sync.currencySymbol(ch.rewardCurrency)).font(.system(size: 11))
                        Text("\(ch.rewardAmount)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var divider: some View { Rectangle().fill(WF.hair2).frame(height: 1).padding(.leading, 14) }

    // MARK: whole-person balance

    private func balanceCard(_ ov: WaffledAPI.PersonOverview) -> some View {
        card("Whole-person balance") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(ov.categoryBalance) { c in
                        VStack(spacing: 5) {
                            GoalRing(value: Double(c.avgPct) / 100, size: 52, lineWidth: 5,
                                     stroke: c.goalCount > 0 ? GoalStyle.color(c.category) : WF.hair,
                                     track: WF.hair) {
                                Text(c.emoji).font(.system(size: 18)).opacity(c.goalCount > 0 ? 1 : 0.4)
                            }
                            Text(c.label).font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink2)
                            Text(c.goalCount > 0 ? "\(c.goalCount) goal\(c.goalCount == 1 ? "" : "s")" : "none yet")
                                .font(.system(size: 10, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                        .frame(width: 64)
                    }
                }
            }
            if let insight = ov.insight, !insight.text.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "sparkles").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ai).padding(.top, 1)
                    Text(insight.text).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.ai)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(11).frame(maxWidth: .infinity, alignment: .leading)
                .background(WF.ai.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
            }
        }
    }

    // MARK: goals

    private func goalsCard(_ ov: WaffledAPI.PersonOverview) -> some View {
        card("\(firstName)’s goals") {
            VStack(spacing: 12) {
                ForEach(ov.goals) { g in
                    let c = GoalStyle.color(g.category)
                    Button { path.append(.goal(g.asGoal)) } label: {
                    VStack(spacing: 6) {
                        HStack(spacing: 9) {
                            Text(g.emoji ?? GoalStyle.emoji(g.category)).font(.system(size: 17))
                            Text(g.title).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                            if let cat = g.category {
                                Text(cat.capitalized).font(.system(size: 10, weight: .heavy))
                                    .foregroundStyle(c).padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(c.opacity(0.14)).clipShape(Capsule())
                            }
                            Spacer(minLength: 6)
                            Text("\(fmt(g.progress))/\(fmt(g.target))\(g.unit.map { " \($0)" } ?? "")")
                                .font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2).lineLimit(1)
                        }
                        ProgressBar(value: Double(g.pct ?? 0) / 100, tint: c, track: WF.hair)
                    }
                    .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: stars & redemptions

    private func starsCard(_ ov: WaffledAPI.PersonOverview) -> some View {
        card("Currencies & chores") {
            // Balances scroll horizontally so the action pills always keep their room
            // (never squeezed into mid-word wraps like "Awar/d").
            HStack(spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 16) {
                        ForEach(balances(ov)) { b in
                            HStack(spacing: 4) {
                                Text(b.symbol).font(.system(size: 15))
                                Text("\(b.amount)").font(.system(size: 20, weight: .heavy)).foregroundStyle(b.color)
                                Text(b.label.lowercased()).font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(WF.ink3).fixedSize()
                            }
                        }
                    }
                }
                if sync.can("reward.grant") {
                    Button { showAward = true } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "star.fill").font(.system(size: 11, weight: .bold))
                            Text("Award").font(.system(size: 13, weight: .bold)).lineLimit(1)
                        }
                        .foregroundStyle(WF.gold)
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(WF.gold.opacity(0.16)).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).fixedSize()
                }
                if !model.conversions.isEmpty {
                    Button { showTrade = true } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.left.arrow.right").font(.system(size: 12, weight: .bold))
                            Text("Trade").font(.system(size: 13, weight: .bold)).lineLimit(1)
                        }
                        .foregroundStyle(WF.ai)
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(WF.ai.opacity(0.12)).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).fixedSize()
                }
            }
            if !ov.recentLedger.isEmpty {
                SectionLabel(text: "Recent")
                VStack(spacing: 0) {
                    ForEach(Array(ov.recentLedger.prefix(6).enumerated()), id: \.element.id) { i, e in
                        HStack(spacing: 8) {
                            Text("\(e.amount >= 0 ? "+" : "")\(e.amount)")
                                .font(.system(size: 13, weight: .heavy))
                                .foregroundStyle(e.amount >= 0 ? FamilyColor.wally.solid : WF.primary)
                                .frame(width: 38, alignment: .leading)
                            Text(symbol(for: e.currency)).font(.system(size: 11))
                            Text(e.label)
                                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                            Spacer()
                        }
                        .padding(.vertical, 7)
                        if i < min(ov.recentLedger.count, 6) - 1 { Rectangle().fill(WF.hair2).frame(height: 1) }
                    }
                }
            }
        }
    }

    private func redemptionsCard(_ ov: WaffledAPI.PersonOverview) -> some View {
        card("Reward redemptions") {
            VStack(spacing: 0) {
                ForEach(Array(ov.redemptions.enumerated()), id: \.element.id) { i, r in
                    HStack(spacing: 9) {
                        Text(r.emoji ?? "🎁").font(.system(size: 16))
                        Text(r.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                        Spacer(minLength: 6)
                        Text(r.status.capitalized).font(.system(size: 10, weight: .heavy))
                            .foregroundStyle(r.status == "approved" ? FamilyColor.wally.solid : WF.ink3)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background((r.status == "approved" ? FamilyColor.wally.solid : WF.ink3).opacity(0.14)).clipShape(Capsule())
                        HStack(spacing: 2) {
                            Text(symbol(for: r.currency)).font(.system(size: 11))
                            Text("\(r.cost)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                        }
                    }
                    .padding(.vertical, 8)
                    if i < ov.redemptions.count - 1 { Rectangle().fill(WF.hair2).frame(height: 1) }
                }
            }
        }
    }

    // MARK: add button + helpers

    private var addButton: some View {
        Button { showCapture = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus").font(.system(size: 15, weight: .bold))
                Text("Add something for \(firstName)").font(.system(size: 16, weight: .bold))
            }
            .foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 15)
            .background(WF.primary).clipShape(Capsule())
        }
        .buttonStyle(.plain).padding(.top, 4)
    }

    private func card<V: View>(_ title: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
            content()
        }
        .padding(15).frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func eventTime(_ ev: SyncedEvent) -> String {
        if ev.allDay { return "All day" }
        if let d = ev.startsAt { return EventTime.timeLabel(d, sync.householdTz) }
        return "—"
    }
    private func fmt(_ n: Double?) -> String {
        guard let n else { return "—" }
        return n == n.rounded() ? String(Int(n)) : String(format: "%g", n)
    }
}

/// Pick which reward a person is saving toward (or clear it). Anyone can set their
/// own per the backend; on a parent's phone you set it for the kid. Lists the
/// household catalog with this person's progress toward each. Shared by the person
/// spotlight and the reward shop.
struct SavingTowardPicker: View {
    let rewards: [WaffledAPI.PersonOverview.ShopReward]
    let currencies: [WaffledAPI.PersonOverview.Currency]
    let current: String?
    let onPick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 8) {
                    row(emoji: "🚫", title: "Not saving toward anything", sub: nil,
                        selected: current == nil, tint: WF.ink3) { onPick(nil); dismiss() }
                    ForEach(rewards) { r in
                        let cur = currencies.first { $0.key == r.currency }
                        let sym = cur?.symbol ?? "⭐"
                        row(emoji: r.emoji ?? "🎁", title: r.title,
                            sub: r.have >= r.cost ? "Can afford · \(sym)\(r.cost)" : "\(r.toGo) to go · \(sym)\(r.cost)",
                            selected: current == r.id, tint: Color(hexString: cur?.color) ?? WF.ai) {
                            onPick(r.id); dismiss()
                        }
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Saving toward").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func row(emoji: String, title: String, sub: String?, selected: Bool, tint: Color,
                     tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 12) {
                WaffledEmojiTile(emoji: emoji, background: tint.opacity(0.14), cornerRadius: 11)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    if let sub { Text(sub).font(.system(size: 12)).foregroundStyle(WF.ink3) }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 20)).foregroundStyle(WF.ai)
                }
            }
            .padding(12)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(selected ? WF.ai.opacity(0.4) : WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// Trade a person's balance through a household conversion rate — the web's
/// TradeModal. Anyone can convert their own; a parent does it for a kid here.
struct TradeSheet: View {
    let personName: String
    let personId: String
    let currencies: [WaffledAPI.PersonOverview.Currency]
    let balances: [WaffledAPI.PersonOverview.Balance]
    let conversions: [WaffledAPI.Conversion]
    let onDone: () async -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var convId: String
    @State private var times = 1
    @State private var busy = false
    @State private var error: String?

    init(personName: String, personId: String, currencies: [WaffledAPI.PersonOverview.Currency],
         balances: [WaffledAPI.PersonOverview.Balance], conversions: [WaffledAPI.Conversion],
         onDone: @escaping () async -> Void) {
        self.personName = personName; self.personId = personId
        self.currencies = currencies; self.balances = balances; self.conversions = conversions
        self.onDone = onDone
        _convId = State(initialValue: conversions.first?.id ?? "")
    }

    private var conv: WaffledAPI.Conversion? { conversions.first { $0.id == convId } }
    private var have: Int { conv.flatMap { c in balances.first { $0.currency == c.fromCurrency }?.balance } ?? 0 }
    private var cost: Int { (conv?.fromAmount ?? 0) * times }
    private var gain: Int { (conv?.toAmount ?? 0) * times }
    private var afford: Bool { conv != nil && have >= cost && times > 0 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Trade currencies").font(WF.serif(22)).foregroundStyle(WF.ink)
                        Text("for \(personName)").font(.system(size: 13)).foregroundStyle(WF.ink3)
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Trade")
                        Menu {
                            ForEach(conversions) { c in
                                Button("\(c.fromAmount) \(c.from.symbol ?? "•") → \(c.toAmount) \(c.to.symbol ?? "•")") { convId = c.id }
                            }
                        } label: {
                            HStack {
                                if let c = conv {
                                    Text("\(c.fromAmount) \(c.from.symbol ?? "•") \(c.from.label ?? c.fromCurrency)  →  \(c.toAmount) \(c.to.symbol ?? "•") \(c.to.label ?? c.toCurrency)")
                                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                                } else { Text("Pick a rate").foregroundStyle(WF.ink3) }
                                Spacer()
                                Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "How many times")
                        HStack(spacing: 14) {
                            Button { times = max(1, times - 1) } label: { stepGlyph("minus") }
                            Text("\(times)").font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink).frame(minWidth: 30)
                            Button { times += 1 } label: { stepGlyph("plus") }
                        }
                    }

                    if let c = conv {
                        HStack(spacing: 10) {
                            Text("−\(cost) \(c.from.symbol ?? "•")").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.primary)
                            Image(systemName: "arrow.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                            Text("+\(gain) \(c.to.symbol ?? "•")").font(.system(size: 16, weight: .heavy)).foregroundStyle(FamilyColor.wally.solid)
                            Spacer()
                            Text("has \(have) \(c.from.symbol ?? "•")").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                        .padding(14).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }

                    if !afford, conv != nil {
                        Text("Not enough \(conv?.from.label ?? "currency") to trade \(times)×.")
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary)
                    }
                    if let error { Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary) }

                    Button { Task { await trade() } } label: {
                        Text(busy ? "Trading…" : "Trade").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(afford ? WF.primary : WF.ink3)
                            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(busy || !afford)
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Trade").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func stepGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
            .frame(width: 36, height: 36).background(WF.panel).clipShape(Circle())
    }

    private func trade() async {
        busy = true; error = nil
        let result = await sync.applyConversion(id: convId, personId: personId, times: times)
        busy = false
        if result.ok { await onDone(); dismiss() }
        else { error = friendly(result.error) }
    }

    private func friendly(_ e: String?) -> String {
        guard let e else { return "Couldn’t complete that trade." }
        return e.contains("not enough") ? "Not enough to trade that many times." : "Couldn’t complete that trade."
    }
}

/// Ad-hoc "spot-award": a parent hands a person stars on the spot ("5 stars for
/// being so helpful today"), untied to any chore — the web's AwardModal. Gated by
/// `reward.grant` at the call site; writes a positive ledger entry and advances the
/// recipient's saving-toward jar. Whole numbers only.
struct AwardStarsSheet: View {
    let personName: String
    let personId: String
    let currencies: [WaffledAPI.PersonOverview.Currency]
    let onDone: () async -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var amount = 5
    @State private var currency: String
    @State private var note = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var noteFocused: Bool

    init(personName: String, personId: String,
         currencies: [WaffledAPI.PersonOverview.Currency], onDone: @escaping () async -> Void) {
        self.personName = personName; self.personId = personId
        self.currencies = currencies; self.onDone = onDone
        let def = currencies.first { $0.isDefault } ?? currencies.first
        _currency = State(initialValue: def?.key ?? "stars")
    }

    private var cur: WaffledAPI.PersonOverview.Currency? { currencies.first { $0.key == currency } }
    private var symbol: String { cur?.symbol ?? "⭐" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Award stars").font(WF.serif(22)).foregroundStyle(WF.ink)
                        Text("to \(personName)").font(.system(size: 13)).foregroundStyle(WF.ink3)
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
                                    ForEach(currencies) { c in
                                        Button("\(c.symbol) \(c.label)") { currency = c.key }
                                    }
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
                            .font(.system(size: 15))
                            .focused($noteFocused)
                            .submitLabel(.done)
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }

                    if let error { Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary) }

                    Button { Task { await award() } } label: {
                        Text(busy ? "Awarding…" : "Award \(amount) \(symbol)")
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(amount > 0 ? WF.primary : WF.ink3)
                            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(busy || amount <= 0)
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Award stars").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            // Land in the note so a parent can just type the reason.
            .task { try? await Task.sleep(for: .milliseconds(350)); noteFocused = true }
        }
    }

    private func stepGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
            .frame(width: 36, height: 36).background(WF.panel).clipShape(Circle())
    }

    private func award() async {
        guard amount > 0 else { return }
        busy = true; error = nil
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let ok = await sync.awardSpot(personId: personId, amount: amount, currency: currency,
                                      note: trimmed.isEmpty ? nil : trimmed)
        busy = false
        if ok { await onDone(); dismiss() }
        else { error = "Couldn’t award those stars. Try again." }
    }
}
