import SwiftUI
import Observation
import UIKit

/// Goals — the membership model from the web kiosk, folded onto one phone screen:
/// a horizontal list-picker (Family / each person) up top, an All/Shared/Each
/// filter, the featured "hero" goal, then a stack of "more" goal cards. Tapping a
/// hero/card opens the Log sheet. Online-only (goals aren't a synced table).
@MainActor
@Observable
final class GoalsModel {
    enum Filter: Hashable { case all, shared, each }

    private(set) var lists: [WaffledAPI.GoalList] = []
    private(set) var goals: [WaffledAPI.Goal] = []
    private(set) var loading = true
    private(set) var error = false
    var selectedListId: String?
    var filter: Filter = .all

    private let api = WaffledAPI()

    var selectedList: WaffledAPI.GoalList? { lists.first { $0.id == selectedListId } ?? lists.first }
    var isIndividual: Bool { (selectedList?.members.count ?? 0) == 1 }

    /// Goals after the All/Shared/Each filter (the filter only applies to shared lists).
    var visibleGoals: [WaffledAPI.Goal] {
        goals.filter { g in
            isIndividual || filter == .all
                || (filter == .shared ? g.trackingMode == "shared_total" : g.trackingMode == "each_tracks")
        }
    }
    // Three tiers (mirrors web): the one Spotlight hero, the Pinned band, then everything else
    // A–Z (the API already sorts A–Z). `isFeatured` is the internal flag behind "Pinned".
    var spotlight: WaffledAPI.Goal? { visibleGoals.first { $0.isSpotlight ?? false } }
    var pinned: [WaffledAPI.Goal] { visibleGoals.filter { $0.isFeatured && !($0.isSpotlight ?? false) } }
    var more: [WaffledAPI.Goal] { visibleGoals.filter { !($0.isSpotlight ?? false) && !$0.isFeatured } }

    func loadLists() async {
        loading = true
        do {
            lists = try await api.goalLists()
            if selectedListId == nil || !lists.contains(where: { $0.id == selectedListId }) {
                selectedListId = lists.first?.id
            }
            error = false
            await loadGoals()
        } catch { self.error = true }
        loading = false
    }

    func select(_ id: String) async {
        guard id != selectedListId else { return }
        selectedListId = id
        filter = .all
        await loadGoals()
    }

    func loadGoals() async {
        guard let id = selectedList?.id else { goals = []; return }
        do { goals = try await api.goalsIn(listId: id); error = false }
        catch { self.error = true }
    }

    /// Quick pin/unpin: toggle the Pinned tier (isFeatured) straight from a card.
    func togglePin(_ g: WaffledAPI.Goal) async {
        do { try await api.updateGoal(id: g.id, ["isFeatured": .bool(!g.isFeatured)]); await loadGoals() }
        catch { self.error = true }
    }

    func log(goalId: String, amount: Double, personIds: [String], note: String, loggedOn: String?, hours: Int? = nil, minutes: Int? = nil) async {
        do {
            try await api.logGoalProgress(goalId: goalId, amount: amount, personIds: personIds, note: note, loggedOn: loggedOn, hours: hours, minutes: minutes)
            await loadGoals()
        } catch { self.error = true }
    }

    /// Push today's Apple Health total for **every** health-linked goal in the household —
    /// not just the visible list, so a linked goal in another list fills too — then refresh
    /// the current list. iPhone-only; a no-op when HealthKit is unavailable or nothing is
    /// linked. Best-effort; the server upsert is idempotent, so re-running is safe.
    func syncHealth() async {
        guard HealthKitBridge.shared.isAvailable else { return }
        let all = (try? await api.goalsIn(listId: nil)) ?? []
        let linked = all.compactMap { g -> (id: String, metric: HealthKitBridge.Metric, start: Date?)? in
            HealthKitBridge.Metric(key: g.healthMetric).map { (g.id, $0, HealthKitBridge.parseTimestamp(g.createdAt)) }
        }
        guard !linked.isEmpty else { return }
        try? await HealthKitBridge.shared.requestReadAuthorization()
        // Catch up only the days since each goal's synced-through mark (a two-week absence
        // fills all fourteen days on the next open), floored at the goal's start so a brand-new
        // goal never pulls pre-creation steps. Then advance the mark to today.
        let today = Date()
        var didSync = false
        for l in linked {
            let days = HealthKitBridge.daysToSync(syncedThrough: HealthSyncMark.get(l.id, l.metric), today: today, notBefore: l.start)
            for d in days {
                if await HealthKitBridge.pushDay(api, goalId: l.id, metric: l.metric, day: d.day, key: d.key) { didSync = true }
            }
            HealthSyncMark.set(l.id, l.metric, today)
        }
        if didSync { await loadGoals() }
    }

    /// Create a goal, then reselect its list so it shows up. Returns success.
    func create(_ body: [String: JSONValue], listId: String?) async -> Bool {
        do {
            try await api.createGoal(body)
            if let listId { selectedListId = listId }
            await loadLists()
            return true
        } catch { self.error = true; return false }
    }
}

// MARK: category styling (mirror the web CATEGORIES → person palette)

enum GoalStyle {
    static func color(_ key: String?) -> Color {
        switch key {
        case "physical":     return FamilyColor.person3.solid
        case "intellectual": return FamilyColor.person1.solid
        case "spiritual":    return FamilyColor.person4.solid
        case "creative":     return FamilyColor.person2.solid
        case "social":       return WF.gold
        default:             return WF.primary
        }
    }
    static func emoji(_ key: String?) -> String {
        switch key {
        case "physical": return "🏃"
        case "intellectual": return "📚"
        case "spiritual": return "🧘"
        case "creative": return "🎨"
        case "social": return "🤝"
        default: return "🎯"
        }
    }
}

// MARK: small shared helpers

func goalFirstName(_ name: String) -> String { name.split(separator: " ").first.map(String.init) ?? name }

/// Whole numbers without a decimal, otherwise rounded to at most 2 decimals with
/// trailing zeros dropped (3 → "3", 1.5 → "1.5", 2.5833… → "2.58", 6.16667 → "6.17");
/// nil → em dash. Amounts are stored exact (an hours+minutes log is 1h5m = 1.0833… h),
/// so every display goes through here to avoid showing the raw repeating decimal.
func goalFmt(_ n: Double?) -> String {
    guard let n else { return "—" }
    let r = (n * 100).rounded() / 100
    return r == r.rounded() ? String(Int(r)) : String(format: "%g", r)
}

/// Compact, rounded formatting for the tight goal ring: values under 1,000 round to a
/// whole number (295.99 → "296") and larger ones abbreviate (10,000 → "10K",
/// 1,234,567 → "1.2M"), so the big number stays short and readable at any magnitude
/// instead of shrinking to nothing. Ring-only — `goalFmt` still feeds the exact figures
/// elsewhere (subtitles, milestones, cards).
func ringFmt(_ n: Double?) -> String {
    guard let n else { return "—" }
    if abs(n) >= 1000 {
        return n.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }
    return String(Int(n.rounded()))
}

/// "Count · in books", "Habit · 5× a week", "Count · each logs visits".
func goalDescriptor(_ g: WaffledAPI.Goal) -> String {
    let label = ["count": "Count", "total": "Total", "habit": "Habit", "checklist": "Milestones"][g.goalType] ?? g.goalType
    let q: String
    if g.goalType == "habit" { q = "\(g.habitTargetPerPeriod ?? 0)× a \(g.habitPeriod ?? "week")" }
    else if g.trackingMode == "each_tracks" { q = "each logs \(g.unit ?? "progress")" }
    else if let u = g.unit { q = "in \(u)" }
    else { q = "shared total" }
    return "\(label) · \(q)"
}

/// A circular progress ring with arbitrary center content.
struct GoalRing<Center: View>: View {
    let value: Double
    let size: CGFloat
    let lineWidth: CGFloat
    let stroke: Color
    let track: Color
    @ViewBuilder var center: () -> Center
    var body: some View {
        ZStack {
            // Inset by half the line width so the stroke stays inside the frame
            // (a plain .stroke is centered on the path and would clip at the edges).
            Circle().inset(by: lineWidth / 2).stroke(track, lineWidth: lineWidth)
            Circle().inset(by: lineWidth / 2).trim(from: 0, to: max(0, min(value, 1)))
                .stroke(stroke, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            // Keep the centered label inside the ring: cap it to (just under) the inner
            // diameter so a long value (e.g. "295.99") shrinks to fit instead of spilling
            // past the stroke. Paired with `.minimumScaleFactor` on the value text.
            center()
                .frame(width: max(0, size - lineWidth * 2 - 10))
                .multilineTextAlignment(.center)
        }
        .frame(width: size, height: size)
    }
}

/// Overlapping member avatars (up to 4) for a goal list.
struct AvatarStack: View {
    let members: [WaffledAPI.GoalList.Member]
    var size: CGFloat = 24
    var body: some View {
        HStack(spacing: -size * 0.34) {
            ForEach(Array(members.prefix(4).enumerated()), id: \.offset) { _, m in
                Avatar(colorHex: m.colorHex, emoji: m.avatarEmoji ?? "🙂", size: size)
                    .overlay(Circle().strokeBorder(WF.canvas, lineWidth: 2))
            }
        }
    }
}

struct GoalsView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model = GoalsModel()
    @State private var logging: WaffledAPI.Goal?
    @State private var creating = false
    @State private var creatingList = false

    private static let heroGreen = LinearGradient(colors: [Color(hex: 0x2BA86B), Color(hex: 0x1C8A56)],
                                                  startPoint: .topLeading, endPoint: .bottomTrailing)
    private static let heroOrange = LinearGradient(colors: [Color(hex: 0xF3A93B), Color(hex: 0xE08A1C)],
                                                   startPoint: .topLeading, endPoint: .bottomTrailing)

