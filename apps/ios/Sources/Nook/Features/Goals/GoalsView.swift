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
    @State private var model = GoalsModel()
    @State private var logging: NookAPI.Goal?

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
        .task { if model.lists.isEmpty { await model.loadLists() } }
        .refreshable { await model.loadLists() }
        .sheet(item: $logging) { g in
            GoalLogSheet(goal: g) { amount, ids, note in
                Task { await model.log(goalId: g.id, amount: amount, personIds: ids, note: note) }
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
        return Button { logging = g } label: {
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
