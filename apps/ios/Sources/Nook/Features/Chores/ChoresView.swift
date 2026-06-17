import SwiftUI
import Observation

/// Chores — today's chores grouped by person (plus an "Up for grabs" group for
/// unassigned ones), with a date stepper. Tick to complete/uncomplete; tap an
/// up-for-grabs chore to claim it ("who did it?"); a parent approves/rejects the
/// ones awaiting an OK. Streaks + star rewards shown per row. Online-only.
@MainActor
@Observable
final class ChoresModel {
    private(set) var instances: [NookAPI.ChoreInstanceDTO] = []
    private(set) var loading = true
    private(set) var error = false
    var date: String

    private let api = NookAPI()

    init(date: String) { self.date = date }

    func load() async {
        loading = true
        do { instances = try await api.choreInstances(date: date); error = false }
        catch { self.error = true }
        loading = false
    }

    func shift(_ days: Int) async { date = ChoreDates.shift(date, days); await load() }
    func goToday() async { date = ChoreDates.today(); await load() }

    /// Optimistic complete/uncomplete (a chore needing approval lands in "awaiting"),
    /// then reload to pick up the true stars/streak/status.
    func toggle(_ inst: NookAPI.ChoreInstanceDTO) async {
        guard let idx = instances.firstIndex(where: { $0.id == inst.id }) else { return }
        let prev = instances[idx].status
        let isComplete = prev == "done" || prev == "awaiting"
        let next = isComplete ? "pending" : (inst.requiresApproval ? "awaiting" : "done")
        withAnimation { instances[idx].status = next }
        do {
            if isComplete { try await api.uncompleteChore(id: inst.id) }
            else { try await api.completeChore(id: inst.id) }
            await load()
        } catch {
            if let i = instances.firstIndex(where: { $0.id == inst.id }) { withAnimation { instances[i].status = prev } }
        }
    }

    /// Claim an up-for-grabs chore for a person and mark it done in one motion.
    func claimComplete(id: String, personId: String) async {
        do {
            try await api.claimChore(id: id, personId: personId)
            try await api.completeChore(id: id)
            await load()
        } catch { self.error = true }
    }

    func approve(_ id: String) async { do { try await api.approveChore(id: id); await load() } catch { self.error = true } }
    func reject(_ id: String) async { do { try await api.rejectChore(id: id); await load() } catch { self.error = true } }
}

/// Local-date helpers for the day stepper (household runs in device tz here).
enum ChoreDates {
    private static func fmt() -> DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.calendar = .current; f.timeZone = .current
        return f
    }
    static func today() -> String { fmt().string(from: Date()) }
    static func shift(_ d: String, _ days: Int) -> String {
        guard let date = fmt().date(from: d),
              let shifted = Calendar.current.date(byAdding: .day, value: days, to: date) else { return d }
        return fmt().string(from: shifted)
    }
    /// (relative label, full label, isToday) for the header.
    static func meta(_ d: String) -> (rel: String, full: String, isToday: Bool) {
        guard let date = fmt().date(from: d) else { return ("", d, true) }
        let cal = Calendar.current
        let diff = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: date)).day ?? 0
        let rel: String
        switch diff {
        case 0: rel = "Today"
        case 1: rel = "Tomorrow"
        case -1: rel = "Yesterday"
        default: rel = diff > 0 ? "In \(diff) days" : "\(-diff) days ago"
        }
        let out = DateFormatter(); out.dateFormat = "EEEE, MMM d"; out.calendar = .current; out.timeZone = .current
        return (rel, out.string(from: date), diff == 0)
    }
}

/// A person's (or the up-for-grabs) column of chores for the day.
struct ChoreColumn: Identifiable {
    let id: String
    let name: String
    let emoji: String?
    let colorHex: String?
    let isGrabs: Bool
    let items: [NookAPI.ChoreInstanceDTO]
    var done: Int { items.filter { $0.status == "done" }.count }
}