    /// iPad lays the "More goals" out as a multi-column grid (vs. the phone's column).
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }
    /// Verification one-shot (WAFFLED_OPEN_GOAL): open the featured goal once.
    private static var didOpenGoal = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if isKiosk {
                    KioskPageHeader("Goals", "Log progress and keep your streaks going.") {
                        KioskHeaderButton(icon: "plus", label: "New goal") { creating = true }
                    }
                }
                listPicker
                if let list = model.selectedList { listHead(list) }
                if !model.isIndividual, model.selectedList != nil { filterSeg }
                if let s = model.spotlight {
                    SectionLabel(text: "Spotlight").padding(.top, 2)
                    hero(s)
                }
                if !model.pinned.isEmpty {
                    SectionLabel(text: "Pinned").padding(.top, 2)
                    if isKiosk {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 14, alignment: .top)],
                                  alignment: .leading, spacing: 14) {
                            ForEach(model.pinned) { moreCard($0, pinned: true) }
                        }
                    } else {
                        ForEach(model.pinned) { moreCard($0, pinned: true) }
                    }
                }
                if !model.more.isEmpty {
                    SectionLabel(text: "More \(model.selectedList?.name ?? "") goals · A–Z")
                        .padding(.top, 2)
                    if isKiosk {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 14, alignment: .top)],
                                  alignment: .leading, spacing: 14) {
                            ForEach(model.more) { moreCard($0, pinned: false) }
                        }
                    } else {
                        ForEach(model.more) { moreCard($0, pinned: false) }
                    }
                }
                if model.loading && model.visibleGoals.isEmpty {
                    WaffledLoading()
                } else if model.visibleGoals.isEmpty {
                    WaffledEmptyState(
                        emoji: model.error ? "😕" : "🎯",
                        title: model.error ? "Couldn’t load goals" : "No goals here yet",
                        message: model.error ? "Pull to refresh to try again." : "Add one with the ＋ button.")
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        // Bounce even when the list is short/empty, so pull-to-refresh still triggers.
        .scrollBounceBehavior(.always)
        .background(WF.canvas)
        .navigationTitle("Goals")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(isKiosk ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Image(systemName: "plus") }
            }
        }
        .task {
            if model.lists.isEmpty { await model.loadLists() }
            await model.syncHealth()
            // path.isEmpty: skip when something already deep-linked a goal (e.g. the
            // Today card's openGoal hook landed here with the detail pushed).
            if DemoHooks.openGoal, !Self.didOpenGoal, path.isEmpty, let f = model.spotlight ?? model.visibleGoals.first {
                Self.didOpenGoal = true; path.append(.goal(f))
            }
            if DemoHooks.newGoal, !Self.didOpenGoal { Self.didOpenGoal = true; creating = true }
        }
        // GoalDetailView owns a SEPARATE model, so deletes / logged progress / step
        // ticks / entry edits there don't touch this list's model. When the user pops
        // back (path shrinks), reload the selected list so those changes show without a
        // manual pull-to-refresh. Only fires on return — pushing in grows the path.
        .onChange(of: path) { oldPath, newPath in
            if newPath.count < oldPath.count { Task { await model.loadGoals() } }
        }
        .refreshable { await model.loadLists(); await model.syncHealth() }
        .sheet(item: $logging) { g in
            GoalLogSheet(goal: g, onChanged: { Task { await model.loadGoals() } }) { amount, hours, minutes, ids, note, loggedOn in
                Task { await model.log(goalId: g.id, amount: amount, personIds: ids, note: note, loggedOn: loggedOn, hours: hours, minutes: minutes) }
            }
        }
        .goalEditor(isPresented: $creating) {
            GoalCreateSheet(lists: model.lists, defaultListId: model.selectedList?.id, members: sync.members) { body, listId in
                Task { await model.create(body, listId: listId) }
            }
        }
        .sheet(isPresented: $creatingList) {
            GoalListCreateSheet(members: sync.members) { list in
                Task {
                    model.selectedListId = list.id
                    await model.loadLists()
                }
            }
        }
    }

    // MARK: list picker + head

    private var listPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(model.lists) { list in
                    let on = list.id == model.selectedList?.id
                    Button { Task { await model.select(list.id) } } label: {
                        HStack(spacing: 8) {
                            AvatarStack(members: list.members, size: 22)
                            Text(list.name).font(.system(size: 13.5, weight: .bold))
                                .foregroundStyle(on ? WF.ink : WF.ink2).lineLimit(1)
                            Text("\(list.goalCount)").font(.system(size: 11, weight: .heavy))
                                .foregroundStyle(WF.ink3)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(WF.panel).clipShape(Capsule())
                        }
                        .padding(.leading, 8).padding(.trailing, 10).padding(.vertical, 7)
                        .background(on ? WF.card : WF.card2)
                        .overlay(Capsule().strokeBorder(on ? WF.ink.opacity(0.22) : WF.hair, lineWidth: on ? 1.5 : 1))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
                Button { creatingList = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                        Text("New group").font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(WF.ink3)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .overlay(Capsule().strokeBorder(WF.hair, style: StrokeStyle(lineWidth: 1.5, dash: [4])))
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, 2)
        }
    }

    private func listHead(_ list: WaffledAPI.GoalList) -> some View {
        HStack(spacing: 11) {
            AvatarStack(members: list.members, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(list.name).font(WF.serif(20)).foregroundStyle(WF.ink)
                Text("\(list.goalCount) goals · \(listSub(list))")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            Spacer()
        }
    }

    private func listSub(_ l: WaffledAPI.GoalList) -> String {
        switch l.members.count {
        case 1: return "Personal"
        case 2: return l.members.map { goalFirstName($0.name) }.joined(separator: " & ")
        default: return "Everyone · \(l.members.count) people"
        }
    }

    private var filterSeg: some View {
        Picker("Filter", selection: Binding(get: { model.filter }, set: { model.filter = $0 })) {
            Text("All").tag(GoalsModel.Filter.all)
            Text("Shared").tag(GoalsModel.Filter.shared)
            Text("Each").tag(GoalsModel.Filter.each)
        }
        .pickerStyle(.segmented)
    }

    // MARK: hero

    @ViewBuilder private func hero(_ g: WaffledAPI.Goal) -> some View {
        if g.trackingMode == "each_tracks" { eachHero(g) } else { sharedHero(g) }
    }

    private func sharedHero(_ g: WaffledAPI.Goal) -> some View {
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        let maxProg = max(1, g.participants.map(\.progress).max() ?? 1)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                GoalRing(value: frac, size: 96, lineWidth: 9, stroke: .white, track: .white.opacity(0.25)) {
                    VStack(spacing: 0) {
                        Text(ringFmt(g.totalProgress)).font(.system(size: 23, weight: .heavy)).foregroundStyle(.white)
                            .lineLimit(1).minimumScaleFactor(0.5)
                        Text("of \(ringFmt(g.target))\(g.unit.map { " \($0)" } ?? "")")
                            .font(.system(size: 9, weight: .bold)).foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    heroPill("🌟 Spotlight · shared total")
                    Text(g.title).font(WF.serif(26)).foregroundStyle(.white).lineLimit(2)
                        .minimumScaleFactor(0.7)
                    Text("Everyone contributes to one pool\(g.deadline.map { " · by \(fmtDeadline($0))" } ?? "")")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(2)
                }
            }
            if !g.participants.isEmpty {
                VStack(spacing: 8) {
                    ForEach(g.participants, id: \.personId) { contribRow($0, max: maxProg, unit: g.unit) }
                }
            }
            logButton(g, fg: WF.success)
        }
        .padding(16)
        .background(Self.heroGreen)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { path.append(.goal(g)) }
    }

    private func eachHero(_ g: WaffledAPI.Goal) -> some View {
        let summed = g.participants.reduce(0.0) { $0 + ($1.target ?? 0) }
        let summedTarget = summed > 0 ? summed : (g.target ?? 0)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                Text(g.emoji ?? "🎯").font(.system(size: 38))
                    .frame(width: 64, height: 64)
                    .background(.white.opacity(0.18)).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                VStack(alignment: .leading, spacing: 6) {
                    heroPill("🌟 Spotlight · each tracks their own")
                    Text(g.title).font(WF.serif(26)).foregroundStyle(.white).lineLimit(2)
                        .minimumScaleFactor(0.7)
                    Text(g.target.map { "\(goalFmt($0)) \(g.unit ?? "")".trimmingCharacters(in: .whitespaces) + " each" } ?? "Everyone tracks their own")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                }
            }
            HStack {
                Text("TOGETHER").font(.system(size: 10, weight: .heavy)).tracking(0.6).foregroundStyle(.white.opacity(0.8))
                Spacer()
                Text("\(goalFmt(g.totalProgress))/\(goalFmt(summedTarget))")
                    .font(.system(size: 15, weight: .heavy)).foregroundStyle(.white)
            }
            if !g.participants.isEmpty {
                VStack(spacing: 8) {
                    ForEach(g.participants, id: \.personId) { p in
                        contribRow(p, max: max(1, p.target ?? g.target ?? 1), unit: g.unit)
                    }
                }
            }
            logButton(g, fg: WF.warn)
        }
        .padding(16)
        .background(Self.heroOrange)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { path.append(.goal(g)) }
    }

    private func heroPill(_ text: String) -> some View {
        Text(text).font(.system(size: 10.5, weight: .heavy))
            .foregroundStyle(.white)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(.white.opacity(0.2)).clipShape(Capsule())
    }

    private func contribRow(_ p: WaffledAPI.Goal.Participant, max: Double, unit: String?) -> some View {
        HStack(spacing: 8) {
            Text("\(p.avatarEmoji ?? "🙂") \(goalFirstName(p.name))")
                .font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                .frame(width: 80, alignment: .leading).lineLimit(1)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.25))
                    Capsule().fill(.white).frame(width: geo.size.width * (max > 0 ? min(p.progress / max, 1) : 0))
                }
            }
            .frame(height: 7)
            Text("\(goalFmt(p.progress))\(unit.map { " \($0)" } ?? "")")
                .font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                .frame(width: 66, alignment: .trailing).lineLimit(1).minimumScaleFactor(0.7)
        }
    }

    private func logButton(_ g: WaffledAPI.Goal, fg: Color) -> some View {
        Button { logging = g } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.system(size: 13, weight: .heavy))
                Text("Log \(g.unit ?? "progress")").font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(fg)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(.white)
            .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: more cards

    private func moreCard(_ g: WaffledAPI.Goal, pinned: Bool) -> some View {
        let c = GoalStyle.color(g.category)
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        return Button { path.append(.goal(g)) } label: {
            VStack(alignment: .leading, spacing: 11) {
                HStack(spacing: 12) {
                    Text(g.emoji ?? GoalStyle.emoji(g.category)).font(.system(size: 20))
                        .frame(width: 42, height: 42)
                        .background(c.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(g.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                            if pinned {
                                Text("📌 PINNED").font(.system(size: 9, weight: .heavy)).foregroundStyle(WF.warn)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(WF.warnT).clipShape(Capsule())
                            }
                        }
                        Text(goalDescriptor(g)).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    HStack(alignment: .firstTextBaseline, spacing: 1) {
                        Text(goalFmt(g.totalProgress)).font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                        Text("/\(goalFmt(g.target))").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    pinToggle(g)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(WF.hair)
                        Capsule().fill(c).frame(width: geo.size.width * frac)
                    }
                }
                .frame(height: 7)
                if g.streakDays > 0 {
                    Text("🔥 \(g.streakDays)-day streak")
                        .font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink2)
                }
            }
            .padding(14)
            .wfField()
            .overlay {
                if pinned {
                    RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                        .strokeBorder(WF.warn.opacity(0.5), lineWidth: 1.5)
                }
            }
        }
        .buttonStyle(.plain)
    }

    /// A quick pin/unpin toggle on a card. Nested in the card button — SwiftUI routes the tap
    /// to this inner button, so it doesn't open the goal.
    private func pinToggle(_ g: WaffledAPI.Goal) -> some View {
        Button { Task { await model.togglePin(g) } } label: {
            Image(systemName: g.isFeatured ? "pin.fill" : "pin")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(g.isFeatured ? WF.primary : WF.ink3.opacity(0.55))
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func fmtDeadline(_ iso: String) -> String {
        guard let d = DateFmt.date(String(iso.prefix(10)), "yyyy-MM-dd", DateFmt.utc) else { return "" }
        return DateFmt.string(d, "MMM d", DateFmt.utc)
    }
}

/// Log progress — quick-amount chips, multi-select "Who", optional note. One log is
/// written per selected person (so per-person sums roll up to the pool). WF-styled.
struct GoalLogSheet: View {
    @Environment(\.dismiss) private var dismiss
    let goal: WaffledAPI.Goal
    /// (amount, hours, minutes, who, note, backdate). For a time goal, `hours`/`minutes`
    /// carry the entry and the server converts; otherwise they're nil and `amount` is used.
    /// Backdate is a YYYY-MM-DD string, or nil for today.
    let onSave: (Double, Int?, Int?, [String], String, String?) -> Void
    /// Called after a checklist step is ticked (the parent reloads to reflect it).
    var onChanged: (() -> Void)? = nil

    private let api = WaffledAPI()
    @State private var amount: Double
    @State private var amountText: String
    /// Time goals are logged as hours + minutes; the server folds them into decimal hours.
    /// The raw text is the single source of truth so a cleared field stays empty while
    /// editing (value 0) instead of snapping back to the old number — it's only normalized
    /// (via DurationEntry) when the field loses focus. The logged Ints are derived, never
    /// stored, so text and value can't drift apart.
    @State private var hoursText: String
    @State private var minutesText: String
    private var hours: Int { DurationEntry.value(of: hoursText) }
    private var minutes: Int { DurationEntry.value(of: minutesText, cap: 59) }
    private enum HMField { case hours, minutes }
    @FocusState private var hmFocus: HMField?
    @State private var who: Set<String>
    @State private var note = ""
    /// A checklist goal's steps (fetched on appear; ticking is the "log" for checklists).
    @State private var steps: [WaffledAPI.GoalDetail.Step] = []
    @State private var stepsLoaded = false
    /// The day this entry counts for — defaults to today, backdate to catch up a streak.
    @State private var loggedOn = Date()
    /// Tier-0 Apple Health read-&-suggest: today's total for a metric this goal's unit
    /// matches, offered as a one-tap pre-fill. iPhone-only; nil = nothing to suggest.
    @State private var healthSuggestion: (metric: HealthKitBridge.Metric, value: Double)?

    private static let hourUnits: Set<String> = ["hour", "hours", "hr", "hrs"]
    private static let activityChips = ["Bike ride", "Park", "Sports", "Outside play", "Reading", "Art"]

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }
    private var isChecklist: Bool { goal.goalType == "checklist" }
    private var isHabit: Bool { goal.goalType == "habit" }
    private var isCount: Bool { goal.goalType == "count" }
    /// A log must be credited to someone: when the goal has participants, at least one
    /// must be picked (single-participant goals pre-select that person). A habit's "done"
    /// still needs a who; count/total the same.
    private var whoMissing: Bool { !goal.participants.isEmpty && who.isEmpty }
    private var isHours: Bool { goal.unit.map { Self.hourUnits.contains($0.lowercased()) } ?? false }
    /// A total goal measured in hours — logged as hours + minutes.
    private var isTime: Bool { !isHabit && !isCount && isHours }
    /// The amount actually logged: habit = 1 (one completion), count = whole units,
    /// time = hours + minutes folded to decimal hours, total = entered.
    private var logAmount: Double { isHabit ? 1 : isCount ? max(1, amount.rounded()) : isTime ? (Double(hours) + Double(minutes) / 60) : amount }
    /// "2h 10m" / "45m" / "1h" for time goals.
    private var durationLabel: String {
        hours > 0 && minutes > 0 ? "\(hours)h \(minutes)m" : hours > 0 ? "\(hours)h" : "\(minutes)m"
    }
    private var unitSuffix: String { goal.unit.map { " \($0)" } ?? "" }
    // "Who" copy adapts to the goal's participant type (mirrors web LogModal).
    private var eachAdds: Bool { goal.trackingMode == "each_tracks" }
    private var isSplit: Bool { goal.trackingMode == "shared_total" && (goal.participantMode ?? "count_once") == "split" }
    private var whoLabel: String { eachAdds ? "Who took part?" : isSplit ? "Split between" : "Who was there?" }
    private var confirmLabel: String { isHabit ? "Mark done for today" : isTime ? "Log \(durationLabel)" : "Log \(goalFmt(logAmount))\(unitSuffix)" }
    private var chips: [(label: String, value: Double)] {
        if isHours {
            return [("30m", 0.5), ("1 hr", 1), ("1.5 hr", 1.5), ("2 hr", 2)]
        }
        let u = goal.unit.map { " \($0)" } ?? ""
        return [1, 2, 3, 5].map { (label: "\(Int($0))\(u)", value: Double($0)) }
    }

    init(goal: WaffledAPI.Goal, onChanged: (() -> Void)? = nil, onSave: @escaping (Double, Int?, Int?, [String], String, String?) -> Void) {
        self.goal = goal
        self.onSave = onSave
        self.onChanged = onChanged
        let isHours = goal.unit.map { GoalLogSheet.hourUnits.contains($0.lowercased()) } ?? false
        // Habit/count start at 1 (one completion / one whole thing); an hours total at 1,
        // any other total at 2.
        let initial: Double = (goal.goalType == "habit" || goal.goalType == "count") ? 1 : (isHours ? 1 : 2)
        _amount = State(initialValue: initial)
        _amountText = State(initialValue: goalFmt(initial))
        // A time goal (total measured in hours) starts at 1h 0m and is entered as hours + minutes.
        _hoursText = State(initialValue: (goal.goalType != "habit" && goal.goalType != "count" && isHours) ? "1" : "0")
        _minutesText = State(initialValue: "0")
        _who = State(initialValue: goal.participants.count == 1 ? [goal.participants[0].personId] : [])
    }

    /// Tier-0 read-&-suggest: if HealthKit is available and this goal's unit maps to a
    /// metric, pre-fetch today's total once. Denied/empty reads just leave it nil.
    private func loadHealthSuggestion() async {
        let hk = HealthKitBridge.shared
        // The goal's stored link decides the metric; the unit heuristic is only the
        // fallback for unlinked goals. (A cycling-distance goal's unit is "mi" too —
        // matching(unit:) alone would suggest walk+run miles for it.)
        guard hk.isAvailable,
              let metric = HealthKitBridge.Metric(key: goal.healthMetric)
                ?? HealthKitBridge.Metric.matching(unit: goal.unit) else { return }
        try? await hk.requestReadAuthorization()
        if let value = await hk.todayTotal(for: metric), value > 0 {
            healthSuggestion = (metric, value)
        }
    }

    /// One-tap pre-fill from Apple Health — sets the amount; the user still credits + logs.
    private func healthSuggestionCard(_ s: (metric: HealthKitBridge.Metric, value: Double)) -> some View {
        Button {
            amount = s.value
            amountText = goalFmt(s.value)
        } label: {
            HStack(spacing: 11) {
                ZStack {
                    Circle().fill(WF.ai.opacity(0.14)).frame(width: 34, height: 34)
                    Image(systemName: "heart.fill").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ai)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Apple Health · today").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    Text("\(goalFmt(s.value)) \(s.metric.label)").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                }
                Spacer()
                Text("Use").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Capsule().fill(WF.ai))
            }
            .padding(12)
            .background(WF.card2)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if isChecklist {
                        checklistSection
                    } else {
                        if let s = healthSuggestion { healthSuggestionCard(s) }
                        amountSection
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "When?")
                            whenRow
                        }
                        if !goal.participants.isEmpty {
                            VStack(alignment: .leading, spacing: 9) {
                                HStack(spacing: 6) {
                                    SectionLabel(text: whoLabel)
                                    if whoMissing {
                                        Text("pick at least one")
                                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.primary)
                                    }
                                }
                                whoRow
                            }
                        }
                        noteSection
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .task { if isChecklist { await loadSteps() } else { await loadHealthSuggestion() } }
            .navigationTitle(isChecklist ? "Checklist" : "Log progress")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(isChecklist ? "Done" : "Cancel") { dismiss() } }
                if !isChecklist {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(confirmLabel) {
                            let backdate = Cal.current.isDateInToday(loggedOn) ? nil : DateFmt.string(loggedOn, "yyyy-MM-dd", .current)
                            onSave(logAmount, isTime ? hours : nil, isTime ? minutes : nil, Array(who), note.trimmingCharacters(in: .whitespacesAndNewlines), backdate)
                            dismiss()
                        }
                        .fontWeight(.semibold)
                        .disabled(logAmount == 0 || whoMissing)
                    }
                }
            }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    // Amount input adapts to the goal type: habit = one-tap, count = whole-unit stepper,
    // total = quick chips + free entry.
    @ViewBuilder private var amountSection: some View {
        if isHabit {
            VStack(alignment: .leading, spacing: 9) {
                SectionLabel(text: "Mark it done")
                HStack(spacing: 11) {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 22)).foregroundStyle(WF.primary)
                    Text("One tap logs today’s completion — keep the streak going.")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                    Spacer(minLength: 0)
                }
                .padding(14).background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            }
        } else if isCount {
            VStack(alignment: .leading, spacing: 9) {
                SectionLabel(text: "How many?")
                HStack(spacing: 18) {
                    stepButton("minus", disabled: max(1, amount.rounded()) <= 1) {
                        amount = max(1, amount.rounded() - 1); amountText = goalFmt(amount)
                    }
                    Text("\(Int(max(1, amount.rounded())))\(unitSuffix)")
                        .font(WF.serif(22)).foregroundStyle(WF.ink).frame(minWidth: 90)
                    stepButton("plus", disabled: false) {
                        amount = amount.rounded() + 1; amountText = goalFmt(amount)
                    }
                    Spacer(minLength: 0)
                }
            }
        } else if isTime {
            // Time goal: quick chips + separate hours/minutes entry (server converts to
            // decimal hours), so "10 min" never has to become 0.1666… here.
            VStack(alignment: .leading, spacing: 9) {
                SectionLabel(text: "How long?")
                timeChipRow
                HStack(spacing: 8) {
                    Text("or").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    hmField($hoursText, unit: "hr", field: .hours)
                    hmField($minutesText, unit: "min", field: .minutes)
                }
                // Normalize only when a field is left: "" → "0", "07" → "7", 75 min → 59.
                .onChange(of: hmFocus) { old, _ in
                    if old == .hours { hoursText = DurationEntry.normalized(hoursText) }
                    if old == .minutes { minutesText = DurationEntry.normalized(minutesText, cap: 59) }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 9) {
                SectionLabel(text: "How much?")
                chipRow
                HStack(spacing: 8) {
                    Text("or").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    TextField("amount", text: $amountText)
                        .keyboardType(.decimalPad)
                        .font(.system(size: 16, weight: .semibold))
                        .padding(.horizontal, 13).padding(.vertical, 10)
                        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                        .frame(width: 110)
                        // Locale-aware ("2,5" on a comma-decimal pad); empty/unparsable = 0
                        // (Log disables) — never the stale previous amount, which would
                        // silently log a number the field no longer shows.
                        .onChange(of: amountText) { _, new in amount = AmountEntry.value(of: new) }
                    if let u = goal.unit { Text(u).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3) }
                }
            }
        }
    }

    /// A compact whole-number field for hours or minutes. Text-backed (not an Int
    /// `format:` binding) so a cleared field stays empty while editing — the old Int
    /// binding re-materialized the previous value the moment focus moved. The logged
    /// Ints are *derived* from the text (see `hours`/`minutes`, empty = 0, minutes
    /// capped at 59); the visible text is only normalized on focus loss (see the
    /// `.onChange(of: hmFocus)`).
    private func hmField(_ text: Binding<String>, unit: String, field: HMField) -> some View {
        HStack(spacing: 6) {
            TextField("0", text: text)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .font(.system(size: 16, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                .frame(width: 64)
                .focused($hmFocus, equals: field)
            Text(unit).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
        }
    }

    /// Quick-duration chips (30m / 1 hr / …) that set the hours + minutes fields.
    private var timeChipRow: some View {
        HStack(spacing: 8) {
            ForEach(chips, id: \.label) { c in
                let on = abs((Double(hours) + Double(minutes) / 60) - c.value) < 1e-6
                Button { setTimeChip(c.value) } label: {
                    Text(c.label).font(.system(size: 14, weight: .bold))
                        .foregroundStyle(on ? .white : WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(on ? WF.primary : WF.card)
                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func setTimeChip(_ v: Double) {
        hoursText = String(Int(v))
        minutesText = String(Int((v - Double(Int(v))) * 60 + 0.5))
    }

    private func stepButton(_ icon: String, disabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 16, weight: .bold))
                .foregroundStyle(disabled ? WF.ink3 : WF.ink)
                .frame(width: 46, height: 46)
                .background(Circle().fill(WF.card).overlay(Circle().strokeBorder(WF.hair, lineWidth: 1)))
        }
        .buttonStyle(.plain).disabled(disabled)
    }

    private var noteSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "What did you do? · optional")
            TextField("Creek hike + fort building", text: $note)
                .font(.system(size: 16, weight: .semibold))
                .padding(.horizontal, 13).padding(.vertical, 12)
                .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach(Self.activityChips, id: \.self) { a in
                    Button { note = a } label: {
                        Text(a).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                            .padding(.horizontal, 11).padding(.vertical, 7)
                            .background(WF.card2).overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // ── checklist: tick steps (this IS "log progress" for a checklist goal) ────
    private var checklistSection: some View {
        let done = steps.filter { $0.done }.count
        return VStack(alignment: .leading, spacing: 12) {
            Text("\(done)/\(steps.count) steps done")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
            if !stepsLoaded {
                Text("Loading…").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
            } else if steps.isEmpty {
                Text("No steps yet — add some by editing this goal.")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
            } else {
                ForEach(steps) { s in stepRow(s) }
            }
        }
    }

    private func stepRow(_ s: WaffledAPI.GoalDetail.Step) -> some View {
        Button { Task { await toggleStep(s) } } label: {
            HStack(spacing: 11) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(s.done ? WF.primary : WF.hair, lineWidth: 2).frame(width: 22, height: 22)
                    if s.done {
                        RoundedRectangle(cornerRadius: 6, style: .continuous).fill(WF.primary).frame(width: 22, height: 22)
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .black)).foregroundStyle(.white)
                    }
                }
                Text(s.label).font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(s.done ? WF.ink3 : WF.ink).strikethrough(s.done, color: WF.ink3)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair2, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func loadSteps() async {
        if let d = try? await api.goalDetail(id: goal.id) { steps = d.steps }
        stepsLoaded = true
    }
    private func toggleStep(_ s: WaffledAPI.GoalDetail.Step) async {
        let next = !s.done
        if let i = steps.firstIndex(where: { $0.id == s.id }) {
            steps[i] = .init(id: s.id, label: s.label, done: next, doneBy: s.doneBy)
        }
        do { try await api.tickGoalStep(goalId: goal.id, stepId: s.id, done: next); onChanged?() }
        catch { if let i = steps.firstIndex(where: { $0.id == s.id }) { steps[i] = s } }
    }

    private var chipRow: some View {
        HStack(spacing: 8) {
            ForEach(chips, id: \.label) { c in
                let on = amount == c.value
                Button { amount = c.value; amountText = goalFmt(c.value) } label: {
                    Text(c.label).font(.system(size: 14, weight: .bold))
                        .foregroundStyle(on ? .white : WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(on ? WF.primary : WF.card)
                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Quick Today/Yesterday chips plus a compact picker for any earlier day — so a
    /// missed log can be backdated without breaking the streak. Future days disabled.
    private var whenRow: some View {
        let cal = Cal.current
        let today = Date()
        let yesterday = cal.date(byAdding: .day, value: -1, to: today) ?? today
        return HStack(spacing: 8) {
            dayChip("Today", date: today)
            dayChip("Yesterday", date: yesterday)
            Spacer()
            DatePicker("", selection: $loggedOn, in: ...today, displayedComponents: .date)
                .labelsHidden()
        }
    }

    private func dayChip(_ label: String, date: Date) -> some View {
        let on = Cal.current.isDate(loggedOn, inSameDayAs: date)
        return Button { loggedOn = date } label: {
            Text(label).font(.system(size: 14, weight: .semibold))
                .foregroundStyle(on ? .white : WF.ink2)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(on ? WF.primary : WF.card)
                .overlay(Capsule().strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var whoRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(goal.participants, id: \.personId) { p in
                    let on = who.contains(p.personId)
                    Button {
                        if on { who.remove(p.personId) } else { who.insert(p.personId) }
                    } label: {
                        HStack(spacing: 7) {
                            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 24)
                            Text(goalFirstName(p.name)).font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(on ? WF.ink : WF.ink2)
                            // Always render the checkmark and toggle visibility so the chip
                            // width stays fixed on select (inserting it shifted neighbours).
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 14)).foregroundStyle(WF.primary)
                                .opacity(on ? 1 : 0)
                        }
                        .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                        .wfChip(selected: on)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 1)
        }
    }
}

/// **Tier 2 — "track from Apple Health" picker.** The metric list is grouped by the goal
/// type's shape (mock design): total/count get an "adds up automatically" grouping
/// (Everyday / Distance / Workouts / …) while a habit gets a "counts qualifying days" one
/// (rings first, then logged-each-day and workout days). Searchable; each row carries the
/// user's *current* value (read live on appear) so they pick a goal around something real
/// instead of guessing a number. Tapping one hands the metric back to the editor, which
/// configures type/unit/target. iPhone-only.
private struct HealthDataPickerSheet: View {
    let goalType: String
    var selected: HealthKitBridge.Metric? = nil
    let onPick: (HealthKitBridge.Metric) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: Double?] = [:]
    @State private var search = ""

    private var isHabit: Bool { goalType == "habit" }

    /// The goal-type sections, filtered down by the search text (on the visible names).
    private var sections: [(title: String, metrics: [HealthKitBridge.Metric])] {
        let base = HealthKitBridge.Metric.sections(forGoalType: goalType)
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return base }
        return base
            .map { (title: $0.title, metrics: $0.metrics.filter {
                $0.chipLabel.lowercased().contains(q) || $0.label.lowercased().contains(q)
            }) }
            .filter { !$0.metrics.isEmpty }
    }

    var body: some View {
        NavigationStack {
            List {
                // The mock's under-title caption: what picking here *means* per goal shape.
                Section {} footer: {
                    Text(isHabit ? "Counts qualifying days — pick one habit." : "Adds up automatically — pick one metric.")
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink2)
                }
                ForEach(sections, id: \.title) { section in
                    Section {
                        ForEach(section.metrics, id: \.self) { m in row(m) }
                    } header: {
                        Text(section.title)
                    } footer: {
                        // Discoverability: on a total, workouts can only sum minutes — point
                        // at the Count goal type, where the same activities count sessions.
                        if section.title == "Workouts" && goalType == "total" {
                            Text("Counting workouts instead? Make the goal a **Count** and these track sessions — “swim 12 times this month”.")
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "Search metrics")
            .navigationTitle("Track from Apple Health")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .task { await load() }
    }

    private func row(_ m: HealthKitBridge.Metric) -> some View {
        // A habit lists the sessions measure, but the goal may be linked to the minutes
        // sibling ("at least 45 min of yoga") — the activity's row is still "its" row.
        let on = m == selected || (selected != nil && m.workoutSibling == selected)
        return Button { onPick(m) } label: {
            HStack(spacing: 12) {
                WaffledEmojiTile(emoji: m.emoji, size: 17, frame: 34, cornerRadius: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.chipLabel).font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(on ? WF.ai : WF.ink)
                    // "Fills in miles" until THIS row's live read lands (reads fan out
                    // and publish per-metric), then "3.2 mi today".
                    Text(values[m.key].map { m.formatCurrent($0) } ?? "Fills in \(isHabit ? "days" : m.label)")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                }
                Spacer()
                Image(systemName: on ? "checkmark" : "chevron.right")
                    .font(.system(size: 12, weight: .bold)).foregroundStyle(on ? WF.ai : WF.ink3)
            }
        }
    }

    private func load() async {
        _ = try? await HealthKitBridge.shared.requestReadAuthorization()
        let metrics = HealthKitBridge.Metric.sections(forGoalType: goalType).flatMap(\.metrics)
        // Fan the reads out (rows appear as each lands — total wait is the slowest
        // query, not the sum) and fetch the day's workouts ONCE: every workout row is
        // derived from that single list in pure code instead of its own HKSampleQuery.
        async let workoutDay = HealthKitBridge.shared.workoutsOfDay(Date())
        await withTaskGroup(of: (String, Double?).self) { group in
            for m in metrics where !m.isWorkout {
                group.addTask { (m.key, await HealthKitBridge.shared.total(for: m, on: Date())) }
            }
            for await (key, value) in group { values[key] = value }
        }
        let day = await workoutDay
        for m in metrics where m.isWorkout {
            values[m.key] = day.flatMap { m.workoutValue(fromDay: $0) }
        }
    }
}

/// New goal — title, who-it's-for (goal list), shared/each, type + measure,
/// category, feature + rewards toggles with an inline milestone editor. Mirrors the
/// web GoalCreate, folded into one scrollable sheet. WF-styled.
struct GoalCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let lists: [WaffledAPI.GoalList]
    let defaultListId: String?
    let members: [SyncedMember]
    /// When set, the sheet prefills from this goal and reads as "Edit goal".
    var editGoal: WaffledAPI.GoalDetail? = nil
    let onSubmit: ([String: JSONValue], String?) -> Void

    @State private var didPrefill = false
    /// A local copy of the lists so a just-created group shows up immediately.
    @State private var localLists: [WaffledAPI.GoalList] = []
    @State private var creatingList = false

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }
    @FocusState private var titleFocused: Bool

    private struct TypeOpt { let key, emoji, title, desc: String }
    private static let types = [
        TypeOpt(key: "total", emoji: "⏱️", title: "Total amount", desc: "Adds up — can split (hours, miles)"),
        TypeOpt(key: "count", emoji: "🔢", title: "Count", desc: "Whole things (books, parks)"),
        TypeOpt(key: "habit", emoji: "🔁", title: "Habit", desc: "Once a day, on a cadence"),
        TypeOpt(key: "checklist", emoji: "🪜", title: "Checklist", desc: "Named steps you tick off"),
    ]
    private static let categories = ["physical", "intellectual", "spiritual", "creative", "social"]
    private static let categoryLabel = ["physical": "Physical", "intellectual": "Intellectual",
                                        "spiritual": "Spiritual", "creative": "Creative", "social": "Social"]

    struct Milestone: Identifiable { let id = UUID(); var emoji: String; var threshold: String; var reward: String }

    /// Auto-derived starter milestones. Per product note: split the goal's *number*
    /// into sensible checkpoints and leave the reward text BLANK — goals stay about
    /// growth, so the family fills in a reward only if they want one. Amount goals get
    /// three nice-rounded thirds of the target (last node = the target itself); streak
    /// and percent types get their own natural checkpoints.
    static func derivedMilestones(type: String, target: Int) -> [Milestone] {
        switch type {
        case "habit": // threshold = 🔥 streak days
            return zip(["🌱", "🔥", "🏆"], [7, 30, 100]).map { .init(emoji: $0.0, threshold: String($0.1), reward: "") }
        case "checklist": // threshold = % complete
            return zip(["🌱", "🏆"], [50, 100]).map { .init(emoji: $0.0, threshold: String($0.1), reward: "") }
        default: // total | count — three nice thirds of the target
            let vals = niceThirds(target)
            let emojis = vals.count >= 3 ? ["🌱", "⛺", "🏆"] : (vals.count == 2 ? ["🌱", "🏆"] : ["🏆"])
            return zip(emojis, vals).map { .init(emoji: $0.0, threshold: String($0.1), reward: "") }
        }
    }

    /// Three ascending checkpoints for a numeric target: two nice-rounded thirds plus
    /// the target itself. 300 → 100/200/300, 750 → 250/500/750, 1000 → 250/500/1000.
    static func niceThirds(_ target: Int) -> [Int] {
        guard target > 1 else { return [max(target, 1)] }
        var out: [Int] = []
        for v in [niceRound(Double(target) / 3), niceRound(Double(target) * 2 / 3), target] {
            let x = min(v, target)
            if let last = out.last { if x > last { out.append(x) } } else if x > 0 { out.append(x) }
        }
        if out.last != target { out.append(target) }
        return out
    }

    /// Round to a "nice" number — the leading digit snapped to 1 / 2 / 2.5 / 5 / 10.
    /// (Hand-rolled base extraction so we don't lean on `pow`/`log10`.)
    static func niceRound(_ v: Double) -> Int {
        guard v > 0 else { return 0 }
        var n = v, base = 1.0
        while n >= 10 { n /= 10; base *= 10 }   // n ∈ [1, 10), base = the leading place
        while n < 1  { n *= 10; base /= 10 }
        let nice: Double = n < 1.5 ? 1 : (n < 2.25 ? 2 : (n < 3.5 ? 2.5 : (n < 7.5 ? 5 : 10)))
        return Int((nice * base).rounded())
    }

    /// Stable signature of a milestone set — lets us tell whether the user has
    /// hand-edited the auto-derived milestones (if so we stop re-deriving them).
    static func signature(_ ms: [Milestone]) -> String {
        ms.map { "\($0.emoji)|\($0.threshold)|\($0.reward)" }.joined(separator: ";")
    }
    /// A checklist step. `existingId` is the server id when editing (so steps are
    /// updated, not recreated); nil for newly added rows.
    struct Step: Identifiable { let id = UUID(); var existingId: String?; var label: String }

    @State private var title = ""
    @State private var goalListId: String?
    // Counting model (mirrors web). Default "each tracks their own" (per-person basis),
    // matching the design mock; users flip to "One shared total" + a measure-aware
    // counting choice below the measure picker.
    @State private var trackingMode = "each_tracks"
    @State private var participantMode = "count_once"
    @State private var targetBasis = "per_person"
    @State private var goalType = "total"
    @State private var target = "1000"
    @State private var unit = "hours"
    @State private var habitPeriod = "week"
    @State private var habitPer = "5"
    @State private var category = "physical"
    @State private var hasDeadline = false
    @State private var deadline = Date()
    // Tier defaults to Normal — elevating to Pinned/Spotlight is an intentional choice.
    @State private var isFeatured = false
    @State private var isSpotlight = false
    /// The selected list's current spotlight (a different goal), so picking Spotlight can name it.
    @State private var listSpotlightTitle: String?
    private let tierApi = WaffledAPI()
    @State private var hasRewards = false
    // Calendar auto-count defaults ON (product decision): most goals benefit from
    // matching events adding progress, and it's still one tap to turn off.
    @State private var autoFromCalendar = true
    @State private var milestones: [Milestone] = GoalCreateSheet.derivedMilestones(type: "total", target: 1000)
    // Signature of the last auto-derived milestone set. While `milestones` still
    // matches it, changing the target/type re-derives them; once the user hand-edits
    // a milestone the signature diverges and auto-derivation stops.
    @State private var lastDerivedSig = GoalCreateSheet.signature(GoalCreateSheet.derivedMilestones(type: "total", target: 1000))
    @State private var steps: [Step] = [
        .init(existingId: nil, label: ""), .init(existingId: nil, label: ""), .init(existingId: nil, label: ""),
    ]

    private var isHabit: Bool { goalType == "habit" }
    private var isChecklist: Bool { goalType == "checklist" }
    private var filledSteps: [Step] { steps.filter { !$0.label.trimmingCharacters(in: .whitespaces).isEmpty } }

    // ── counting model (mirrors web) ───────────────────────────────────────────
    private var selectedList: WaffledAPI.GoalList? { localLists.first { $0.id == goalListId } }
    private var participantCount: Int { selectedList?.members.count ?? editGoal?.participants.count ?? 0 }
    /// Shared-vs-each derived from the backend fields. "Each tracks their own" is the
    /// per-person basis for total/count, or plain each_tracks for habit/checklist.
    private var shared: Bool {
        (goalType == "total" || goalType == "count")
            ? !(trackingMode == "each_tracks" && targetBasis == "per_person")
            : trackingMode != "each_tracks"
    }
    /// The measure-aware count sub-choice: total → full|split, count → each|once.
    private var countChoice: String {
        goalType == "total" ? (trackingMode == "each_tracks" ? "full" : "split")
            : (trackingMode == "each_tracks" ? "each" : "once")
    }
    private func setSharedMode() {
        if goalType == "total" || goalType == "count" { trackingMode = "each_tracks"; targetBasis = "family" }
        else { trackingMode = "shared_total"; targetBasis = "family" }
        participantMode = "count_once"
    }
    private func setEachMode() {
        trackingMode = "each_tracks"
        targetBasis = (goalType == "total" || goalType == "count") ? "per_person" : "family"
        participantMode = "count_once"
    }
    private func setCountChoice(_ k: String) {
        switch (goalType, k) {
        case ("total", "full"), ("count", "each"):
            trackingMode = "each_tracks"; targetBasis = "family"; participantMode = "count_once"
        case ("total", "split"):
            trackingMode = "shared_total"; targetBasis = "family"; participantMode = "split"
        default: // count "once"
            trackingMode = "shared_total"; targetBasis = "family"; participantMode = "count_once"
        }
    }
    /// Switch measure; fit the unit (Count shouldn't inherit the Total "hours" default)
    /// and re-normalize the counting fields for the new measure.
    private func selectMeasure(_ key: String) {
        if key == "count", unit == "hours" || unit.isEmpty { unit = "" }
        else if key == "total", unit.isEmpty { unit = "hours" }
        let wasShared = shared
        goalType = key
        if wasShared { setSharedMode() } else { setEachMode() }
    }

    /// Apple Health metric this goal auto-tracks (Tier 1 discoverable picker). Picking one
    /// sets the unit + a suggested target — no typing — and, since the unit then matches,
    /// the Log sheet's read-&-suggest card lights up. iPhone-only (HealthKit is absent on
    /// iPad); `nil` = "Manual". The link is carried by the unit today; a persisted
    /// health_metric column + auto-sync are the next slice (see docs/design/healthkit-goals.md).
    @State private var healthMetric: HealthKitBridge.Metric?
    @State private var autoFromHealth = false
    /// Daily threshold for a health-linked *habit* ("2,000 steps a day"). Unused by
    /// total/count goals, which accumulate toward `target` instead.
    @State private var healthDailyTarget = ""
    /// Presents the "set a goal from your Health data" discovery picker (Piece 1).
    @State private var showHealthPicker = false
    private var healthAvailable: Bool { HealthKitBridge.shared.isAvailable }
    /// The selected metric only when it actually fits this goal type — the gate the link +
    /// daily target are sent under, so a stranded pick (ring on a total goal) never posts.
    private var activeHealthMetric: HealthKitBridge.Metric? {
        guard canAutoFromHealth, autoFromHealth, let m = healthMetric, m.applies(toGoalType: goalType) else { return nil }
        return m
    }
    /// Health auto-fill applies to numeric goals (accumulate) and habits (daily
    /// threshold), but not checklists — and only on a device with HealthKit (iPhone).
    private var canAutoFromHealth: Bool { healthAvailable && !isChecklist }

    /// Mirrors the web's per-type validation: a name, plus a valid measure.
    private var canSave: Bool {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        switch goalType {
        case "checklist": return !filledSteps.isEmpty
        case "habit":     return (Int(habitPer) ?? 0) > 0
        default:          return (Double(target) ?? 0) > 0 && !unit.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isKiosk { iPadBody } else { iPhoneBody }
            }
            .background(WF.canvas)
            .navigationTitle(editGoal == nil ? "New goal" : "Edit goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                // iPad keeps Create in the nav bar; iPhone moves it to the pinned
                // bottom bar (matching the mobile mock), so no confirmationAction there.
                if isKiosk {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(editGoal == nil ? "Create" : "Save") { submit() }.fontWeight(.semibold).disabled(!canSave)
                    }
                }
            }
            .onAppear(perform: prefill)
            // New goal: land in the name field. (Edits keep the keyboard down.)
            .task { if editGoal == nil { try? await Task.sleep(for: .milliseconds(300)); titleFocused = true } }
            .task(id: goalListId) { await loadListSpotlight() }
            // Auto-derived milestones track the target/type until the user hand-edits
            // them (see `reDeriveIfUntouched`). Create only — edits keep the goal's own.
            .onChange(of: goalType) { _, _ in reDeriveIfUntouched() }
            .onChange(of: target) { _, _ in reDeriveIfUntouched() }
            .onChange(of: hasRewards) { _, on in if on { reDeriveIfUntouched() } }
            .sheet(isPresented: $creatingList) {
                GoalListCreateSheet(members: members) { list in
                    localLists.append(list)
                    goalListId = list.id
                }
            }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    // MARK: layout — iPhone (single column, sticky preview, pinned CTA) vs iPad (two-pane)

    /// iPhone: a scrolling single column with the compact live preview pinned to the
    /// top and a full-width "Create goal" button pinned to the bottom (mobile mock).
    private var iPhoneBody: some View {
        ScrollView {
            formColumn(showNameHint: false)
                .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 24)
        }
        .background(WF.canvas)
        .safeAreaInset(edge: .top, spacing: 0) {
            compactPreview
                .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 12)
                .background(WF.canvas)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
    }

    /// iPad: a focused form column on the left, a generous live-preview stage on the
    /// right (the "web" redesign layout). Create stays in the nav bar.
    private var iPadBody: some View {
        HStack(spacing: 0) {
            ScrollView {
                formColumn(showNameHint: true)
                    .frame(maxWidth: 620, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 48).padding(.top, 8).padding(.bottom, 56)
            }
            previewPane.frame(width: 480)
        }
        .background(WF.canvas)
    }

    private var previewPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Live preview")
            Text("How this goal appears on the family hub.")
                .font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.ink2).padding(.top, 4)
            Spacer(minLength: 24)
            generousPreview
            Spacer(minLength: 24)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(28)
        .background(WF.panel)
        .overlay(alignment: .leading) { Rectangle().fill(WF.hair).frame(width: 1) }
    }

    /// The shared form sections. `showNameHint` adds the extra name subtitle the iPad
    /// mock carries; the iPhone mock omits it.
    private func formColumn(showNameHint: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            mockSection("Name your goal", hint: showNameHint ? "A short, motivating title your family will see." : nil, first: true) {
                TextField("1,000 Hours Outside", text: $title)
                    .font(WF.serif(showNameHint ? 24 : 20)).textInputAutocapitalization(.words)
                    .focused($titleFocused)
                    .padding(.horizontal, 16).padding(.vertical, 14)
                    .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1.5))
                    .wfShadow1()
            }
            mockSection("Who’s it for?", hint: "Pick a goal list — the people in it share this goal.") {
                whoChips
            }
            mockSection("How do you measure it?", hint: "This shapes how progress is logged and shown.") {
                measureCards
                measureRow.padding(.top, 4)
                // Shared-vs-each lives below the measure — it only matters once a measure
                // with a per-person dimension is chosen (hidden for a checklist).
                if participantCount > 1 && !isChecklist { shareSegment.padding(.top, 14) }
                countReveal
            }
            mockSection("Category", hint: "Where this counts toward a balanced life.") { categoryChips }
            mockSection("Extras", hint: "All optional. Turn on only what this goal needs.") { extras }
        }
    }

    /// A form section in the redesign style: a hairline top rule (except the first),
    /// a bold sentence-case title, an optional gray hint, then content.
    private func mockSection<V: View>(_ title: String, hint: String?, first: Bool = false, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !first { Rectangle().fill(WF.hair2).frame(height: 1).padding(.bottom, 18) }
            Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
            if let hint {
                Text(hint).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, 3)
            }
            content().padding(.top, 12)
        }
        .padding(.top, first ? 8 : 0)
        // Breathing room before the next section's hairline rule, so fields
        // (e.g. the deadline picker) don't butt straight up against it.
        .padding(.bottom, 22)
    }

    private func typeCard(_ t: TypeOpt) -> some View {
        let on = goalType == t.key
        return Button { withAnimation(.easeOut(duration: 0.15)) { selectMeasure(t.key) } } label: {
            HStack(spacing: 12) {
                WaffledEmojiTile(emoji: t.emoji)
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text(t.desc).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer()
                if on { Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(WF.primary) }
            }
            .padding(12)
            .background(on ? WF.primary.opacity(0.08) : WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(on ? WF.primary : WF.hair, lineWidth: on ? 1.5 : 1))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var measureRow: some View {
        VStack(spacing: 10) {
            if isChecklist {
                stepsEditor
            } else {
                HStack(spacing: 10) {
                    if isHabit {
                        numField($habitPer, width: 70)
                        Text("× a").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                        Picker("Period", selection: $habitPeriod) {
                            Text("day").tag("day"); Text("week").tag("week"); Text("month").tag("month")
                        }
                        .pickerStyle(.menu).tint(WF.ink)
                        Spacer()
                    } else {
                        numField($target, width: 90)
                        plainField("hours", text: $unit)
                    }
                }
            }
            Toggle(isOn: $hasDeadline.animation()) {
                Text(isChecklist ? "Finish by a date" : (isHabit ? "Keep it up until" : "Set a deadline"))
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
            }
            .tint(FamilyColor.person3.solid)
            if hasDeadline {
                DatePicker("Deadline", selection: $deadline, displayedComponents: .date)
                    .datePickerStyle(.compact).labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The "Counting" card + picker revealed when "Auto-fill from Apple Health" is on
    /// (Extras). No "Manual" choice — the toggle off = manual. The selected metric shows
    /// as a tappable row (mock design) that opens the grouped "Track from Apple Health"
    /// sheet; picking fills the unit + a suggested target automatically.
    private var healthMetricChips: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(isHabit ? "Waffled fills qualifying days in the background — pick what counts a day."
                         : "Waffled fills progress in the background — pick what to count.")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            countingRow
            if let m = healthMetric {
                Text(m.explanation)
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                if isHabit { habitQualification(m) }
            }
            // "Set a goal from your Health data": the same sheet, framed as discovery.
            Button { showHealthPicker = true } label: {
                Text("See your Health data →")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ai)
            }
            .buttonStyle(.plain)
            // iOS never re-prompts once a choice is made — the only recovery is Settings.
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } label: {
                Text("Not seeing your data? Manage access in Settings")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            .buttonStyle(.plain)
        }
        // A goal-type switch can strand the selected metric. A workout pick swaps to its
        // sibling measure (swim-minutes total → swim-sessions count); anything else falls
        // back to steps, which fits every numeric/habit goal.
        .onChange(of: goalType) { _, newType in
            if let m = healthMetric, !m.applies(toGoalType: newType) {
                if let sib = m.workoutSibling, sib.applies(toGoalType: newType) { selectHealthMetric(sib) }
                else { selectHealthMetric(.steps) }
            }
        }
        .sheet(isPresented: $showHealthPicker) {
            HealthDataPickerSheet(goalType: goalType, selected: healthMetric, onPick: pickFromHealth)
        }
    }

    /// The selected-metric card (mock): emoji tile, COUNTING overline, name, what it
    /// fills in. Tapping opens the picker.
    private var countingRow: some View {
        let m = healthMetric ?? .steps
        return Button { showHealthPicker = true } label: {
            HStack(spacing: 12) {
                WaffledEmojiTile(emoji: m.emoji, size: 20, frame: 44, cornerRadius: 12)
                VStack(alignment: .leading, spacing: 2) {
                    Text("COUNTING").font(.system(size: 10.5, weight: .heavy)).tracking(0.8).foregroundStyle(WF.ink3)
                    Text(m.chipLabel).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text(isHabit ? "Counts qualifying days" : "Fills in \(m.label) · unit set automatically")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(12)
            .wfField()
        }
        .buttonStyle(.plain)
    }

    /// How a habit day qualifies. Boolean metrics (rings/mood) are met/not-met — nothing
    /// to set. A workout picks between its two measures via the sibling keys: any session
    /// counts the day, or a daily-minutes threshold. Other quantities keep the
    /// daily-amount field ("2,000 steps a day"), paired with the "N× a week" cadence.
    @ViewBuilder private func habitQualification(_ m: HealthKitBridge.Metric) -> some View {
        if m.isWorkout {
            HStack(spacing: 8) {
                measurePill("Any workout counts", on: m.workoutMeasure == .sessions) {
                    if m.workoutMeasure != .sessions, let sib = m.workoutSibling { selectHealthMetric(sib) }
                }
                measurePill("At least N minutes", on: m.workoutMeasure == .minutes) {
                    if m.workoutMeasure != .minutes, let sib = m.workoutSibling { selectHealthMetric(sib) }
                }
            }
            .padding(.top, 2)
            if m.workoutMeasure == .minutes { reachRow(unitWord: "min") }
        } else if !m.isBoolean {
            reachRow(unitWord: m.label)
        }
    }

    private func reachRow(unitWord: String) -> some View {
        HStack(spacing: 8) {
            Text("Reach").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
            numField($healthDailyTarget, width: 90)
            Text("\(unitWord) a day").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
        }
        .padding(.top, 2)
    }

    private func measurePill(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? .white : WF.ink2)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(on ? WF.ai : WF.card)
                .overlay(Capsule().strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    /// Picking a metric fills a sensible default (a habit's daily threshold, or a numeric
    /// goal's unit + target) and requests read access now (so consent happens at opt-in).
    /// Boolean metrics (rings/mood) carry an implicit threshold of 1 (met/not).
    private func selectHealthMetric(_ m: HealthKitBridge.Metric) {
        let changed = healthMetric != m
        // A measure flip on the SAME activity (the habit qualification pills, or tapping
        // the goal's own activity in the picker) must not wipe a hand-set minutes bar.
        // Compared against the OUTGOING metric, so it must precede the assignment.
        let sameWorkoutActivity = changed && m.workout != nil
            && m.workout?.activity == healthMetric?.workout?.activity
        healthMetric = m
        if isHabit {
            if m.isBoolean {
                healthDailyTarget = "1"
            } else if sameWorkoutActivity {
                // Sessions ignore the field (any workout qualifies; the payload sends 1),
                // so only top up a missing/degenerate value when flipping TO minutes.
                if m.workoutMeasure == .minutes, (Int(healthDailyTarget) ?? 0) <= 1 {
                    healthDailyTarget = String(m.suggestedDailyTarget)
                }
            } else if changed || healthDailyTarget.trimmingCharacters(in: .whitespaces).isEmpty {
                // Daily bar, not the goal target: a workout-sessions habit is "any workout
                // that day" (1); a workout-minutes habit a modest daily 30.
                healthDailyTarget = String(m.suggestedDailyTarget)
            }
        } else if m.isBoolean {
            // A boolean on a *count* goal accumulates met-days ("close the ring 15×"):
            // the unit is days and the target is a count, not the per-day met-value of 1.
            unit = "days"
            if changed || target.trimmingCharacters(in: .whitespaces).isEmpty { target = "20" }
        } else {
            unit = m.label
            target = String(m.suggestedTarget)
        }
        Task { try? await HealthKitBridge.shared.requestReadAuthorization() }
    }

    /// Chosen from the "See your Health data" picker: configure the goal around the metric —
    /// turn auto-fill on, seed a title, and select it. If the current goal type can't take
    /// the metric (e.g. a ring on a total), fall to habit; a boolean already on a count goal
    /// stays a count ("close the ring 15×").
    private func pickFromHealth(_ m: HealthKitBridge.Metric) {
        // The picker lists one row per activity (a habit shows the sessions sibling of a
        // minutes-configured goal), so tapping the already-linked metric — or its
        // sibling — is a confirmation, not a measure reset that would wipe the
        // minutes bar back to a default.
        if m == healthMetric || (m.workoutSibling != nil && m.workoutSibling == healthMetric) {
            showHealthPicker = false
            return
        }
        if !m.applies(toGoalType: goalType) { goalType = "habit" }
        autoFromHealth = true
        if title.trimmingCharacters(in: .whitespaces).isEmpty { title = m.chipLabel }
        selectHealthMetric(m)
        showHealthPicker = false
    }

    /// Named checklist steps (matches the web): numbered rows you edit + add to.
    private var stepsEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { idx, _ in
                HStack(spacing: 8) {
                    Text("\(idx + 1)").font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink3)
                        .frame(width: 26, height: 38).background(WF.panel)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                    TextField("Step \(idx + 1)", text: $steps[idx].label)
                        .font(.system(size: 15, weight: .semibold))
                        .padding(.horizontal, 12).padding(.vertical, 10).background(WF.card)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    if steps.count > 1 {
                        Button { steps.remove(at: idx) } label: {
                            Image(systemName: "minus.circle.fill").font(.system(size: 18)).foregroundStyle(WF.ink3)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            Button { steps.append(.init(existingId: nil, label: "")) } label: {
                Label("Add step", systemImage: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ai)
            }
            .buttonStyle(.plain).padding(.top, 2)
        }
    }

    private func numField(_ text: Binding<String>, width: CGFloat) -> some View {
        TextField("", text: text).keyboardType(.numberPad)
            .font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
            .frame(width: width).padding(.vertical, 11)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func plainField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .font(.system(size: 16, weight: .semibold))
            .padding(.horizontal, 13).padding(.vertical, 11)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    // MARK: form pieces — who / share / category / measure cards

    private var whoChips: some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            ForEach(localLists) { l in
                let on = goalListId == l.id
                Button { goalListId = l.id } label: {
                    HStack(spacing: 7) {
                        AvatarStack(members: l.members, size: 20)
                        Text(l.name).font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(on ? WF.ink : WF.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .wfChip(selected: on)
                }
                .buttonStyle(.plain)
            }
            Button { creatingList = true } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 10, weight: .heavy))
                    Text("New group").font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(WF.ink3)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .overlay(Capsule().strokeBorder(WF.hair, style: StrokeStyle(lineWidth: 1.5, dash: [4])))
            }
            .buttonStyle(.plain)
        }
    }

    private var shareSegment: some View {
        HStack(spacing: 4) {
            segButton(isHabit ? "One shared streak" : "One shared total", selected: shared) { setSharedMode() }
            segButton(isHabit ? "Each keeps their own" : "Each tracks their own", selected: !shared) { setEachMode() }
        }
        .padding(4).background(WF.panel).clipShape(Capsule())
    }
    private func segButton(_ label: String, selected: Bool, _ action: @escaping () -> Void) -> some View {
        Button { withAnimation(.easeOut(duration: 0.15)) { action() } } label: {
            Text(label)
                .font(.system(size: 12.5, weight: selected ? .bold : .semibold))
                .foregroundStyle(selected ? WF.ink : WF.ink2)
                .frame(maxWidth: .infinity).padding(.vertical, 9)
                .background { if selected { Capsule().fill(WF.card).wfShadow1() } }
        }
        .buttonStyle(.plain)
    }

    // ── measure-aware group counting ("Counting Below Measure") ────────────────
    private struct CountOpt { let k, emoji, title: String }
    private var countOptions: [CountOpt] {
        goalType == "total"
            ? [CountOpt(k: "full", emoji: "👥", title: "Everyone’s counts fully"),
               CountOpt(k: "split", emoji: "➗", title: "Split across who took part")]
            : [CountOpt(k: "each", emoji: "👥", title: "Count it for each person"),
               CountOpt(k: "once", emoji: "✅", title: "Count the activity once")]
    }
    @ViewBuilder private var countReveal: some View {
        if shared && participantCount > 1 && (goalType == "total" || goalType == "count") {
            VStack(alignment: .leading, spacing: 9) {
                Text("When a shared activity includes more than one person…")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink)
                Text("How should a group entry add up toward the total?")
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                ForEach(countOptions, id: \.k) { countRow($0) }
                workedBox
            }
            .padding(.top, 14)
        }
    }
    private func countRow(_ o: CountOpt) -> some View {
        let on = countChoice == o.k
        return Button { withAnimation(.easeOut(duration: 0.15)) { setCountChoice(o.k) } } label: {
            HStack(spacing: 13) {
                Text(o.emoji).font(.system(size: 20))
                VStack(alignment: .leading, spacing: 3) {
                    Text(o.title).font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                    countExample(o.k)
                }
                Spacer(minLength: 0)
                ZStack {
                    Circle().strokeBorder(on ? WF.primary : WF.hair, lineWidth: 2).frame(width: 20, height: 20)
                    if on {
                        Circle().fill(WF.primary).frame(width: 20, height: 20)
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .black)).foregroundStyle(.white)
                    }
                }
            }
            .padding(14)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(on ? WF.primary : WF.hair, lineWidth: on ? 1.5 : 1))
        }
        .buttonStyle(.plain)
    }
    /// Per-row example with the arithmetic delta highlighted (mirrors web `.rex b`).
    private func countExample(_ k: String) -> Text {
        let u = unitOrDefault
        let pre: String, bold: String, post: String
        switch k {
        case "full":  (pre, bold, post) = ("2 people, 1 \(singular(u)) each → ", "+2 \(u)", "")
        case "split": (pre, bold, post) = ("1 \(singular(u)) together, 2 people → ", "+1 \(singular(u))", ", ½ each")
        case "each":  (pre, bold, post) = ("\(participantCount) at once → ", "+\(participantCount)", " (one each)")
        default:      (pre, bold, post) = ("\(participantCount) at once → ", "+1", ", they’re just who came")
        }
        return (Text(pre).foregroundStyle(WF.ink2)
                + Text(bold).foregroundStyle(WF.primary).fontWeight(.heavy)
                + Text(post).foregroundStyle(WF.ink2))
            .font(.system(size: 12, weight: .semibold))
    }
    private var workedNames: [String] {
        (selectedList?.members.map { $0.name } ?? editGoal?.participants.map { $0.name } ?? [])
            .map { $0.split(separator: " ").first.map(String.init) ?? $0 }
    }
    private var workedBox: some View {
        let names = workedNames
        let two = names.prefix(2).joined(separator: " + ")
        let some = (names.count > 3 ? Array(names.prefix(3)) + ["…"] : names).joined(separator: ", ")
        let u = unitOrDefault
        let icon: String, lead: String, delta: String, tail: String
        if goalType == "total" {
            if countChoice == "split" {
                (icon, lead, delta, tail) = ("🌳", "\(two.isEmpty ? "Two people" : two), 1 \(singular(u)) outside together → total ", "+1 \(singular(u))", ", ½ each.")
            } else {
                (icon, lead, delta, tail) = ("🌳", "\(two.isEmpty ? "Two people" : two), 1 \(singular(u)) each → total ", "+2 \(u)", ".")
            }
        } else {
            if countChoice == "once" {
                (icon, lead, delta, tail) = ("🏞️", "Log “\(some.isEmpty ? "everyone" : some)” → the total goes up by ", "1", " \(u).")
            } else {
                (icon, lead, delta, tail) = ("🏞️", "Log “\(some.isEmpty ? "everyone" : some)” → the total goes up by ", "\(max(2, participantCount))", " (one each).")
            }
        }
        return HStack(spacing: 12) {
            Text(icon).font(.system(size: 17))
                .frame(width: 34, height: 34)
                .background(WF.primary.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            (Text(lead).foregroundStyle(WF.ink2)
                + Text(delta).foregroundStyle(WF.ink).fontWeight(.heavy)
                + Text(tail).foregroundStyle(WF.ink2))
                .font(.system(size: 12.5, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 15).padding(.vertical, 13)
        .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair2, lineWidth: 1))
    }
    private var unitOrDefault: String {
        let u = unit.trimmingCharacters(in: .whitespaces)
        return u.isEmpty ? (goalType == "total" ? "hr" : "visit") : u
    }
    private func singular(_ u: String) -> String { (u.count > 1 && u.hasSuffix("s")) ? String(u.dropLast()) : u }

    private var categoryChips: some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            ForEach(Self.categories, id: \.self) { k in
                let on = category == k
                let c = GoalStyle.color(k)
                Button { category = k } label: {
                    Text("\(GoalStyle.emoji(k)) \(Self.categoryLabel[k] ?? k)")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(on ? c : WF.ink2)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .wfChip(selected: on, tint: c)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Measure type cards — a single column on iPhone, a 2-up grid on iPad.
    @ViewBuilder private var measureCards: some View {
        if isKiosk {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], alignment: .leading, spacing: 10) {
                ForEach(Self.types, id: \.key) { typeCard($0) }
            }
        } else {
            VStack(spacing: 9) {
                ForEach(Self.types, id: \.key) { typeCard($0) }
            }
        }
    }

    // MARK: Spotlight / Pinned / Normal tier

    enum Tier: Hashable { case spotlight, pinned, normal }
    private var tier: Tier { isSpotlight ? .spotlight : isFeatured ? .pinned : .normal }
    private var tierBinding: Binding<Tier> {
        Binding(get: { tier }, set: { t in isSpotlight = t == .spotlight; isFeatured = t == .pinned })
    }
    private var tierHint: String {
        switch tier {
        case .spotlight: return "The one big hero card for this list — only one goal can be the spotlight."
        case .pinned:    return "Pinned to the top of the goals list, above the rest."
        case .normal:    return "Lives in the goals list with everything else."
        }
    }
    /// Look up the list's current spotlight (a different goal) so the picker can name it.
    private func loadListSpotlight() async {
        guard let lid = goalListId else { listSpotlightTitle = nil; return }
        let gs = (try? await tierApi.goalsIn(listId: lid)) ?? []
        listSpotlightTitle = gs.first { ($0.isSpotlight ?? false) && $0.id != editGoal?.id }?.title
    }
    private var tierPickerRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 13) {
                Text("🌟").font(.system(size: 18)).frame(width: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Spotlight & pinned").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    Text("How prominent this goal is on the home screen and goals list")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink2).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            Picker("", selection: tierBinding) {
                Text("🌟 Spotlight").tag(Tier.spotlight)
                Text("📌 Pinned").tag(Tier.pinned)
                Text("Normal").tag(Tier.normal)
            }
            .pickerStyle(.segmented)
            Text(tierHint).font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
            if tier == .spotlight, let t = listSpotlightTitle {
                Text("Replaces “\(t)” as this list’s spotlight (it becomes Pinned).")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 14)
    }

    // MARK: Extras (flat, hairline-divided rows — matching the mock's "Extras" group)

    private var extras: some View {
        VStack(spacing: 0) {
            tierPickerRow
            Divider().overlay(WF.hair)
            extraRow("🏆", "Milestones & rewards", "Bonus stars at thresholds you set", $hasRewards)
            if hasRewards { milestoneEditor.padding(.top, 4).padding(.bottom, 10) }
            // Auto-count is offered for total/count/habit only — a checklist's progress
            // comes from ticking steps, not from calendar events.
            if !isChecklist {
                extraRow("📅", "Auto-count from calendar", "Matching events add progress automatically", $autoFromCalendar)
            }
            // Apple Health auto-fill — an opt-in enhancement alongside calendar auto-count.
            // Off = you log manually; on = pick a metric and progress fills from Health.
            // iPhone-only + numeric goals only. The custom binding runs the pick/clear only
            // on a real user toggle (prefill sets the @State directly, so it can't clobber
            // a saved target).
            if canAutoFromHealth {
                extraRow("⌚", "Auto-fill from Apple Health", "Progress fills from your iPhone & Apple Watch",
                         Binding(get: { autoFromHealth }, set: { on in
                             autoFromHealth = on
                             if on { selectHealthMetric(healthMetric ?? .steps) } else { healthMetric = nil }
                         }))
                if autoFromHealth { healthMetricChips.padding(.top, 4).padding(.bottom, 10) }
            }
            // NOTE: the mock's "🔔 Weekly check-in" toggle is intentionally omitted —
            // there's no backend for it yet (tracked in docs/product/roadmap.md).
            Text("Rewards are off by default — goals stay about growth, not points. Turn them on per goal when a little extra motivation helps.")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)
        }
    }

    private func extraRow(_ icon: String, _ title: String, _ sub: String, _ on: Binding<Bool>, first: Bool = false) -> some View {
        VStack(spacing: 0) {
            if !first { Rectangle().fill(WF.hair2).frame(height: 1) }
            HStack(spacing: 12) {
                WaffledEmojiTile(emoji: icon, size: 17, frame: 34, cornerRadius: 10)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(WF.ink)
                    Text(sub).font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 8)
                Toggle("", isOn: on.animation()).labelsHidden().tint(FamilyColor.person3.solid)
            }
            .padding(.vertical, 14)
        }
    }

    /// Re-derive the starter milestones from the current target/type — but only while
    /// the user hasn't hand-edited them (signature still matches the last derived set).
    private func reDeriveIfUntouched() {
        guard editGoal == nil else { return }
        guard Self.signature(milestones) == lastDerivedSig else { return }
        let d = Self.derivedMilestones(type: goalType, target: Int(target) ?? 0)
        milestones = d
        lastDerivedSig = Self.signature(d)
    }

    // MARK: live preview

    private static let coralGradient = LinearGradient(colors: [Color(hex: 0xEF6A52), WF.primaryD],
                                                      startPoint: .topLeading, endPoint: .bottomTrailing)
    private static let previewDF: DateFormatter = { let f = DateFormatter(); f.dateFormat = "MMM d"; return f }()

    private var previewTitle: String {
        title.trimmingCharacters(in: .whitespaces).isEmpty ? "Name your goal" : title
    }

    private func previewSubtitle(shared: Bool) -> String {
        let u = unit.trimmingCharacters(in: .whitespaces).isEmpty ? "units" : unit.trimmingCharacters(in: .whitespaces)
        let dl = hasDeadline ? " · by \(Self.previewDF.string(from: deadline))" : ""
        let base: String
        switch goalType {
        case "count": base = "Count to \(target) \(u)\(dl)"
        case "habit": base = "\(habitPer)× a \(habitPeriod) · keep the streak going"
        case "checklist": base = "A checklist of steps you tick off"
        default: base = "Adds up in \(u)\(dl)"
        }
        if goalType == "habit" || goalType == "checklist" { return base }
        return base + (shared ? " · shared" : " · each their own")
    }

    private func previewRing(size: CGFloat, featured: Bool) -> some View {
        GoalRing(value: 0, size: size, lineWidth: max(3, size * 0.1),
                 stroke: .clear, track: featured ? Color.white.opacity(0.3) : WF.panel) {
            Text("0").font(WF.serif(size * 0.32)).foregroundStyle(featured ? Color.white : WF.ink3)
        }
    }

    /// The pinned compact preview at the top of the iPhone form.
    private var compactPreview: some View {
        let shared = trackingMode == "shared_total"
        let feat = tier != .normal // Spotlight or Pinned both get the elevated coral preview
        return HStack(spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(feat ? AnyShapeStyle(Color.white.opacity(0.18)) : AnyShapeStyle(WF.dangerT))
                Text("🎯").font(.system(size: 24))
            }
            .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 2) {
                if feat {
                    Text(tier == .spotlight ? "🌟 SPOTLIGHT" : "📌 PINNED").font(.system(size: 9.5, weight: .heavy)).tracking(0.3).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Color.white.opacity(0.2), in: Capsule())
                }
                Text(previewTitle).font(WF.serif(17)).lineLimit(1)
                    .foregroundStyle(feat ? Color.white : (title.trimmingCharacters(in: .whitespaces).isEmpty ? WF.ink3 : WF.ink))
                Text(previewSubtitle(shared: shared)).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                    .foregroundStyle(feat ? Color.white.opacity(0.9) : WF.ink2)
            }
            Spacer(minLength: 0)
            if !isChecklist { previewRing(size: 40, featured: feat) }
        }
        .padding(13)
        .background(feat ? AnyShapeStyle(Self.coralGradient) : AnyShapeStyle(WF.card))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(feat ? Color.clear : WF.hair2, lineWidth: 1))
        .wfShadow1()
    }

    private var bottomBar: some View {
        WaffledPrimaryCTA(label: editGoal == nil ? "Create goal" : "Save changes",
                          tint: WF.primary, isDisabled: !canSave) { submit() }
            .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 10)
            .background(WF.canvas)
            .overlay(alignment: .top) { Rectangle().fill(WF.hair).frame(height: 1) }
    }

    /// The generous iPad preview: hero (featured) or plain card, an optional milestone
    /// track, and a "where it lives" caption.
    private var generousPreview: some View {
        let shared = trackingMode == "shared_total"
        return VStack(alignment: .leading, spacing: 16) {
            if tier != .normal { featuredHero(shared: shared) } else { plainPreviewCard(shared: shared) }
            if hasRewards {
                let nodes = Array(milestones.filter { !$0.threshold.isEmpty }.prefix(4))
                if !nodes.isEmpty { milestoneTrack(nodes) }
            }
            HStack(spacing: 8) {
                Image(systemName: "display").font(.system(size: 13, weight: .semibold))
                Text(tier == .spotlight ? "The spotlight on the home screen" : tier == .pinned ? "Pinned to the top of the goals list" : "Lives in the goals list")
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(WF.ink3)
            .frame(maxWidth: .infinity)
        }
    }

    private func featuredHero(shared: Bool) -> some View {
        HStack(alignment: .center, spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 17, style: .continuous).fill(Color.white.opacity(0.18))
                Text("🎯").font(.system(size: 30))
            }
            .frame(width: 60, height: 60)
            VStack(alignment: .leading, spacing: 3) {
                Text("★ FEATURED · \(shared ? "SHARED" : "EACH TRACKS")")
                    .font(.system(size: 10.5, weight: .heavy)).tracking(0.4).foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 3).background(Color.white.opacity(0.2), in: Capsule())
                Text(previewTitle).font(WF.serif(23)).foregroundStyle(.white).lineLimit(2)
                Text(previewSubtitle(shared: shared)).font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.92)).lineLimit(2)
            }
            Spacer(minLength: 0)
            if !isChecklist { previewRing(size: 60, featured: true) }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.coralGradient)
        .clipShape(RoundedRectangle(cornerRadius: WF.rXL, style: .continuous))
        .wfShadow3()
    }

    private func plainPreviewCard(shared: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 15, style: .continuous).fill(WF.dangerT)
                    Text("🎯").font(.system(size: 27))
                }
                .frame(width: 52, height: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(shared ? "SHARED GOAL" : "EACH TRACKS OWN")
                        .font(.system(size: 11, weight: .heavy)).tracking(0.3).foregroundStyle(WF.ink3)
                    Text(previewTitle).font(WF.serif(20)).foregroundStyle(WF.ink).lineLimit(2)
                    Text(previewSubtitle(shared: shared)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            if !isChecklist {
                Capsule().fill(WF.panel).frame(height: 9).padding(.top, 18)
                Text("0 of \(target) \(unit.trimmingCharacters(in: .whitespaces)) · just getting started")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2).padding(.top, 9)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .wfShadow1()
    }

    private func milestoneTrack(_ nodes: [Milestone]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("MILESTONES & REWARDS").font(.system(size: 12, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ink3)
            ZStack(alignment: .top) {
                Capsule().fill(WF.hair).frame(height: 3).padding(.horizontal, 20).padding(.top, 15)
                HStack(alignment: .top, spacing: 0) {
                    ForEach(nodes) { m in
                        VStack(spacing: 6) {
                            ZStack {
                                Circle().fill(WF.panel).overlay(Circle().strokeBorder(WF.card, lineWidth: 3))
                                Text(m.emoji).font(.system(size: 15))
                            }
                            .frame(width: 32, height: 32)
                            Text(m.threshold).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink)
                            if !m.reward.isEmpty {
                                Text(m.reward).font(.system(size: 10, weight: .semibold)).foregroundStyle(WF.ink3)
                                    .multilineTextAlignment(.center).lineLimit(2)
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .wfShadow1()
    }

    /// What a milestone's "number" means for the current goal type (mirrors the web).
    private var milestoneHint: String {
        switch goalType {
        case "habit":
            return "Number = 🔥 streak days (e.g. 30 → reward at a 30-day streak)"
        case "checklist":
            return "Number = % complete — enter 80 for 80% (100 = all steps done)"
        default:
            let u = unit.trimmingCharacters(in: .whitespaces)
            let noun = u.isEmpty ? "amount" : u
            let example = u.isEmpty ? "500" : "500 \(u)"
            return "Number = \(noun) reached (e.g. 500 → reward at \(example))"
        }
    }

    private var milestoneEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Milestones & rewards")
            Text(milestoneHint)
                .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            ForEach($milestones) { $m in
                HStack(spacing: 8) {
                    TextField("🎯", text: $m.emoji).frame(width: 38).multilineTextAlignment(.center)
                        .padding(.vertical, 9).background(WF.card)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    TextField("0", text: $m.threshold).keyboardType(.numberPad).frame(width: 64)
                        .multilineTextAlignment(.center).font(.system(size: 14, weight: .semibold))
                        .padding(.vertical, 9).background(WF.card)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    TextField("reward", text: $m.reward).font(.system(size: 14, weight: .semibold))
                        .padding(.horizontal, 11).padding(.vertical, 9).background(WF.card)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    Button { milestones.removeAll { $0.id == m.id } } label: {
                        Image(systemName: "minus.circle.fill").font(.system(size: 18)).foregroundStyle(WF.ink3)
                    }
                    .buttonStyle(.plain)
                }
            }
            Button { milestones.append(.init(emoji: "🎯", threshold: "0", reward: "")) } label: {
                Label("Add milestone", systemImage: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ai)
            }
            .buttonStyle(.plain).padding(.top, 2)
        }
    }

    /// One-shot prefill: defaults for create, the existing goal's values for edit.
    private func prefill() {
        guard !didPrefill else { return }
        didPrefill = true
        if localLists.isEmpty { localLists = lists }
        guard let g = editGoal else {
            if goalListId == nil { goalListId = defaultListId ?? lists.first?.id }
            return
        }
        title = g.title
        goalListId = g.goalListId
        trackingMode = g.trackingMode
        participantMode = g.participantMode ?? "count_once"
        targetBasis = g.targetBasis ?? "family"
        goalType = g.goalType
        category = g.category ?? "physical"
        unit = g.unit ?? ""
        if let t = g.target { target = goalFmt(t) }
        habitPeriod = g.habitPeriod ?? "week"
        if let h = g.habitTargetPerPeriod { habitPer = String(h) }
        isFeatured = g.isFeatured
        isSpotlight = g.isSpotlight ?? false
        hasRewards = g.hasRewards
        autoFromCalendar = g.autoFromCalendar
        if let d = g.deadline, let parsed = Self.parseDay(d) { hasDeadline = true; deadline = parsed }
        if !g.milestones.isEmpty {
            milestones = g.milestones.map {
                .init(emoji: $0.emoji ?? "🎯", threshold: goalFmt($0.threshold), reward: $0.rewardText ?? "")
            }
        }
        if !g.steps.isEmpty {
            steps = g.steps.map { .init(existingId: $0.id, label: $0.label) }
        }
        // Restore the health auto-fill selection from the persisted link (falling back to
        // unit-matching for goals created before health_metric existed). Set the @State
        // directly (not via the toggle's binding) so the saved target isn't overwritten.
        healthMetric = HealthKitBridge.Metric(key: g.healthMetric) ?? HealthKitBridge.Metric.matching(unit: unit)
        autoFromHealth = healthMetric != nil
        if let t = g.healthDailyTarget { healthDailyTarget = goalFmt(t) }
    }

    private static func parseDay(_ iso: String) -> Date? {
        DateFmt.date(String(iso.prefix(10)), "yyyy-MM-dd", DateFmt.utc)
    }

    private func submit() {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        var body: [String: JSONValue] = [
            "title": .string(trimmed),
            "goalListId": goalListId.map(JSONValue.string) ?? .null,
            "category": .string(category),
            "goalType": .string(goalType),
            "trackingMode": .string(trackingMode),
            "participantMode": .string(participantMode),
            "targetBasis": .string(targetBasis),
            "logMethod": .string("quick_log"),
            "isFeatured": .bool(isFeatured),
            "isSpotlight": .bool(isSpotlight),
            "hasRewards": .bool(hasRewards),
            // Checklist progress comes from steps, never from the calendar.
            "autoFromCalendar": .bool(isChecklist ? false : autoFromCalendar),
            "unit": (isHabit || isChecklist) ? .null : (unit.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(unit.trimmingCharacters(in: .whitespaces))),
            // Apple Health link. Null when off/manual or stranded — including on edit, so
            // turning the toggle off (or switching to an incompatible type) clears it server-side.
            "healthMetric": activeHealthMetric.map { .string($0.key) } ?? .null,
            // Daily threshold only for a health-linked habit; null everywhere else.
            // A sessions habit qualifies with ANY workout that day (threshold 1); the
            // text field keeps holding the user's minutes bar so a measure flip
            // round-trips without losing it.
            "healthDailyTarget": (activeHealthMetric != nil && isHabit)
                ? (activeHealthMetric?.workoutMeasure == .sessions
                    ? .double(1)
                    : (Double(healthDailyTarget).map(JSONValue.double) ?? .null))
                : .null,
            "deadline": hasDeadline ? .string(isoDay(deadline)) : .null,
        ]
        if isHabit {
            let n = Int(habitPer) ?? 0
            body["targetValue"] = .int(n)
            body["habitPeriod"] = .string(habitPeriod)
            body["habitTargetPerPeriod"] = .int(n)
        } else if isChecklist {
            body["targetValue"] = .null
            // Named steps; carry the server id on edit so they're updated in place.
            body["steps"] = .array(filledSteps.map { s in
                var obj: [String: JSONValue] = ["label": .string(s.label.trimmingCharacters(in: .whitespaces))]
                if let eid = s.existingId { obj["id"] = .string(eid) }
                return .object(obj)
            })
        } else {
            body["targetValue"] = Double(target).map(JSONValue.double) ?? .null
        }
        // Participants follow the chosen list; on edit with no list, keep the goal's own.
        let memberIds = lists.first { $0.id == goalListId }?.members.map(\.personId) ?? []
        let pids = memberIds.isEmpty ? (editGoal?.participants.map(\.personId) ?? []) : memberIds
        body["participantIds"] = .array(pids.map { .string($0) })
        body["milestones"] = .array(hasRewards ? milestones.map { m in
            .object([
                "threshold": .int(Int(m.threshold) ?? 0),
                "emoji": .string(m.emoji),
                "label": .string(m.threshold),
                "rewardText": .string(m.reward),
            ])
        } : [])
        onSubmit(body, goalListId)
        dismiss()
    }

    private func isoDay(_ d: Date) -> String { DateFmt.string(d, "yyyy-MM-dd", DateFmt.utc) }
}

// MARK: - Goal detail

/// Edit or delete a single logged entry — amount, who took part, note, and date.
/// Mirrors the web EntryModal. (A checklist tick isn't editable here — it's a step.)
struct GoalEntryEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let entry: WaffledAPI.GoalDetail.LogEntry
    let participants: [WaffledAPI.Goal.Participant]
    let goalType: String
    let unit: String?
    /// (amount?, personIds?, note, loggedOn as YYYY-MM-DD)
    let onSave: (Double?, [String]?, String, String) -> Void
    let onDelete: () -> Void

    @State private var amount: Double
    @State private var amountText: String
    @State private var who: Set<String>
    @State private var note: String
    @State private var loggedOn: Date
    @State private var confirmDelete = false

    private var isCount: Bool { goalType == "count" }
    private var numeric: Bool { goalType == "total" || goalType == "count" }
    private var showWho: Bool { participants.count > 1 }
    private var unitSuffix: String { unit.map { " \($0)" } ?? "" }
    private var logAmount: Double { isCount ? max(1, amount.rounded()) : amount }
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    init(entry: WaffledAPI.GoalDetail.LogEntry, participants: [WaffledAPI.Goal.Participant],
         goalType: String, unit: String?,
         onSave: @escaping (Double?, [String]?, String, String) -> Void, onDelete: @escaping () -> Void) {
        self.entry = entry; self.participants = participants; self.goalType = goalType; self.unit = unit
        self.onSave = onSave; self.onDelete = onDelete
        _amount = State(initialValue: entry.amount)
        _amountText = State(initialValue: goalFmt(entry.amount))
        _who = State(initialValue: Set(entry.participants.compactMap { $0.personId }))
        _note = State(initialValue: entry.note ?? "")
        _loggedOn = State(initialValue: GoalEntryEditSheet.parseDay(entry.loggedAt))
    }
    private static func parseDay(_ iso: String) -> Date {
        DateFmt.date(String(iso.prefix(10)), "yyyy-MM-dd", DateFmt.utc) ?? Date()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if numeric {
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Amount")
                            if isCount {
                                HStack(spacing: 18) {
                                    stepBtn("minus", disabled: max(1, amount.rounded()) <= 1) { amount = max(1, amount.rounded() - 1) }
                                    Text("\(Int(max(1, amount.rounded())))\(unitSuffix)").font(WF.serif(22)).foregroundStyle(WF.ink).frame(minWidth: 90)
                                    stepBtn("plus", disabled: false) { amount = amount.rounded() + 1 }
                                    Spacer(minLength: 0)
                                }
                            } else {
                                HStack(spacing: 8) {
                                    TextField("amount", text: $amountText)
                                        .keyboardType(.decimalPad).font(.system(size: 16, weight: .semibold))
                                        .padding(.horizontal, 13).padding(.vertical, 10)
                                        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                                        .frame(width: 120)
                                        // Locale-aware ("2,5"); empty/unparsable = 0 (Save disables)
                                        // — never the stale previous amount the field no longer shows.
                                        .onChange(of: amountText) { _, new in amount = AmountEntry.value(of: new) }
                                    if let u = unit { Text(u).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3) }
                                }
                            }
                        }
                    }
                    if showWho {
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Who took part?")
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(participants, id: \.personId) { p in
                                        let on = who.contains(p.personId)
                                        Button { if on { who.remove(p.personId) } else { who.insert(p.personId) } } label: {
                                            HStack(spacing: 7) {
                                                Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 24)
                                                Text(goalFirstName(p.name)).font(.system(size: 14, weight: .semibold)).foregroundStyle(on ? WF.ink : WF.ink2)
                                                // Always render + fade the checkmark so the chip width stays fixed on select.
                                                Image(systemName: "checkmark.circle.fill").font(.system(size: 14)).foregroundStyle(WF.primary).opacity(on ? 1 : 0)
                                            }
                                            .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6).wfChip(selected: on)
                                        }.buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "When?")
                        DatePicker("", selection: $loggedOn, in: ...Date(), displayedComponents: .date).labelsHidden()
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Note · optional")
                        TextField("What happened", text: $note)
                            .font(.system(size: 16, weight: .semibold))
                            .padding(.horizontal, 13).padding(.vertical, 12)
                            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    }
                    Button {
                        if confirmDelete { onDelete(); dismiss() } else { withAnimation { confirmDelete = true } }
                    } label: {
                        Text(confirmDelete ? "Tap again to delete this entry" : "Delete entry")
                            .font(.system(size: 13, weight: .bold)).foregroundStyle(confirmDelete ? WF.primary : WF.ink3)
                            .frame(maxWidth: .infinity)
                    }.buttonStyle(.plain).padding(.top, 6)
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Edit entry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(numeric ? logAmount : nil,
                               showWho ? Array(who) : nil,
                               note.trimmingCharacters(in: .whitespacesAndNewlines),
                               DateFmt.string(loggedOn, "yyyy-MM-dd", DateFmt.utc))
                        dismiss()
                    }.fontWeight(.semibold)
                    // A cleared amount is 0 — block saving it rather than writing a 0 entry.
                    .disabled(numeric && logAmount == 0)
                }
            }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    private func stepBtn(_ icon: String, disabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button { action(); amountText = goalFmt(amount) } label: {
            Image(systemName: icon).font(.system(size: 16, weight: .bold)).foregroundStyle(disabled ? WF.ink3 : WF.ink)
                .frame(width: 46, height: 46).background(Circle().fill(WF.card).overlay(Circle().strokeBorder(WF.hair, lineWidth: 1)))
        }.buttonStyle(.plain).disabled(disabled)
    }
}

