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
    private(set) var overview: NookAPI.PersonOverview?
    private(set) var chores: [NookAPI.ChoreInstanceDTO] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = NookAPI()
    init(personId: String) { self.personId = personId }

    func load() async {
        async let o = api.personOverview(id: personId)
        async let c = api.choreInstances(date: ChoreDates.today())
        do {
            overview = try await o
            chores = (try await c).filter { $0.personId == personId }
            error = false
        } catch { self.error = true }
        loading = false
    }

    var choresDone: Int { chores.filter { $0.status == "done" }.count }

    /// Optimistic complete/uncomplete from the day list.
    func toggleChore(_ inst: NookAPI.ChoreInstanceDTO) async {
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

    init(personId: String, path: Binding<[HubRoute]>) {
        self.personId = personId
        _path = path
        _model = State(initialValue: PersonOverviewModel(personId: personId))
    }

    private var person: NookAPI.PersonOverview.Person? { model.overview?.person }
    private var firstName: String { (person?.name ?? "").split(separator: " ").first.map(String.init) ?? (person?.name ?? "") }
    private var color: Color { Color(hexString: person?.colorHex) ?? NK.ink3 }

    /// A person's balances joined to their currency definitions (symbol + color),
    /// in the household's currency order — supports custom currencies, not just stars.
    private struct CurBal: Identifiable { let key, symbol, label: String; let color: Color; let amount, sort: Int; var id: String { key } }
    private func balances(_ ov: NookAPI.PersonOverview) -> [CurBal] {
        let defs = Dictionary(ov.currencies.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        return ov.balances.compactMap { b -> CurBal? in
            guard let d = defs[b.currency] else { return nil }
            return CurBal(key: d.key, symbol: d.symbol, label: d.label,
                          color: Color(hexString: d.color) ?? NK.gold, amount: b.balance, sort: d.sortOrder)
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
                if let ov = model.overview { savingTowardCard(ov) }
                daySection
                if let ov = model.overview {
                    if ov.categoryBalance.contains(where: { $0.goalCount > 0 }) { balanceCard(ov) }
                    if !ov.goals.isEmpty { goalsCard(ov) }
                    starsCard(ov)
                    if !ov.redemptions.isEmpty { redemptionsCard(ov) }
                }
                addButton
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        .background(NK.canvas)
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
    }

    // MARK: saving toward

    @ViewBuilder private func savingTowardCard(_ ov: NookAPI.PersonOverview) -> some View {
        NookCard(padding: 14) {
            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Text("Saving toward").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink2)
                    Spacer()
                    if ov.savingToward != nil {
                        Button("Change") { showSavingPicker = true }
                            .font(.system(size: 13, weight: .semibold)).tint(NK.ai)
                            .disabled(ov.rewardShop.isEmpty)
                    }
                }
                if let s = ov.savingToward {
                    let cur = ov.currencies.first { $0.key == s.currency }
                    let tint = Color(hexString: cur?.color) ?? NK.ai
                    HStack(spacing: 11) {
                        Text(s.emoji ?? "🎁").font(.system(size: 24))
                            .frame(width: 46, height: 46).background(tint.opacity(0.14))
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        VStack(alignment: .leading, spacing: 5) {
                            Text(s.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                            ProgressBar(value: max(0.02, Double(s.pct) / 100), tint: tint, track: NK.hair)
                            Text("\(s.have) of \(s.cost) \(cur?.label.lowercased() ?? "")")
                                .font(.system(size: 12, weight: .medium)).foregroundStyle(NK.ink3)
                        }
                    }
                } else {
                    Button { showSavingPicker = true } label: {
                        HStack(spacing: 9) {
                            Image(systemName: "target").font(.system(size: 15)).foregroundStyle(NK.ai)
                            Text(ov.rewardShop.isEmpty ? "No rewards yet" : "Pick a reward to save toward")
                                .font(.system(size: 14, weight: .medium)).foregroundStyle(NK.ink2)
                            Spacer()
                            if !ov.rewardShop.isEmpty {
                                Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(ov.rewardShop.isEmpty)
                }
            }
        }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 14) {
            Avatar(colorHex: person?.colorHex, emoji: person?.avatarEmoji ?? "🙂", size: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(person?.name ?? " ").font(NK.serif(28)).foregroundStyle(NK.ink)
                Text(subtitle).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            Spacer()
            if let ov = model.overview {
                VStack(alignment: .trailing, spacing: 4) {
                    ForEach(balances(ov)) { b in
                        HStack(spacing: 4) {
                            Text(b.symbol).font(.system(size: 15))
                            Text("\(b.amount)").font(.system(size: 20, weight: .heavy)).foregroundStyle(NK.ink)
                            Text(b.label.lowercased()).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
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
                statCard(title: "Goals", big: "—", frac: 0, tint: NK.ink3) { path.append(.goals) }
            }
        }
    }

    private func statCard(title: String, big: String, frac: Double, tint: Color, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink2).lineLimit(1)
                Text(big).font(.system(size: 26, weight: .heavy)).foregroundStyle(NK.ink).lineLimit(1).minimumScaleFactor(0.7)
                ProgressBar(value: max(0, min(frac, 1)), tint: tint, track: tint.opacity(0.18))
            }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
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
        let events = personEvents
        SectionLabel(text: "\(firstName.uppercased())’S DAY")
        if events.isEmpty && model.chores.isEmpty {
            Text(model.loading ? "Loading…" : "Nothing scheduled today.")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3).padding(.vertical, 12)
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
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    private func eventRow(_ ev: SyncedEvent) -> some View {
        Button { editingEvent = ev } label: {
            HStack(spacing: 12) {
                Text(eventTime(ev)).font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink3)
                    .frame(width: 60, alignment: .leading)
                Text(ev.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: "calendar").font(.system(size: 14)).foregroundStyle(NK.ink3)
            }
            .padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choreRow(_ ch: NookAPI.ChoreInstanceDTO) -> some View {
        let done = ch.status == "done"
        let awaiting = ch.status == "awaiting"
        return Button { Task { await model.toggleChore(ch) } } label: {
            HStack(spacing: 12) {
                Image(systemName: awaiting ? "hourglass.circle.fill" : (done ? "checkmark.circle.fill" : "circle"))
                    .font(.system(size: 22))
                    .foregroundStyle(done ? FamilyColor.wally.solid : (awaiting ? NK.gold : NK.ink3))
                Text("\(ch.emoji.map { "\($0) " } ?? "")\(ch.choreTitle)")
                    .font(.system(size: 15, weight: .semibold))
                    .strikethrough(done, color: NK.ink3)
                    .foregroundStyle(done ? NK.ink3 : NK.ink).lineLimit(1)
                Spacer(minLength: 8)
                if ch.rewardAmount > 0 {
                    HStack(spacing: 2) {
                        Text(sync.currencySymbol(ch.rewardCurrency)).font(.system(size: 11))
                        Text("\(ch.rewardAmount)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var divider: some View { Rectangle().fill(NK.hair2).frame(height: 1).padding(.leading, 14) }

    // MARK: whole-person balance

    private func balanceCard(_ ov: NookAPI.PersonOverview) -> some View {
        card("Whole-person balance") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(ov.categoryBalance) { c in
                        VStack(spacing: 5) {
                            GoalRing(value: Double(c.avgPct) / 100, size: 52, lineWidth: 5,
                                     stroke: c.goalCount > 0 ? GoalStyle.color(c.category) : NK.hair,
                                     track: NK.hair) {
                                Text(c.emoji).font(.system(size: 18)).opacity(c.goalCount > 0 ? 1 : 0.4)
                            }
                            Text(c.label).font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink2)
                            Text(c.goalCount > 0 ? "\(c.goalCount) goal\(c.goalCount == 1 ? "" : "s")" : "none yet")
                                .font(.system(size: 10, weight: .semibold)).foregroundStyle(NK.ink3)
                        }
                        .frame(width: 64)
                    }
                }
            }
            if let insight = ov.insight, !insight.text.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "sparkles").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ai).padding(.top, 1)
                    Text(insight.text).font(.system(size: 12.5, weight: .medium)).foregroundStyle(NK.ai)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(11).frame(maxWidth: .infinity, alignment: .leading)
                .background(NK.ai.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
            }
        }
    }

    // MARK: goals

    private func goalsCard(_ ov: NookAPI.PersonOverview) -> some View {
        card("\(firstName)’s goals") {
            VStack(spacing: 12) {
                ForEach(ov.goals) { g in
                    let c = GoalStyle.color(g.category)
                    Button { path.append(.goal(g.asGoal)) } label: {
                    VStack(spacing: 6) {
                        HStack(spacing: 9) {
                            Text(g.emoji ?? GoalStyle.emoji(g.category)).font(.system(size: 17))
                            Text(g.title).font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                            if let cat = g.category {
                                Text(cat.capitalized).font(.system(size: 10, weight: .heavy))
                                    .foregroundStyle(c).padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(c.opacity(0.14)).clipShape(Capsule())
                            }
                            Spacer(minLength: 6)
                            Text("\(fmt(g.progress))/\(fmt(g.target))\(g.unit.map { " \($0)" } ?? "")")
                                .font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2).lineLimit(1)
                        }
                        ProgressBar(value: Double(g.pct ?? 0) / 100, tint: c, track: NK.hair)
                    }
                    .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: stars & redemptions

    private func starsCard(_ ov: NookAPI.PersonOverview) -> some View {
        card("Currencies & chores") {
            HStack(spacing: 16) {
                ForEach(balances(ov)) { b in
                    HStack(spacing: 4) {
                        Text(b.symbol).font(.system(size: 15))
                        Text("\(b.amount)").font(.system(size: 20, weight: .heavy)).foregroundStyle(b.color)
                        Text(b.label.lowercased()).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                }
            }
            if !ov.recentLedger.isEmpty {
                SectionLabel(text: "Recent")
                VStack(spacing: 0) {
                    ForEach(Array(ov.recentLedger.prefix(6).enumerated()), id: \.element.id) { i, e in
                        HStack(spacing: 8) {
                            Text("\(e.amount >= 0 ? "+" : "")\(e.amount)")
                                .font(.system(size: 13, weight: .heavy))
                                .foregroundStyle(e.amount >= 0 ? FamilyColor.wally.solid : NK.primary)
                                .frame(width: 38, alignment: .leading)
                            Text(symbol(for: e.currency)).font(.system(size: 11))
                            Text(e.detail ?? e.reason.replacingOccurrences(of: "_", with: " "))
                                .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                            Spacer()
                        }
                        .padding(.vertical, 7)
                        if i < min(ov.recentLedger.count, 6) - 1 { Rectangle().fill(NK.hair2).frame(height: 1) }
                    }
                }
            }
        }
    }

    private func redemptionsCard(_ ov: NookAPI.PersonOverview) -> some View {
        card("Reward redemptions") {
            VStack(spacing: 0) {
                ForEach(Array(ov.redemptions.enumerated()), id: \.element.id) { i, r in
                    HStack(spacing: 9) {
                        Text(r.emoji ?? "🎁").font(.system(size: 16))
                        Text(r.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                        Spacer(minLength: 6)
                        Text(r.status.capitalized).font(.system(size: 10, weight: .heavy))
                            .foregroundStyle(r.status == "approved" ? FamilyColor.wally.solid : NK.ink3)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background((r.status == "approved" ? FamilyColor.wally.solid : NK.ink3).opacity(0.14)).clipShape(Capsule())
                        HStack(spacing: 2) {
                            Text(symbol(for: r.currency)).font(.system(size: 11))
                            Text("\(r.cost)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                        }
                    }
                    .padding(.vertical, 8)
                    if i < ov.redemptions.count - 1 { Rectangle().fill(NK.hair2).frame(height: 1) }
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
            .background(NK.primary).clipShape(Capsule())
        }
        .buttonStyle(.plain).padding(.top, 4)
    }

    private func card<V: View>(_ title: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
            content()
        }
        .padding(15).frame(maxWidth: .infinity, alignment: .leading)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
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
/// household catalog with this person's progress toward each.
private struct SavingTowardPicker: View {
    let rewards: [NookAPI.PersonOverview.ShopReward]
    let currencies: [NookAPI.PersonOverview.Currency]
    let current: String?
    let onPick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 8) {
                    row(emoji: "🚫", title: "Not saving toward anything", sub: nil,
                        selected: current == nil, tint: NK.ink3) { onPick(nil); dismiss() }
                    ForEach(rewards) { r in
                        let cur = currencies.first { $0.key == r.currency }
                        let sym = cur?.symbol ?? "⭐"
                        row(emoji: r.emoji ?? "🎁", title: r.title,
                            sub: r.have >= r.cost ? "Can afford · \(sym)\(r.cost)" : "\(r.toGo) to go · \(sym)\(r.cost)",
                            selected: current == r.id, tint: Color(hexString: cur?.color) ?? NK.ai) {
                            onPick(r.id); dismiss()
                        }
                    }
                }
                .padding(16)
            }
            .background(NK.canvas)
            .navigationTitle("Saving toward").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func row(emoji: String, title: String, sub: String?, selected: Bool, tint: Color,
                     tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 12) {
                Text(emoji).font(.system(size: 22)).frame(width: 42, height: 42)
                    .background(tint.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    if let sub { Text(sub).font(.system(size: 12)).foregroundStyle(NK.ink3) }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 20)).foregroundStyle(NK.ai)
                }
            }
            .padding(12)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                .strokeBorder(selected ? NK.ai.opacity(0.4) : NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
