import SwiftUI
import Observation

/// Goals — the membership model from the web kiosk, folded onto one phone screen:
/// a horizontal list-picker (Family / each person) up top, an All/Shared/Each
/// filter, the featured "hero" goal, then a stack of "more" goal cards. Tapping a
/// hero/card opens the Log sheet. Online-only (goals aren't a synced table).
@MainActor
@Observable
final class GoalsModel {
    enum Filter: Hashable { case all, shared, each }

    private(set) var lists: [NookAPI.GoalList] = []
    private(set) var goals: [NookAPI.Goal] = []
    private(set) var loading = true
    private(set) var error = false
    var selectedListId: String?
    var filter: Filter = .all

    private let api = NookAPI()

    var selectedList: NookAPI.GoalList? { lists.first { $0.id == selectedListId } ?? lists.first }
    var isIndividual: Bool { (selectedList?.members.count ?? 0) == 1 }

    /// Goals after the All/Shared/Each filter (the filter only applies to shared lists).
    var visibleGoals: [NookAPI.Goal] {
        goals.filter { g in
            isIndividual || filter == .all
                || (filter == .shared ? g.trackingMode == "shared_total" : g.trackingMode == "each_tracks")
        }
    }
    var featured: NookAPI.Goal? { visibleGoals.first { $0.isFeatured } }
    var more: [NookAPI.Goal] { visibleGoals.filter { $0.id != featured?.id } }

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

    func log(goalId: String, amount: Double, personIds: [String], note: String) async {
        do {
            try await api.logGoalProgress(goalId: goalId, amount: amount, personIds: personIds, note: note)
            await loadGoals()
        } catch { self.error = true }
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
        case "physical":     return FamilyColor.wally.solid
        case "intellectual": return FamilyColor.kevin.solid
        case "spiritual":    return FamilyColor.lottie.solid
        case "creative":     return FamilyColor.kelly.solid
        case "social":       return NK.gold
        default:             return NK.primary
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

/// Whole numbers without a decimal, otherwise a compact form; nil → em dash.
func goalFmt(_ n: Double?) -> String {
    guard let n else { return "—" }
    return n == n.rounded() ? String(Int(n)) : String(format: "%g", n)
}

/// "Count · in books", "Habit · 5× a week", "Count · each logs visits".
func goalDescriptor(_ g: NookAPI.Goal) -> String {
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
            Circle().stroke(track, lineWidth: lineWidth)
            Circle().trim(from: 0, to: max(0, min(value, 1)))
                .stroke(stroke, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            center()
        }
        .frame(width: size, height: size)
    }
}

/// Overlapping member avatars (up to 4) for a goal list.
struct AvatarStack: View {
    let members: [NookAPI.GoalList.Member]
    var size: CGFloat = 24
    var body: some View {
        HStack(spacing: -size * 0.34) {
            ForEach(Array(members.prefix(4).enumerated()), id: \.offset) { _, m in
                Avatar(colorHex: m.colorHex, emoji: m.avatarEmoji ?? "🙂", size: size)
                    .overlay(Circle().strokeBorder(NK.canvas, lineWidth: 2))
            }
        }
    }
}

struct GoalsView: View {
    @Binding var path: [HubRoute]
    @State private var model = GoalsModel()
    @State private var logging: NookAPI.Goal?
    @State private var creating = false