@MainActor
@Observable
final class GoalDetailModel {
    let goal: WaffledAPI.Goal
    private(set) var detail: WaffledAPI.GoalDetail?
    private(set) var lists: [WaffledAPI.GoalList] = []
    private(set) var loading = true
    private(set) var error = false
    private let api = WaffledAPI()

    init(goal: WaffledAPI.Goal) { self.goal = goal }

    func load() async {
        async let d = api.goalDetail(id: goal.id)
        async let l = api.goalLists()
        do { detail = try await d; lists = try await l; error = false }
        catch { self.error = true }
        loading = false
    }

    /// Sync this goal's linked Health metric when the detail is viewed/refreshed, so its
    /// progress fills from the detail too — not only from the goals list. No-op if unlinked.
    func syncHealth() async {
        guard HealthKitBridge.shared.isAvailable,
              let m = HealthKitBridge.Metric(key: detail?.healthMetric ?? goal.healthMetric) else { return }
        try? await HealthKitBridge.shared.requestReadAuthorization()
        let today = Date()
        let start = HealthKitBridge.parseTimestamp(detail?.createdAt ?? goal.createdAt)
        var didSync = false
        for d in HealthKitBridge.daysToSync(syncedThrough: HealthSyncMark.get(goal.id, m), today: today, notBefore: start) {
            if await HealthKitBridge.pushDay(api, goalId: goal.id, metric: m, day: d.day, key: d.key) { didSync = true }
        }
        HealthSyncMark.set(goal.id, m, today)
        if didSync { await load() }
    }

