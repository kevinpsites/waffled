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
    @State private var model: PersonOverviewModel
    @State private var showCapture = false
    @State private var editingEvent: SyncedEvent?

    init(personId: String) {
        self.personId = personId
        _model = State(initialValue: PersonOverviewModel(personId: personId))
    }

    private var person: NookAPI.PersonOverview.Person? { model.overview?.person }
    private var firstName: String { (person?.name ?? "").split(separator: " ").first.map(String.init) ?? (person?.name ?? "") }
    private var color: Color { Color(hexString: person?.colorHex) ?? NK.ink3 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                statCards
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
        .refreshable { await model.load() }
        .sheet(isPresented: $showCapture) { CaptureSheet().presentationDragIndicator(.visible) }
        .sheet(item: $editingEvent) { ev in EventEditSheet(event: ev, initialDate: ev.startsAt ?? Date()) }
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
            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    Image(systemName: "star.fill").font(.system(size: 16)).foregroundStyle(NK.gold)
                    Text("\(model.overview?.stars ?? 0)").font(.system(size: 22, weight: .heavy)).foregroundStyle(NK.ink)
                }
                Text("stars").font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
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
                     tint: FamilyColor.wally.solid)
            if let g = model.overview?.goals.first {
                statCard(title: g.title,
                         big: "\(fmt(g.progress))/\(fmt(g.target))",
                         frac: Double(g.pct) / 100,
                         tint: GoalStyle.color(g.category))
            } else {
                statCard(title: "Goals", big: "—", frac: 0, tint: NK.ink3)
            }
        }
    }

    private func statCard(title: String, big: String, frac: Double, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink2).lineLimit(1)
            Text(big).font(.system(size: 26, weight: .heavy)).foregroundStyle(NK.ink).lineLimit(1).minimumScaleFactor(0.7)
            ProgressBar(value: max(0, min(frac, 1)), tint: tint, track: tint.opacity(0.18))
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
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
                ForEach(Array(events.enumerated()), id: \.element.id) { i, ev in
                    dayRow(time: eventTime(ev), title: ev.title, trailing: .event) { editingEvent = ev }
                    if i < events.count - 1 || !model.chores.isEmpty { divider }
                }
                ForEach(Array(model.chores.enumerated()), id: \.element.id) { i, ch in
                    dayRow(time: "—", title: "\(ch.emoji.map { "\($0) " } ?? "")\(ch.choreTitle)",
                           trailing: ch.status == "done" ? .choreDone : .chorePending) {
                        Task { await model.toggleChore(ch) }
                    }
                    if i < model.chores.count - 1 { divider }
                }
            }
            .padding(.vertical, 4)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    private enum DayTrailing { case event, choreDone, chorePending }

    private func dayRow(time: String, title: String, trailing: DayTrailing, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 12) {
                Text(time).font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink3)
                    .frame(width: 64, alignment: .leading)
                Text(title).font(.system(size: 15, weight: .semibold))
                    .strikethrough(trailing == .choreDone, color: NK.ink3)
                    .foregroundStyle(trailing == .choreDone ? NK.ink3 : NK.ink).lineLimit(1)
                Spacer(minLength: 8)
                switch trailing {
                case .event: Image(systemName: "calendar").font(.system(size: 15)).foregroundStyle(NK.ink3)
                case .choreDone: Image(systemName: "checkmark.circle.fill").font(.system(size: 20)).foregroundStyle(FamilyColor.wally.solid)
                case .chorePending: Image(systemName: "circle").font(.system(size: 20)).foregroundStyle(NK.ink3)
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
                        ProgressBar(value: Double(g.pct) / 100, tint: c, track: NK.hair)
                    }
                }
            }
        }
    }

    // MARK: stars & redemptions

    private func starsCard(_ ov: NookAPI.PersonOverview) -> some View {
        card("Stars & chores") {
            HStack(spacing: 4) {
                Image(systemName: "star.fill").font(.system(size: 15)).foregroundStyle(NK.gold)
                Text("\(ov.stars)").font(.system(size: 20, weight: .heavy)).foregroundStyle(FamilyColor.lottie.solid)
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
                            Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(NK.gold)
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
                            Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(NK.gold)
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