    private static let heroGreen = LinearGradient(colors: [Color(hex: 0x2BA86B), Color(hex: 0x1C8A56)],
                                                  startPoint: .topLeading, endPoint: .bottomTrailing)
    private static let heroOrange = LinearGradient(colors: [Color(hex: 0xF3A93B), Color(hex: 0xE08A1C)],
                                                   startPoint: .topLeading, endPoint: .bottomTrailing)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                listPicker
                if let list = model.selectedList { listHead(list) }
                if !model.isIndividual, model.selectedList != nil { filterSeg }
                if let f = model.featured { hero(f) }
                if !model.more.isEmpty {
                    SectionLabel(text: "More \(model.selectedList?.name ?? "") goals")
                        .padding(.top, 2)
                    ForEach(model.more) { moreCard($0) }
                }
                if !model.loading && model.visibleGoals.isEmpty {
                    Text(model.error ? "Couldn’t load goals." : "No goals here yet — add one with ＋.")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
                        .padding(.vertical, 24)
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Goals")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Image(systemName: "plus") }
            }
        }
        .task { if model.lists.isEmpty { await model.loadLists() } }
        .refreshable { await model.loadLists() }
        .sheet(item: $logging) { g in
            GoalLogSheet(goal: g) { amount, ids, note in
                Task { await model.log(goalId: g.id, amount: amount, personIds: ids, note: note) }
            }
        }
        .sheet(isPresented: $creating) {
            GoalCreateSheet(lists: model.lists, defaultListId: model.selectedList?.id) { body, listId in
                Task { await model.create(body, listId: listId) }
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
                                .foregroundStyle(on ? NK.ink : NK.ink2).lineLimit(1)
                            Text("\(list.goalCount)").font(.system(size: 11, weight: .heavy))
                                .foregroundStyle(NK.ink3)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(NK.panel).clipShape(Capsule())
                        }
                        .padding(.leading, 8).padding(.trailing, 10).padding(.vertical, 7)
                        .background(on ? NK.card : NK.card2)
                        .overlay(Capsule().strokeBorder(on ? NK.ink.opacity(0.22) : NK.hair, lineWidth: on ? 1.5 : 1))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func listHead(_ list: NookAPI.GoalList) -> some View {
        HStack(spacing: 11) {
            AvatarStack(members: list.members, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(list.name).font(NK.serif(20)).foregroundStyle(NK.ink)
                Text("\(list.goalCount) goals · \(listSub(list))")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            Spacer()
        }
    }

    private func listSub(_ l: NookAPI.GoalList) -> String {
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

    @ViewBuilder private func hero(_ g: NookAPI.Goal) -> some View {
        if g.trackingMode == "each_tracks" { eachHero(g) } else { sharedHero(g) }
    }

    private func sharedHero(_ g: NookAPI.Goal) -> some View {
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        let maxProg = max(1, g.participants.map(\.progress).max() ?? 1)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                GoalRing(value: frac, size: 96, lineWidth: 9, stroke: .white, track: .white.opacity(0.25)) {
                    VStack(spacing: 0) {
                        Text(goalFmt(g.totalProgress)).font(.system(size: 23, weight: .heavy)).foregroundStyle(.white)
                        Text("of \(goalFmt(g.target))\(g.unit.map { " \($0)" } ?? "")")
                            .font(.system(size: 9, weight: .bold)).foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
                VStack(alignment: .leading, spacing: 5) {
                    heroPill("⭐ Featured · shared total")
                    Text(g.title).font(NK.serif(19)).foregroundStyle(.white).lineLimit(2)
                    Text("Everyone contributes to one pool\(g.deadline.map { " · by \(fmtDeadline($0))" } ?? "")")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(2)
                }
            }
            if !g.participants.isEmpty {
                VStack(spacing: 8) {
                    ForEach(g.participants, id: \.personId) { contribRow($0, max: maxProg, unit: g.unit) }
                }
            }
            logButton(g, fg: Color(hex: 0x1C8A56))
        }
        .padding(16)
        .background(Self.heroGreen)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { path.append(.goal(g)) }
    }

    private func eachHero(_ g: NookAPI.Goal) -> some View {
        let summed = g.participants.reduce(0.0) { $0 + ($1.target ?? 0) }
        let summedTarget = summed > 0 ? summed : (g.target ?? 0)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                Text(g.emoji ?? "🎯").font(.system(size: 38))
                    .frame(width: 64, height: 64)
                    .background(.white.opacity(0.18)).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                VStack(alignment: .leading, spacing: 5) {
                    heroPill("⭐ Featured · each tracks their own")
                    Text(g.title).font(NK.serif(19)).foregroundStyle(.white).lineLimit(2)
                    Text(g.target.map { "\(goalFmt($0)) \(g.unit ?? "")".trimmingCharacters(in: .whitespaces) + " each" } ?? "Everyone tracks their own")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
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
            logButton(g, fg: Color(hex: 0xC9760F))
        }
        .padding(16)
        .background(Self.heroOrange)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { path.append(.goal(g)) }
    }

    private func heroPill(_ text: String) -> some View {
        Text(text).font(.system(size: 10.5, weight: .heavy))
            .foregroundStyle(.white)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(.white.opacity(0.2)).clipShape(Capsule())
    }

    private func contribRow(_ p: NookAPI.Goal.Participant, max: Double, unit: String?) -> some View {
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

    private func logButton(_ g: NookAPI.Goal, fg: Color) -> some View {
        Button { logging = g } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.system(size: 13, weight: .heavy))
                Text("Log \(g.unit ?? "progress")").font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(fg)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(.white)
            .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: more cards

    private func moreCard(_ g: NookAPI.Goal) -> some View {
        let c = GoalStyle.color(g.category)
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        return Button { path.append(.goal(g)) } label: {
            VStack(alignment: .leading, spacing: 11) {
                HStack(spacing: 12) {
                    Text(g.emoji ?? GoalStyle.emoji(g.category)).font(.system(size: 20))
                        .frame(width: 42, height: 42)
                        .background(c.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(g.title).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                        Text(goalDescriptor(g)).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    HStack(alignment: .firstTextBaseline, spacing: 1) {
                        Text(goalFmt(g.totalProgress)).font(.system(size: 16, weight: .heavy)).foregroundStyle(NK.ink)
                        Text("/\(goalFmt(g.target))").font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(NK.hair)
                        Capsule().fill(c).frame(width: geo.size.width * frac)
                    }
                }
                .frame(height: 7)
                if g.streakDays > 0 {
                    Text("🔥 \(g.streakDays)-day streak")
                        .font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink2)
                }
            }
            .padding(14)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func fmtDeadline(_ iso: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        guard let d = f.date(from: String(iso.prefix(10))) else { return "" }
        let out = DateFormatter(); out.dateFormat = "MMM d"; out.timeZone = TimeZone(identifier: "UTC")
        return out.string(from: d)
    }
}

/// Log progress — quick-amount chips, multi-select "Who", optional note. One log is
/// written per selected person (so per-person sums roll up to the pool). NK-styled.
struct GoalLogSheet: View {
    @Environment(\.dismiss) private var dismiss
    let goal: NookAPI.Goal
    let onSave: (Double, [String], String) -> Void

    @State private var amount: Double
    @State private var amountText: String
    @State private var who: Set<String>
    @State private var note = ""

    private static let hourUnits: Set<String> = ["hour", "hours", "hr", "hrs"]
    private static let activityChips = ["Bike ride", "Park", "Sports", "Outside play", "Reading", "Art"]

    private var isHours: Bool { goal.unit.map { Self.hourUnits.contains($0.lowercased()) } ?? false }
    private var chips: [(label: String, value: Double)] {
        if isHours {
            return [("30m", 0.5), ("1 hr", 1), ("1.5 hr", 1.5), ("2 hr", 2)]
        }
        let u = goal.unit.map { " \($0)" } ?? ""
        return [1, 2, 3, 5].map { (label: "\(Int($0))\(u)", value: Double($0)) }
    }

    init(goal: NookAPI.Goal, onSave: @escaping (Double, [String], String) -> Void) {
        self.goal = goal
        self.onSave = onSave
        let initial = goal.unit.map { GoalLogSheet.hourUnits.contains($0.lowercased()) } ?? false ? 1.0 : 2.0
        _amount = State(initialValue: initial)
        _amountText = State(initialValue: goalFmt(initial))
        _who = State(initialValue: goal.participants.count == 1 ? [goal.participants[0].personId] : [])
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: isHours ? "How long?" : "How much?")
                        chipRow
                        HStack(spacing: 8) {
                            Text("or").font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                            TextField("amount", text: $amountText)
                                .keyboardType(.decimalPad)
                                .font(.system(size: 16, weight: .semibold))
                                .padding(.horizontal, 13).padding(.vertical, 10)
                                .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                                .frame(width: 110)
                                .onChange(of: amountText) { _, new in if let v = Double(new) { amount = v } }
                            if let u = goal.unit { Text(u).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3) }
                        }
                    }

                    if !goal.participants.isEmpty {
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Who?")
                            whoRow
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "What did you do? · optional")
                        TextField("Creek hike + fort building", text: $note)
                            .font(.system(size: 16, weight: .semibold))
                            .padding(.horizontal, 13).padding(.vertical, 12)
                            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(Self.activityChips, id: \.self) { a in
                                Button { note = a } label: {
                                    Text(a).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
                                        .padding(.horizontal, 11).padding(.vertical, 7)
                                        .background(NK.card2).overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle("Log progress")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Log \(goalFmt(amount))\(goal.unit.map { " \($0)" } ?? "")") {
                        onSave(amount, Array(who), note.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(amount == 0)
                }
            }
        }
        .presentationDetents([.large])
    }

    private var chipRow: some View {
        HStack(spacing: 8) {
            ForEach(chips, id: \.label) { c in
                let on = amount == c.value
                Button { amount = c.value; amountText = goalFmt(c.value) } label: {
                    Text(c.label).font(.system(size: 14, weight: .bold))
                        .foregroundStyle(on ? .white : NK.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(on ? NK.primary : NK.card)
                        .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(on ? Color.clear : NK.hair, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
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
                                .foregroundStyle(on ? NK.ink : NK.ink2)
                            if on {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 14)).foregroundStyle(NK.primary)
                            }
                        }
                        .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                        .background(on ? NK.primary.opacity(0.12) : NK.card)
                        .overlay(Capsule().strokeBorder(on ? NK.primary : NK.hair, lineWidth: on ? 1.5 : 1))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 1)
        }
    }
}

/// New goal — title, who-it's-for (goal list), shared/each, type + measure,
/// category, feature + rewards toggles with an inline milestone editor. Mirrors the
/// web GoalCreate, folded into one scrollable sheet. NK-styled.
struct GoalCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let lists: [NookAPI.GoalList]
    let defaultListId: String?
    let onCreate: ([String: JSONValue], String?) -> Void

    private struct TypeOpt { let key, emoji, title, desc: String }
    private static let types = [
        TypeOpt(key: "count", emoji: "🔢", title: "Count", desc: "Reach a number"),
        TypeOpt(key: "total", emoji: "⏱️", title: "Total amount", desc: "Add up over time"),
        TypeOpt(key: "habit", emoji: "🔁", title: "Habit", desc: "Repeat on a cadence"),
        TypeOpt(key: "checklist", emoji: "🪜", title: "Milestones", desc: "A checklist of steps"),
    ]
    private static let categories = ["physical", "intellectual", "spiritual", "creative", "social"]
    private static let categoryLabel = ["physical": "Physical", "intellectual": "Intellectual",
                                        "spiritual": "Spiritual", "creative": "Creative", "social": "Social"]

    struct Milestone: Identifiable { let id = UUID(); var emoji: String; var threshold: String; var reward: String }

    @State private var title = ""
    @State private var goalListId: String?
    @State private var trackingMode = "shared_total"
    @State private var goalType = "total"
    @State private var target = "1000"
    @State private var unit = "hours"
    @State private var habitPeriod = "week"
    @State private var habitPer = "5"
    @State private var category = "physical"
    @State private var hasDeadline = false
    @State private var deadline = Date()
    @State private var isFeatured = true
    @State private var hasRewards = false
    @State private var milestones: [Milestone] = [
        .init(emoji: "🌱", threshold: "250", reward: "+25 ★ bonus"),
        .init(emoji: "⛺", threshold: "500", reward: "Family movie night"),
        .init(emoji: "🏆", threshold: "1000", reward: "Big reward"),
    ]

    private var isHabit: Bool { goalType == "habit" }
    private var canSave: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    section("What’s the goal?") {
                        TextField("1,000 Hours Outside", text: $title)
                            .font(NK.serif(20)).textInputAutocapitalization(.words)
                            .padding(.horizontal, 15).padding(.vertical, 13)
                            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                    }

                    if !lists.isEmpty {
                        section("Who’s it for?") {
                            ChipFlow(spacing: 8, lineSpacing: 8) {
                                ForEach(lists) { l in
                                    let on = goalListId == l.id
                                    Button { goalListId = l.id } label: {
                                        Text("\(l.members.first?.avatarEmoji ?? l.emoji ?? "👥") \(l.name)")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(on ? NK.ink : NK.ink2)
                                            .padding(.horizontal, 12).padding(.vertical, 7)
                                            .background(on ? NK.primary.opacity(0.12) : NK.card)
                                            .overlay(Capsule().strokeBorder(on ? NK.primary : NK.hair, lineWidth: on ? 1.5 : 1))
                                            .clipShape(Capsule())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }

                    section("Shared, or each on their own?") {
                        Picker("Tracking", selection: $trackingMode) {
                            Text("One shared total").tag("shared_total")
                            Text("Each tracks own").tag("each_tracks")
                        }
                        .pickerStyle(.segmented)
                    }

                    section("How do you measure it?") {
                        VStack(spacing: 8) {
                            ForEach(Self.types, id: \.key) { t in typeCard(t) }
                        }
                        measureRow.padding(.top, 4)
                    }

                    section("Category") {
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(Self.categories, id: \.self) { k in
                                let on = category == k
                                let c = GoalStyle.color(k)
                                Button { category = k } label: {
                                    Text("\(GoalStyle.emoji(k)) \(Self.categoryLabel[k] ?? k)")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(on ? c : NK.ink2)
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(on ? c.opacity(0.14) : NK.card)
                                        .overlay(Capsule().strokeBorder(on ? c : NK.hair, lineWidth: on ? 1.5 : 1))
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    toggleRow("⭐", "Feature on the home screen", "Shows big on the family hub", $isFeatured)
                    toggleRow("🏆", "Milestones & rewards", "Bonus stars at custom thresholds", $hasRewards)
                    if hasRewards { milestoneEditor }

                    Text("Rewards are off by default — goals stay about growth, not points. Turn them on per goal when a little extra motivation helps.")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(NK.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle("New goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { submit() }.fontWeight(.semibold).disabled(!canSave)
                }
            }
            .onAppear { if goalListId == nil { goalListId = defaultListId ?? lists.first?.id } }
        }
        .presentationDetents([.large])
    }

    // MARK: pieces

    private func section<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 10) { SectionLabel(text: label); content() }
    }

    private func typeCard(_ t: TypeOpt) -> some View {
        let on = goalType == t.key
        return Button { goalType = t.key } label: {
            HStack(spacing: 12) {
                Text(t.emoji).font(.system(size: 20)).frame(width: 38, height: 38)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.title).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                    Text(t.desc).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                }
                Spacer()
                if on { Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(NK.primary) }
            }
            .padding(12)
            .background(on ? NK.primary.opacity(0.08) : NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(on ? NK.primary : NK.hair, lineWidth: on ? 1.5 : 1))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var measureRow: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                if isHabit {
                    numField($habitPer, width: 70)
                    Text("× a").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
                    Picker("Period", selection: $habitPeriod) {
                        Text("day").tag("day"); Text("week").tag("week"); Text("month").tag("month")
                    }
                    .pickerStyle(.menu).tint(NK.ink)
                    Spacer()
                } else {
                    numField($target, width: 90)
                    plainField("hours", text: $unit)
                }
            }
            Toggle(isOn: $hasDeadline.animation()) {
                Text("Set a deadline").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
            }
            .tint(FamilyColor.wally.solid)
            if hasDeadline {
                DatePicker("Deadline", selection: $deadline, displayedComponents: .date)
                    .datePickerStyle(.compact).labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func numField(_ text: Binding<String>, width: CGFloat) -> some View {
        TextField("", text: text).keyboardType(.numberPad)
            .font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
            .frame(width: width).padding(.vertical, 11)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func plainField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .font(.system(size: 16, weight: .semibold))
            .padding(.horizontal, 13).padding(.vertical, 11)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func toggleRow(_ icon: String, _ title: String, _ sub: String, _ on: Binding<Bool>) -> some View {
        HStack(spacing: 12) {
            Text(icon).font(.system(size: 22)).frame(width: 38)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 14.5, weight: .bold)).foregroundStyle(NK.ink)
                Text(sub).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            Spacer()
            Toggle("", isOn: on.animation()).labelsHidden().tint(FamilyColor.wally.solid)
        }
        .padding(13)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private var milestoneEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Milestones & rewards")
            ForEach($milestones) { $m in
                HStack(spacing: 8) {
                    TextField("🎯", text: $m.emoji).frame(width: 38).multilineTextAlignment(.center)
                        .padding(.vertical, 9).background(NK.card)
                        .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                    TextField("0", text: $m.threshold).keyboardType(.numberPad).frame(width: 64)
                        .multilineTextAlignment(.center).font(.system(size: 14, weight: .semibold))
                        .padding(.vertical, 9).background(NK.card)
                        .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                    TextField("reward", text: $m.reward).font(.system(size: 14, weight: .semibold))
                        .padding(.horizontal, 11).padding(.vertical, 9).background(NK.card)
                        .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                    Button { milestones.removeAll { $0.id == m.id } } label: {
                        Image(systemName: "minus.circle.fill").font(.system(size: 18)).foregroundStyle(NK.ink3)
                    }
                    .buttonStyle(.plain)
                }
            }
            Button { milestones.append(.init(emoji: "🎯", threshold: "0", reward: "")) } label: {
                Label("Add milestone", systemImage: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ai)
            }
            .buttonStyle(.plain).padding(.top, 2)
        }
    }

    private func submit() {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        var body: [String: JSONValue] = [
            "title": .string(trimmed),
            "goalListId": goalListId.map(JSONValue.string) ?? .null,
            "category": .string(category),
            "goalType": .string(goalType),
            "trackingMode": .string(trackingMode),
            "logMethod": .string("quick_log"),
            "isFeatured": .bool(isFeatured),
            "hasRewards": .bool(hasRewards),
            "unit": isHabit ? .null : (unit.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(unit.trimmingCharacters(in: .whitespaces))),
            "deadline": hasDeadline ? .string(isoDay(deadline)) : .null,
        ]
        if isHabit {
            let n = Int(habitPer) ?? 0
            body["targetValue"] = .int(n)
            body["habitPeriod"] = .string(habitPeriod)
            body["habitTargetPerPeriod"] = .int(n)
        } else {
            body["targetValue"] = Double(target).map(JSONValue.double) ?? .null
        }
        let members = lists.first { $0.id == goalListId }?.members ?? []
        body["participantIds"] = .array(members.map { .string($0.personId) })
        body["milestones"] = .array(hasRewards ? milestones.map { m in
            .object([
                "threshold": .int(Int(m.threshold) ?? 0),
                "emoji": .string(m.emoji),
                "label": .string(m.threshold),
                "rewardText": .string(m.reward),
            ])
        } : [])
        onCreate(body, goalListId)
        dismiss()
    }

    private func isoDay(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: d)
    }
}

// MARK: - Goal detail

@MainActor
@Observable
final class GoalDetailModel {
    let goal: NookAPI.Goal
    private(set) var detail: NookAPI.GoalDetail?
    private(set) var loading = true
    private(set) var error = false
    private let api = NookAPI()

    init(goal: NookAPI.Goal) { self.goal = goal }

    func load() async {
        do { detail = try await api.goalDetail(id: goal.id); error = false }
        catch { self.error = true }
        loading = false
    }

    func log(amount: Double, personIds: [String], note: String) async {
        do {
            try await api.logGoalProgress(goalId: goal.id, amount: amount, personIds: personIds, note: note)
            await load()
        } catch { self.error = true }
    }

    func delete() async -> Bool {
        do { try await api.deleteGoal(id: goal.id); return true }
        catch { self.error = true; return false }
    }
}

/// One goal's detail: hero (ring + started/streak/this-week), the milestone ladder,
/// progress by person, and the recent-activity log. Log from the toolbar; delete
/// (tap-twice) pops back. Mirrors the web GoalDetail.
struct GoalDetailView: View {
    let goal: NookAPI.Goal
    @Binding var path: [HubRoute]
    @State private var model: GoalDetailModel
    @State private var logging = false
    @State private var confirmDelete = false

    private static let heroGreen = LinearGradient(colors: [Color(hex: 0x2BA86B), Color(hex: 0x1C8A56)],
                                                  startPoint: .topLeading, endPoint: .bottomTrailing)

    init(goal: NookAPI.Goal, path: Binding<[HubRoute]>) {
        self.goal = goal
        _path = path
        _model = State(initialValue: GoalDetailModel(goal: goal))
    }

    // Prefer the freshly-loaded detail, fall back to the goal we were handed.
    private var unit: String? { model.detail?.unit ?? goal.unit }
    private var target: Double? { model.detail?.target ?? goal.target }
    private var progress: Double { model.detail?.totalProgress ?? goal.totalProgress }
    private var participants: [NookAPI.Goal.Participant] { model.detail?.participants ?? goal.participants }
    private var pct: Int { (target ?? 0) > 0 ? min(Int((progress / target!) * 100), 100) : 0 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                hero
                if let ms = model.detail?.milestones, !ms.isEmpty { milestoneCard(ms) }
                if !participants.isEmpty { byPersonCard }
                recentCard
                deleteButton
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle(goal.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { logging = true } label: {
                    Label("Log", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold)
                }
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .sheet(isPresented: $logging) {
            GoalLogSheet(goal: goal) { amount, ids, note in
                Task { await model.log(amount: amount, personIds: ids, note: note) }
            }
        }
    }

    // MARK: hero

    private var hero: some View {
        let frac = (target ?? 0) > 0 ? min(progress / target!, 1) : 0
        return HStack(alignment: .top, spacing: 14) {
            GoalRing(value: frac, size: 104, lineWidth: 9, stroke: .white, track: .white.opacity(0.25)) {
                VStack(spacing: 0) {
                    Text(goalFmt(progress)).font(.system(size: 26, weight: .heavy)).foregroundStyle(.white)
                    Text("of \(goalFmt(target))\(unit.map { " \($0)" } ?? "")")
                        .font(.system(size: 9, weight: .bold)).foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(model.detail?.category.map { "\(GoalStyle.emoji($0)) \($0.capitalized)" } ?? "⭐ Featured")
                    .font(.system(size: 10.5, weight: .heavy)).foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(.white.opacity(0.2)).clipShape(Capsule())
                Text(goal.title).font(NK.serif(20)).foregroundStyle(.white).lineLimit(3)
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
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
    }

    private var heroSub: String {
        var parts: [String] = []
        if let c = model.detail?.createdAt { parts.append("Started \(monthDay(c))") }
        parts.append("\(pct)% complete")
        let streak = model.detail?.streakDays ?? goal.streakDays
        if streak > 0 { parts.append("🔥 \(streak)-day streak") }
        if let d = model.detail?.deadline ?? goal.deadline { parts.append("by \(monthDay(d))") }
        return parts.joined(separator: " · ")
    }

    // MARK: milestones

    private func milestoneCard(_ ms: [NookAPI.GoalDetail.Milestone]) -> some View {
        let firstUnreached = ms.firstIndex { !$0.reached }
        return detailCard {
            Text("Milestones").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
            VStack(spacing: 0) {
                ForEach(Array(ms.enumerated()), id: \.element.id) { i, m in
                    let isNow = i == firstUnreached
                    HStack(spacing: 12) {
                        Text(m.emoji ?? "⛳").font(.system(size: 16))
                            .frame(width: 34, height: 34)
                            .background(m.reached ? FamilyColor.wally.solid.opacity(0.18) : (isNow ? NK.primary.opacity(0.12) : NK.panel))
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(m.reached ? FamilyColor.wally.solid : (isNow ? NK.primary : Color.clear), lineWidth: 1.5))
                        Text(m.label ?? goalFmt(m.threshold))
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(m.reached || isNow ? NK.ink : NK.ink2)
                        Spacer(minLength: 6)
                        Text(m.reached ? "reached"
                                : isNow ? "\(goalFmt(m.threshold - progress)) to go"
                                : (m.rewardText ?? "—"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(m.reached ? FamilyColor.wally.solid : (isNow ? NK.primary : NK.ink3))
                            .lineLimit(1)
                    }
                    .padding(.vertical, 7)
                    if i < ms.count - 1 { Divider().background(NK.hair) }
                }
            }
        }
    }

    // MARK: by person

    private var byPersonCard: some View {
        let maxProg = max(1, participants.map(\.progress).max() ?? 1)
        return detailCard {
            Text(unit.map { "\($0.prefix(1).uppercased())\($0.dropFirst()) by person" } ?? "By person")
                .font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
            VStack(spacing: 11) {
                ForEach(participants, id: \.personId) { p in
                    let color = Color(hexString: p.colorHex) ?? FamilyColor.kevin.solid
                    HStack(spacing: 10) {
                        Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 26)
                        Text(goalFirstName(p.name)).font(.system(size: 13, weight: .bold))
                            .foregroundStyle(NK.ink).frame(width: 64, alignment: .leading).lineLimit(1)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(NK.hair)
                                Capsule().fill(color).frame(width: geo.size.width * min(p.progress / maxProg, 1))
                            }
                        }
                        .frame(height: 8)
                        Text("\(goalFmt(p.progress))\(unit.map { " \($0)" } ?? "")")
                            .font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                            .frame(width: 64, alignment: .trailing).lineLimit(1).minimumScaleFactor(0.7)
                    }
                }
            }
        }
    }

    // MARK: recent activity

    private var recentCard: some View {
        detailCard {
            Text("Recent activity").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
            if let r = model.detail?.recent, !r.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(r.enumerated()), id: \.element.id) { i, log in
                        HStack(spacing: 10) {
                            Text(weekday(log.loggedAt)).font(.system(size: 11, weight: .bold))
                                .foregroundStyle(NK.ink3).frame(width: 34, alignment: .leading)
                            Avatar(colorHex: log.colorHex, emoji: log.avatarEmoji ?? "🙂", size: 24)
                            Text(log.note?.isEmpty == false ? log.note! : "Logged progress")
                                .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                            Spacer(minLength: 6)
                            Text("+\(goalFmt(log.amount))\(unit.map { " \($0)" } ?? "")")
                                .font(.system(size: 13, weight: .bold)).foregroundStyle(FamilyColor.wally.solid)
                        }
                        .padding(.vertical, 8)
                        if i < r.count - 1 { Divider().background(NK.hair) }
                    }
                }
            } else {
                Text("No activity yet — log some progress.")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3).padding(.vertical, 6)
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
                .foregroundStyle(confirmDelete ? NK.primary : NK.ink3)
        }
        .buttonStyle(.plain)
        .padding(.top, 4).padding(.leading, 2)
    }

    // MARK: helpers

    private func detailCard<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func monthDay(_ iso: String) -> String { fmtDate(iso, "MMM d") }
    private func weekday(_ iso: String) -> String { fmtDate(iso, "EEE") }
    private func fmtDate(_ iso: String, _ fmt: String) -> String {
        let inF = ISO8601DateFormatter()
        inF.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = inF.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else {
            // Fall back to a plain yyyy-MM-dd date string.
            let d2 = DateFormatter(); d2.dateFormat = "yyyy-MM-dd"; d2.timeZone = TimeZone(identifier: "UTC")
            guard let parsed = d2.date(from: String(iso.prefix(10))) else { return "" }
            let out = DateFormatter(); out.dateFormat = fmt
            return out.string(from: parsed)
        }
        let out = DateFormatter(); out.dateFormat = fmt
        return out.string(from: date)
    }
}