    func update(_ body: [String: JSONValue]) async {
        do { try await api.updateGoal(id: goal.id, body); await load() }
        catch { self.error = true }
    }

    func log(amount: Double, personIds: [String], note: String, loggedOn: String?, hours: Int? = nil, minutes: Int? = nil) async {
        do {
            try await api.logGoalProgress(goalId: goal.id, amount: amount, personIds: personIds, note: note, loggedOn: loggedOn, hours: hours, minutes: minutes)
            await load()
        } catch { self.error = true }
    }

    func delete() async -> Bool {
        do { try await api.deleteGoal(id: goal.id); return true }
        catch { self.error = true; return false }
    }

    func tickStep(_ stepId: String, done: Bool) async {
        do { try await api.tickGoalStep(goalId: goal.id, stepId: stepId, done: done); await load() }
        catch { self.error = true }
    }

    func editEntry(_ logId: String, amount: Double?, personIds: [String]?, note: String?, loggedOn: String?) async {
        do {
            try await api.editGoalLog(goalId: goal.id, logId: logId, amount: amount, personIds: personIds, note: note, loggedOn: loggedOn)
            await load()
        } catch { self.error = true }
    }

    func deleteEntry(_ logId: String) async {
        do { try await api.deleteGoalLog(goalId: goal.id, logId: logId); await load() }
        catch { self.error = true }
    }
}