struct ChoresView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = ChoresModel(date: ChoreDates.today())
    @State private var claiming: String?   // instance id whose "who did it?" picker is open

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                dateNav
                if model.instances.isEmpty && !model.loading {
                    Text(model.error ? "Couldn’t load chores." : "Nothing scheduled \(ChoreDates.meta(model.date).isToday ? "today" : "this day").")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
                        .padding(.vertical, 24)
                }
                ForEach(columns) { col in columnCard(col) }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Chores")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    /// Up for grabs first, then every household member in order, then any orphans.
    private var columns: [ChoreColumn] {
        var byPerson: [String: [NookAPI.ChoreInstanceDTO]] = [:]
        var grabs: [NookAPI.ChoreInstanceDTO] = []
        for i in model.instances {
            if let pid = i.personId { byPerson[pid, default: []].append(i) } else { grabs.append(i) }
        }
        var cols: [ChoreColumn] = []
        if !grabs.isEmpty {
            cols.append(ChoreColumn(id: "__grabs__", name: "Up for grabs", emoji: "🙌", colorHex: nil, isGrabs: true, items: grabs))
        }
        var seen = Set<String>()
        for m in sync.members {
            seen.insert(m.id)
            let items = byPerson[m.id] ?? []
            if items.isEmpty { continue }   // hide empty people on a phone (no per-person add yet)
            cols.append(ChoreColumn(id: m.id, name: m.name, emoji: m.emoji, colorHex: m.colorHex, isGrabs: false, items: items))
        }
        for (pid, items) in byPerson where !seen.contains(pid) {
            cols.append(ChoreColumn(id: pid, name: items.first?.personName ?? "Someone", emoji: nil, colorHex: nil, isGrabs: false, items: items))
        }
        return cols
    }

    private var dateNav: some View {
        HStack(spacing: 12) {
            Button { Task { await model.shift(-1) } } label: { navArrow("chevron.left") }
            VStack(spacing: 1) {
                Text(ChoreDates.meta(model.date).full).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                Text(ChoreDates.meta(model.date).rel).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            .frame(maxWidth: .infinity)
            Button { Task { await model.shift(1) } } label: { navArrow("chevron.right") }
        }
        .overlay(alignment: .trailing) {
            if !ChoreDates.meta(model.date).isToday {
                Button { Task { await model.goToday() } } label: {
                    Text("Today").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.primary)
                }
                .offset(y: 30)
            }
        }
    }

    private func navArrow(_ system: String) -> some View {
        Image(systemName: system).font(.system(size: 14, weight: .heavy)).foregroundStyle(NK.ink2)
            .frame(width: 38, height: 38).background(NK.panel).clipShape(Circle())
    }

    private func columnCard(_ col: ChoreColumn) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                if col.isGrabs {
                    Text("🙌").font(.system(size: 16)).frame(width: 30, height: 30)
                        .background(NK.gold.opacity(0.15)).clipShape(Circle())
                } else {
                    Avatar(colorHex: col.colorHex, emoji: col.emoji ?? "🙂", size: 30)
                }
                Text(col.name).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                Spacer()
                HStack(spacing: 3) {
                    Image(systemName: "star.fill").font(.system(size: 11)).foregroundStyle(NK.gold)
                    Text("\(col.done)/\(col.items.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                }
            }
            .padding(.bottom, 4)
            if col.isGrabs {
                Text("Tap a chore to claim it — whoever does it gets the stars.")
                    .font(.system(size: 11.5, weight: .medium)).foregroundStyle(NK.ink3).padding(.bottom, 6)
            }
            VStack(spacing: 0) {
                ForEach(Array(col.items.enumerated()), id: \.element.id) { i, inst in
                    choreRow(inst, isGrabs: col.isGrabs)
                    if i < col.items.count - 1 { Divider().background(NK.hair) }
                }
            }
        }
        .padding(14)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(col.isGrabs ? NK.gold.opacity(0.4) : NK.hair, lineWidth: 1))
    }

    @ViewBuilder private func choreRow(_ inst: NookAPI.ChoreInstanceDTO, isGrabs: Bool) -> some View {
        let isDone = inst.status == "done"
        let isAwaiting = inst.status == "awaiting"
        VStack(spacing: 0) {
            HStack(spacing: 11) {
                Button {
                    if isGrabs { withAnimation { claiming = claiming == inst.id ? nil : inst.id } }
                    else { Task { await model.toggle(inst) } }
                } label: { tick(isDone: isDone, isAwaiting: isAwaiting, isGrabs: isGrabs) }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("\(inst.emoji.map { "\($0) " } ?? "")\(inst.choreTitle)")
                            .font(.system(size: 15, weight: .semibold))
                            .strikethrough(isDone, color: NK.ink3)
                            .foregroundStyle(isDone ? NK.ink3 : NK.ink).lineLimit(1)
                        if inst.streak >= 2 {
                            Text("🔥 \(inst.streak)").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink2)
                        }
                    }
                    HStack(spacing: 5) {
                        Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(NK.gold)
                        Text("\(inst.rewardAmount)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                        if isAwaiting {
                            Text("Needs OK").font(.system(size: 10, weight: .heavy))
                                .foregroundStyle(NK.primary)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(NK.primary.opacity(0.12)).clipShape(Capsule())
                        }
                    }
                }
                Spacer(minLength: 6)
                if isAwaiting {
                    HStack(spacing: 6) {
                        Button { Task { await model.reject(inst.id) } } label: {
                            Text("Reject").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                        }.buttonStyle(.plain)
                        Button { Task { await model.approve(inst.id) } } label: {
                            Text("Approve").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(FamilyColor.wally.solid).clipShape(Capsule())
                        }.buttonStyle(.plain)
                    }
                }
            }
            .padding(.vertical, 9)

            if isGrabs && claiming == inst.id { claimPicker(inst) }
        }
    }

    private func tick(isDone: Bool, isAwaiting: Bool, isGrabs: Bool) -> some View {
        Group {
            if isAwaiting {
                Text("⏳").font(.system(size: 16)).frame(width: 26, height: 26)
            } else if isDone {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 22)).foregroundStyle(FamilyColor.wally.solid)
            } else {
                Image(systemName: isGrabs ? "hand.raised.circle" : "circle").font(.system(size: 22))
                    .foregroundStyle(isGrabs ? NK.gold : NK.ink3)
            }
        }
        .frame(width: 30, height: 30).contentShape(Rectangle())
    }

    private func claimPicker(_ inst: NookAPI.ChoreInstanceDTO) -> some View {
        HStack(spacing: 8) {
            Text("Who did it?").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
            ForEach(sync.members) { m in
                Button {
                    claiming = nil
                    Task { await model.claimComplete(id: inst.id, personId: m.id) }
                } label: {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 30)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
            Button { withAnimation { claiming = nil } } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 18)).foregroundStyle(NK.ink3)
            }.buttonStyle(.plain)
        }
        .padding(.vertical, 8).padding(.horizontal, 4)
    }
}