/// One goal's detail: hero (ring + started/streak/this-week), the milestone ladder,
/// progress by person, and the recent-activity log. Log from the toolbar; delete
/// (tap-twice) pops back. Mirrors the web GoalDetail.
struct GoalDetailView: View {
    let goal: WaffledAPI.Goal
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model: GoalDetailModel
    @State private var logging = false
    @State private var editing = false
    @State private var scheduling = false
    @State private var confirmDelete = false
    /// The recent-activity entry being edited (amount / who / note / date / delete).
    @State private var editEntry: WaffledAPI.GoalDetail.LogEntry?

    private var isChecklist: Bool { (model.detail?.goalType ?? goal.goalType) == "checklist" }
    /// A checklist's "entries" are step ticks — managed by the step rows, not the entry editor.
    private var canEditEntries: Bool { !isChecklist }

    private static let heroGreen = LinearGradient(colors: [Color(hex: 0x2BA86B), Color(hex: 0x1C8A56)],
                                                  startPoint: .topLeading, endPoint: .bottomTrailing)

    // ISO8601DateFormatter is expensive to allocate per call; hoist both parse configs.
    private static let isoFracDF: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let isoDF = ISO8601DateFormatter()

    init(goal: WaffledAPI.Goal, path: Binding<[HubRoute]>) {
        self.goal = goal
        _path = path
        _model = State(initialValue: GoalDetailModel(goal: goal))
    }

    // Prefer the freshly-loaded detail, fall back to the goal we were handed.
    private var unit: String? { model.detail?.unit ?? goal.unit }
    private var target: Double? { model.detail?.target ?? goal.target }
    private var progress: Double { model.detail?.totalProgress ?? goal.totalProgress }
    private var participants: [WaffledAPI.Goal.Participant] { model.detail?.participants ?? goal.participants }
    private var pct: Int { (target ?? 0) > 0 ? min(Int((progress / target!) * 100), 100) : 0 }

    /// The goal handed to the Log sheet — participants/unit come from the loaded
    /// detail, so the "Who?" picker shows even when we arrived via a lightweight
    /// goal (e.g. the person spotlight, which has no participant list).
    private var logGoal: WaffledAPI.Goal {
        WaffledAPI.Goal(id: goal.id, goalListId: goal.goalListId, title: goal.title, emoji: goal.emoji,
                     category: goal.category, goalType: goal.goalType, unit: unit,
                     habitPeriod: goal.habitPeriod, habitTargetPerPeriod: goal.habitTargetPerPeriod,
                     trackingMode: goal.trackingMode,
                     participantMode: model.detail?.participantMode ?? goal.participantMode,
                     targetBasis: model.detail?.targetBasis ?? goal.targetBasis,
                     deadline: goal.deadline, isFeatured: goal.isFeatured, isSpotlight: goal.isSpotlight,
                     target: target, totalProgress: progress, milestoneTotal: goal.milestoneTotal,
                     milestoneReached: goal.milestoneReached, streakDays: goal.streakDays,
                     autoFromCalendar: goal.autoFromCalendar, healthMetric: goal.healthMetric,
                     createdAt: goal.createdAt, participants: participants)
    }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                hero
                actionRow
                if isChecklist, let steps = model.detail?.steps, !steps.isEmpty { stepsCard(steps) }
                if isKiosk {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(spacing: 16) {
                            if !participants.isEmpty { byPersonCard }
                            if let ms = model.detail?.milestones, !ms.isEmpty { milestoneCard(ms) }
                        }
                        .frame(maxWidth: .infinity, alignment: .top)
                        VStack(spacing: 16) { recentCard }
                            .frame(maxWidth: .infinity, alignment: .top)
                    }
                    deleteButton
                } else {
                    if let ms = model.detail?.milestones, !ms.isEmpty { milestoneCard(ms) }
                    if !participants.isEmpty { byPersonCard }
                    recentCard
                    deleteButton
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle(goal.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button("Edit") { editing = true }.disabled(model.detail == nil)
                Button { logging = true } label: {
                    Label("Log", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold)
                }
            }
        }
        .task { await model.load(); await model.syncHealth() }
        .refreshable { await model.load(); await model.syncHealth() }
        .sheet(isPresented: $logging) {
            GoalLogSheet(goal: logGoal, onChanged: { Task { await model.load() } }) { amount, hours, minutes, ids, note, loggedOn in
                Task { await model.log(amount: amount, personIds: ids, note: note, loggedOn: loggedOn, hours: hours, minutes: minutes) }
            }
        }
        .goalEditor(isPresented: $editing) {
            if let d = model.detail {
                GoalCreateSheet(lists: model.lists, defaultListId: d.goalListId, members: sync.members, editGoal: d) { body, _ in
                    Task { await model.update(body) }
                }
            }
        }
        .sheet(isPresented: $scheduling) {
            EventEditSheet(event: nil, initialDate: Date(),
                           prefillGoalId: goal.id,
                           prefillParticipantIds: participants.map(\.personId))
        }
        .sheet(item: $editEntry) { entry in
            GoalEntryEditSheet(
                entry: entry,
                participants: participants,
                goalType: model.detail?.goalType ?? goal.goalType,
                unit: unit,
                onSave: { amount, ids, note, day in
                    Task { await model.editEntry(entry.id, amount: amount, personIds: ids, note: note, loggedOn: day) }
                },
                onDelete: { Task { await model.deleteEntry(entry.id) } }
            )
        }
    }

    private func stepsCard(_ steps: [WaffledAPI.GoalDetail.Step]) -> some View {
        detailCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("STEPS").font(.system(size: 12.5, weight: .heavy)).foregroundStyle(WF.ink3).tracking(0.4)
                ForEach(steps) { s in
                    Button { Task { await model.tickStep(s.id, done: !s.done) } } label: {
                        HStack(spacing: 11) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .strokeBorder(s.done ? WF.primary : WF.hair, lineWidth: 2).frame(width: 22, height: 22)
                                if s.done {
                                    RoundedRectangle(cornerRadius: 6, style: .continuous).fill(WF.primary).frame(width: 22, height: 22)
                                    Image(systemName: "checkmark").font(.system(size: 12, weight: .black)).foregroundStyle(.white)
                                }
                            }
                            Text(s.label).font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(s.done ? WF.ink3 : WF.ink).strikethrough(s.done, color: WF.ink3)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 6).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Whether this goal opted into calendar counting (drives "Plan time").
    private var autoFromCalendar: Bool { model.detail?.autoFromCalendar ?? goal.autoFromCalendar }

    /// The primary actions under the hero. A prominent green **Log progress** button
    /// (so logging is discoverable without hunting the top-right toolbar), beside the
    /// purple Schedule CTA on iPad, stacked on iPhone.
    @ViewBuilder private var actionRow: some View {
        if isKiosk {
            HStack(spacing: 12) {
                logActionButton
                if autoFromCalendar { planButton }
            }
        } else {
            logActionButton
            if autoFromCalendar { planButton }
        }
    }

    private var logActionButton: some View {
        Button { logging = true } label: {
            HStack(spacing: 7) {
                Image(systemName: "plus.circle.fill").font(.system(size: 15, weight: .bold))
                Text("Log progress").font(.system(size: 14.5, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .background(Self.heroGreen)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    /// "Plan time" (hour goals) / "Schedule" — opens the event editor pre-linked to
    /// this goal, so the new event later shows up on Today to confirm.
    private var planButton: some View {
        let hourly = ["hour", "hours", "hr", "hrs", "minute", "minutes"].contains((unit ?? "").lowercased())
        return Button { scheduling = true } label: {
            HStack(spacing: 7) {
                Image(systemName: "calendar.badge.plus").font(.system(size: 14, weight: .bold))
                Text(hourly ? "Plan time on the calendar" : "Schedule on the calendar")
                    .font(.system(size: 14.5, weight: .bold))
            }
            .foregroundStyle(WF.ai)
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .background(WF.ai.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: hero

    private var hero: some View {
        let frac = (target ?? 0) > 0 ? min(progress / target!, 1) : 0
        return HStack(alignment: .top, spacing: 14) {
            GoalRing(value: frac, size: 104, lineWidth: 9, stroke: .white, track: .white.opacity(0.25)) {
                VStack(spacing: 0) {
                    Text(ringFmt(progress)).font(.system(size: 26, weight: .heavy)).foregroundStyle(.white)
                        .lineLimit(1).minimumScaleFactor(0.5)
                    Text("of \(ringFmt(target))\(unit.map { " \($0)" } ?? "")")
                        .font(.system(size: 9, weight: .bold)).foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(model.detail?.category.map { "\(GoalStyle.emoji($0)) \($0.capitalized)" } ?? "⭐ Featured")
                    .font(.system(size: 10.5, weight: .heavy)).foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(.white.opacity(0.2)).clipShape(Capsule())
                Text(goal.title).font(WF.serif(20)).foregroundStyle(.white).lineLimit(3)
                Text(heroSub).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Text("THIS WEEK").font(.system(size: 9, weight: .heavy)).tracking(0.5).foregroundStyle(.white.opacity(0.8))
                    Text("\(goalFmt(model.detail?.thisWeek ?? 0))\(unit.map { " \($0)" } ?? "")")
                        .font(.system(size: 12, weight: .heavy)).foregroundStyle(.white)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.heroGreen)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
    }

    private var heroSub: String {
        var parts: [String] = []
        if let c = model.detail?.createdAt { parts.append("Started \(monthDay(c))") }
        parts.append("\(pct)% complete")
        let streak = model.detail?.streakDays ?? goal.streakDays
        if streak > 0 { parts.append("🔥 \(streak)-day streak") }
        if let d = model.detail?.deadline ?? goal.deadline { parts.append("by \(monthDay(d))") }
        // Tier 2, Piece 3 — surface that this goal fills itself from Apple Health.
        if let hm = HealthKitBridge.Metric(key: model.detail?.healthMetric ?? goal.healthMetric) {
            parts.append("⌚ Auto from \(hm.chipLabel)")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: milestones

    private func milestoneCard(_ ms: [WaffledAPI.GoalDetail.Milestone]) -> some View {
        let firstUnreached = ms.firstIndex { !$0.reached }
        return detailCard {
            Text("Milestones").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
            VStack(spacing: 0) {
                ForEach(Array(ms.enumerated()), id: \.element.id) { i, m in
                    let isNow = i == firstUnreached
                    HStack(spacing: 12) {
                        Text(m.emoji ?? "⛳").font(.system(size: 16))
                            .frame(width: 34, height: 34)
                            .background(m.reached ? FamilyColor.person3.solid.opacity(0.18) : (isNow ? WF.primary.opacity(0.12) : WF.panel))
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(m.reached ? FamilyColor.person3.solid : (isNow ? WF.primary : Color.clear), lineWidth: 1.5))
                        Text(m.label ?? goalFmt(m.threshold))
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(m.reached || isNow ? WF.ink : WF.ink2)
                        Spacer(minLength: 6)
                        Text(m.reached ? "reached"
                                : isNow ? "\(goalFmt(m.threshold - progress)) to go"
                                : (m.rewardText ?? "—"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(m.reached ? FamilyColor.person3.solid : (isNow ? WF.primary : WF.ink3))
                            .lineLimit(1)
                    }
                    .padding(.vertical, 7)
                    if i < ms.count - 1 { Divider().background(WF.hair) }
                }
            }
        }
    }

    // MARK: by person

    private var byPersonCard: some View {
        let maxProg = max(1, participants.map(\.progress).max() ?? 1)
        return detailCard {
            Text(unit.map { "\($0.prefix(1).uppercased())\($0.dropFirst()) by person" } ?? "By person")
                .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
            VStack(spacing: 11) {
                ForEach(participants, id: \.personId) { p in
                    let color = Color(hexString: p.colorHex) ?? FamilyColor.person1.solid
                    HStack(spacing: 10) {
                        Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 26)
                        Text(goalFirstName(p.name)).font(.system(size: 13, weight: .bold))
                            .foregroundStyle(WF.ink).frame(width: 64, alignment: .leading).lineLimit(1)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(WF.hair)
                                Capsule().fill(color).frame(width: geo.size.width * min(p.progress / maxProg, 1))
                            }
                        }
                        .frame(height: 8)
                        Text("\(goalFmt(p.progress))\(unit.map { " \($0)" } ?? "")")
                            .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(width: 64, alignment: .trailing).lineLimit(1).minimumScaleFactor(0.7)
                    }
                }
            }
        }
    }

    // MARK: recent activity

    private var recentCard: some View {
        detailCard {
            Text("Recent activity").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
            if let r = model.detail?.recent, !r.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(r.enumerated()), id: \.element.id) { i, log in
                        Button { if canEditEntries { editEntry = log } } label: {
                            HStack(spacing: 10) {
                                Text(weekday(log.loggedAt)).font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(WF.ink3).frame(width: 34, alignment: .leading)
                                if log.participants.isEmpty {
                                    Avatar(colorHex: nil, emoji: "🙂", size: 24)
                                } else {
                                    // Split-pool logs collapse to one row; show everyone credited
                                    // as an overlapping avatar cluster (matches AvatarStack).
                                    HStack(spacing: -24 * 0.34) {
                                        ForEach(log.participants.prefix(4)) { p in
                                            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 24)
                                                .overlay(Circle().strokeBorder(WF.canvas, lineWidth: 2))
                                        }
                                    }
                                }
                                Text(log.note?.isEmpty == false ? log.note! : "Logged progress")
                                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                                Spacer(minLength: 6)
                                Text("+\(goalFmt(log.amount))\(unit.map { " \($0)" } ?? "")")
                                    .font(.system(size: 13, weight: .bold)).foregroundStyle(FamilyColor.person3.solid)
                                if canEditEntries {
                                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                                }
                            }
                            .padding(.vertical, 8).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!canEditEntries)
                        if i < r.count - 1 { Divider().background(WF.hair) }
                    }
                }
            } else {
                Text("No activity yet — log some progress.")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3).padding(.vertical, 6)
            }
        }
    }

    private var deleteButton: some View {
        Button {
            if confirmDelete {
                Task { if await model.delete() { if !path.isEmpty { path.removeLast() } } }
            } else {
                withAnimation { confirmDelete = true }
            }
        } label: {
            Text(confirmDelete ? "Tap again to delete this goal" : "Delete goal")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(confirmDelete ? WF.primary : WF.ink3)
        }
        .buttonStyle(.plain)
        .padding(.top, 4).padding(.leading, 2)
    }

    // MARK: helpers

    private func detailCard<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField()
    }

    private func monthDay(_ iso: String) -> String { fmtDate(iso, "MMM d") }
    private func weekday(_ iso: String) -> String { fmtDate(iso, "EEE") }
    private func fmtDate(_ iso: String, _ fmt: String) -> String {
        let date = Self.isoFracDF.date(from: iso) ?? Self.isoDF.date(from: iso)
        guard let date else {
            // Fall back to a plain yyyy-MM-dd date string.
            guard let parsed = DateFmt.date(String(iso.prefix(10)), "yyyy-MM-dd", DateFmt.utc) else { return "" }
            return DateFmt.string(parsed, fmt, .current)
        }
        return DateFmt.string(date, fmt, .current)
    }
}

/// New goal list (membership group) — name, optional emoji, member multi-select,
/// and a private toggle. Creates it server-side and hands the new list back so the
/// caller can select it. Mirrors the web ListModal.
struct GoalListCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let members: [SyncedMember]
    let onCreated: (WaffledAPI.GoalList) -> Void

    @State private var name = ""
    @State private var emoji = ""
    @State private var memberIds: Set<String> = []
    @State private var isPrivate = false
    @State private var saving = false
    @FocusState private var nameFocused: Bool
    private let api = WaffledAPI()

    private var canSave: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !saving }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "List name")
                            TextField("Mom & Dad", text: $name)
                                .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.words)
                                .focused($nameFocused)
                                .padding(.horizontal, 13).padding(.vertical, 12)
                                .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                        }
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Emoji")
                            TextField("💑", text: $emoji)
                                .font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
                                .frame(width: 60).padding(.vertical, 12)
                                .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                                .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Who’s on this list?")
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(members) { m in
                                let on = memberIds.contains(m.id)
                                let c = Color(hexString: m.colorHex) ?? WF.ink3
                                Button {
                                    if on { memberIds.remove(m.id) } else { memberIds.insert(m.id) }
                                } label: {
                                    HStack(spacing: 7) {
                                        Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 24)
                                        Text(goalFirstName(m.name)).font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(on ? WF.ink : WF.ink2)
                                    }
                                    .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                                    .wfChip(selected: on, tint: c)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    Toggle(isOn: $isPrivate) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Private").font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                            Text("Only these members see it").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                    .tint(FamilyColor.person3.solid)
                    .padding(13)
                    .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("New goal list")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { submit() }.fontWeight(.semibold).disabled(!canSave)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { try? await Task.sleep(for: .milliseconds(300)); nameFocused = true }
    }

    private func submit() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let e = emoji.trimmingCharacters(in: .whitespaces)
        guard canSave else { return }
        saving = true
        Task {
            do {
                let id = try await api.addGoalList(name: trimmed, emoji: e.isEmpty ? nil : e,
                                                   memberIds: Array(memberIds), isPrivate: isPrivate)
                let mem = members.filter { memberIds.contains($0.id) }.map {
                    WaffledAPI.GoalList.Member(personId: $0.id, name: $0.name, avatarEmoji: $0.emoji, colorHex: $0.colorHex)
                }
                onCreated(WaffledAPI.GoalList(id: id, name: trimmed, emoji: e.isEmpty ? nil : e,
                                           colorHex: nil, goalCount: 0, members: mem))
                dismiss()
            } catch { saving = false }
        }
    }
}

private extension View {
    /// Presents the goal editor: full-screen on iPad (web-like, so the two-pane
    /// form + live-preview layout has room), a large sheet on iPhone. The iPad used
    /// to get `.presentationSizing(.page)`, which floated a cramped modal the two
    /// columns couldn't fit — full screen matches the web experience.
    @ViewBuilder
    func goalEditor<C: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> C) -> some View {
        if DeviceExperience.current == .kiosk {
            fullScreenCover(isPresented: isPresented, content: content)
        } else {
            sheet(isPresented: isPresented, content: content)
        }
    }
}
