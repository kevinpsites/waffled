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

    /// Assign (or reassign) a chore to a person *without* completing it — the drag-
    /// and-drop gesture (drop into their column). No-op if it's already theirs.
    func assign(id: String, to personId: String) async {
        guard let inst = instances.first(where: { $0.id == id }), inst.personId != personId else { return }
        do { try await api.assignChore(id: id, personId: personId); await load() }
        catch { self.error = true }
    }

    /// Send a chore back to up-for-grabs — dropping it on the "Up for grabs" column.
    /// No-op if it's already unassigned.
    func unassign(id: String) async {
        guard instances.first(where: { $0.id == id })?.personId != nil else { return }
        do { try await api.assignChore(id: id, personId: nil); await load() }
        catch { self.error = true }
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

    /// Create (choreId nil) or edit a chore definition, then reload the day.
    func save(choreId: String?, body: [String: JSONValue]) async {
        do {
            if let choreId { try await api.updateChore(id: choreId, body) }
            else { try await api.createChore(body) }
            await load()
        } catch { self.error = true }
    }

    func delete(choreId: String) async {
        do { try await api.deleteChore(id: choreId); await load() }
        catch { self.error = true }
    }
}

/// Local-date helpers for the day stepper (household runs in device tz here).
enum ChoreDates {
    static func today() -> String { DateFmt.string(Date(), "yyyy-MM-dd", .current) }
    static func shift(_ d: String, _ days: Int) -> String {
        guard let date = DateFmt.date(d, "yyyy-MM-dd", .current),
              let shifted = Calendar.current.date(byAdding: .day, value: days, to: date) else { return d }
        return DateFmt.string(shifted, "yyyy-MM-dd", .current)
    }
    /// (relative label, full label, isToday) for the header.
    static func meta(_ d: String) -> (rel: String, full: String, isToday: Bool) {
        guard let date = DateFmt.date(d, "yyyy-MM-dd", .current) else { return ("", d, true) }
        let cal = Calendar.current
        let diff = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: date)).day ?? 0
        let rel: String
        switch diff {
        case 0: rel = "Today"
        case 1: rel = "Tomorrow"
        case -1: rel = "Yesterday"
        default: rel = diff > 0 ? "In \(diff) days" : "\(-diff) days ago"
        }
        return (rel, DateFmt.string(date, "EEEE, MMM d", .current), diff == 0)
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
    @State private var approvals = ApprovalsModel()   // parent "needs your OK" banner
    @State private var claiming: String?   // instance id whose "who did it?" picker is open
    @State private var editor: ChoreEditorTarget?
    @State private var collapsed: Set<String> = []   // column ids the user has folded
    @State private var dropTarget: String?           // person column id currently under a drag

    /// What the chore editor sheet is editing/creating.
    enum ChoreEditorTarget: Identifiable {
        case new(personId: String?)
        case edit(NookAPI.ChoreInstanceDTO)
        var id: String {
            switch self {
            case let .new(pid): return "new:\(pid ?? "")"
            case let .edit(i): return "edit:\(i.id)"
            }
        }
    }

    /// iPad lays the person columns side-by-side (web-like Kanban); iPhone stacks them.
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        Group {
            if isKiosk { kioskContent } else { phoneContent }
        }
        .background(NK.canvas)
        .navigationTitle("Chores")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editor = .new(personId: nil) } label: {
                    Label("New chore", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold)
                }
            }
        }
        .task(id: sync.choresRev) { await model.load(); await approvals.load() }
        .task { await sync.loadCurrencies() }
        .sheet(item: $editor) { target in
            ChoreEditSheet(members: sync.members, target: target,
                onSave: { choreId, body in Task { await model.save(choreId: choreId, body: body) } },
                onDelete: { choreId in Task { await model.delete(choreId: choreId) } })
        }
    }

    // MARK: iPhone — vertical stack of columns

    private var phoneContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                approvalsCard
                dateNav
                if model.loading && model.instances.isEmpty {
                    NookLoading(top: 32)
                } else if model.instances.isEmpty {
                    NookEmptyState(
                        emoji: model.error ? "😕" : "✅",
                        title: model.error ? "Couldn’t load chores"
                                           : "Nothing scheduled \(ChoreDates.meta(model.date).isToday ? "today" : "this day")",
                        message: model.error ? "Pull to refresh to try again." : nil,
                        top: 32)
                }
                ForEach(columns) { col in columnCard(col) }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        // Bounce even when nothing's scheduled, so pull-to-refresh still triggers.
        .scrollBounceBehavior(.always)
        .refreshable { await model.load(); await approvals.load() }
    }

    // MARK: iPad — side-by-side Kanban columns

    private var kioskContent: some View {
        VStack(spacing: 14) {
            if sync.isParent && !approvals.chores.isEmpty { approvalsCard }
            dateNav.frame(maxWidth: 440)
            if model.loading && model.instances.isEmpty {
                NookLoading(top: 32); Spacer()
            } else {
                // Columns keep a minimum width and wrap onto new rows; the board scrolls.
                ScrollView(showsIndicators: false) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 240, maximum: 380), spacing: 14, alignment: .top)],
                              alignment: .leading, spacing: 14) {
                        ForEach(columns) { col in kioskColumn(col) }
                    }
                    .padding(.bottom, 20)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// One always-open column (content-sized; the board wraps + scrolls). Reuses the
    /// shared row/drag/claim logic + drop target.
    private func kioskColumn(_ col: ChoreColumn) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                if col.isGrabs {
                    Text("🙌").font(.system(size: 16)).frame(width: 32, height: 32)
                        .background(NK.gold.opacity(0.15)).clipShape(Circle())
                } else {
                    Avatar(colorHex: col.colorHex, emoji: col.emoji ?? "🙂", size: 32)
                }
                Text(col.name).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                Spacer(minLength: 4)
                let allDone = !col.items.isEmpty && col.done == col.items.count
                HStack(spacing: 3) {
                    Image(systemName: allDone ? "checkmark.circle.fill" : "checkmark.circle")
                        .font(.system(size: 12)).foregroundStyle(allDone ? FamilyColor.wally.solid : NK.ink3)
                    Text("\(col.done)/\(col.items.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                }
            }
            .padding(.bottom, 10)
            Rectangle().fill(NK.hair).frame(height: 1)
            VStack(spacing: 0) {
                if col.isGrabs && !col.items.isEmpty {
                    Text("Tap to claim it, or drag it into someone’s column.")
                        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(NK.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8).padding(.bottom, 2)
                }
                ForEach(Array(col.items.enumerated()), id: \.element.id) { i, inst in
                    draggableRow(choreRow(inst, isGrabs: col.isGrabs), inst: inst)
                    if i < col.items.count - 1 { Divider().background(NK.hair) }
                }
                if col.items.isEmpty {
                    Text(col.isGrabs ? "Nothing up for grabs." : "Nothing for \(col.name).")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(NK.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
                }
                Button { editor = .new(personId: col.isGrabs ? nil : col.id) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                        Text("Add chore").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(NK.ink3).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 4)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .top)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(dropTarget == col.id ? NK.primary
                          : (col.isGrabs ? NK.gold.opacity(0.4) : NK.hair),
                          lineWidth: dropTarget == col.id ? 2 : 1))
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            dropTarget = nil
            if col.isGrabs { Task { await model.unassign(id: id) } }
            else { Task { await model.assign(id: id, to: col.id) } }
            return true
        } isTargeted: { hovering in
            withAnimation(.easeInOut(duration: 0.12)) {
                dropTarget = hovering ? col.id : (dropTarget == col.id ? nil : dropTarget)
            }
        }
    }

    // MARK: inline approvals ("Needs your OK")

    /// Chore check-offs waiting on a parent, surfaced inline at the top so you can
    /// Approve/Reject in place — no extra screen. Mirrors the Rewards tab's card, but
    /// scoped to chores (reward purchases live on Today/Rewards). Pulls all awaiting
    /// instances across dates, so it's independent of the day you're viewing.
    @ViewBuilder
    private var approvalsCard: some View {
        if sync.isParent && !approvals.chores.isEmpty {
            NookCard(padding: 14) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 6) {
                        Text("Needs your OK").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                        Text("\(approvals.chores.count)").font(.system(size: 12, weight: .heavy)).foregroundStyle(NK.primary)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(NK.primary.opacity(0.12)).clipShape(Capsule())
                    }
                    ForEach(Array(approvals.chores.enumerated()), id: \.element.id) { idx, c in
                        if idx > 0 { Divider().background(NK.hair) }
                        approvalRow(c)
                    }
                }
            }
        }
    }

    private func approvalRow(_ c: NookAPI.ChoreInstanceDTO) -> some View {
        let m = c.personId.flatMap { id in sync.members.first { $0.id == id } }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(colorHex: m?.colorHex, emoji: m?.emoji ?? "🙂", size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(c.personName ?? "Someone") finished")
                        .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                    HStack(spacing: 6) {
                        Text("\(c.emoji ?? "🧹") \(c.choreTitle)")
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                        if c.rewardAmount > 0 {
                            Text("\(c.rewardAmount)\(sync.currencySymbol(c.rewardCurrency))")
                                .font(.system(size: 12.5, weight: .heavy)).foregroundStyle(NK.gold)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(NK.gold.opacity(0.14)).clipShape(Capsule())
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                Button { decide(c) { await sync.rejectChore(id: c.id) } } label: {
                    Text("Not yet").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(NK.panel).clipShape(Capsule())
                }.buttonStyle(.plain)
                Button { decide(c) { await sync.approveChore(id: c.id) } } label: {
                    Text("Approve").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(NK.primary).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
        }
    }

    /// Optimistically drop the row, run the decision, then refresh both the queue and
    /// the columns (approve moves the chore to done, reject sends it back to pending).
    private func decide(_ c: NookAPI.ChoreInstanceDTO, _ op: @escaping () async -> Bool) {
        approvals.drop(chore: c.id)
        Task {
            let ok = await op()
            await approvals.load()
            if ok { await model.load() }
        }
    }

    /// Up for grabs first, then every household member in order, then any orphans.
    private var columns: [ChoreColumn] {
        var byPerson: [String: [NookAPI.ChoreInstanceDTO]] = [:]
        var grabs: [NookAPI.ChoreInstanceDTO] = []
        for i in model.instances {
            if let pid = i.personId { byPerson[pid, default: []].append(i) } else { grabs.append(i) }
        }
        // Up for grabs always leads (even when empty), so anyone-can-claim chores
        // have a home to add to — matching the web board.
        var cols: [ChoreColumn] = [
            ChoreColumn(id: "__grabs__", name: "Up for grabs", emoji: "🙌", colorHex: nil, isGrabs: true, items: grabs),
        ]
        var seen = Set<String>()
        for m in sync.members {
            seen.insert(m.id)
            cols.append(ChoreColumn(id: m.id, name: m.name, emoji: m.emoji, colorHex: m.colorHex, isGrabs: false, items: byPerson[m.id] ?? []))
        }
        for (pid, items) in byPerson where !seen.contains(pid) {
            cols.append(ChoreColumn(id: pid, name: items.first?.personName ?? "Someone", emoji: nil, colorHex: nil, isGrabs: false, items: items))
        }
        return cols
    }

    private var dateNav: some View {
        let meta = ChoreDates.meta(model.date)
        return VStack(spacing: 8) {
            HStack(spacing: 12) {
                Button { Task { await model.shift(-1) } } label: { navArrow("chevron.left") }
                VStack(spacing: 1) {
                    Text(meta.full).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                    Text(meta.rel).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                }
                .frame(maxWidth: .infinity)
                Button { Task { await model.shift(1) } } label: { navArrow("chevron.right") }
            }
            if !meta.isToday {
                Button { Task { await model.goToday() } } label: {
                    Text("Jump to today").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.primary)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(NK.primary.opacity(0.1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func navArrow(_ system: String) -> some View {
        Image(systemName: system).font(.system(size: 14, weight: .heavy)).foregroundStyle(NK.ink2)
            .frame(width: 38, height: 38).background(NK.panel).clipShape(Circle())
    }

    private func columnCard(_ col: ChoreColumn) -> some View {
        let isCollapsed = collapsed.contains(col.id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isCollapsed { collapsed.remove(col.id) } else { collapsed.insert(col.id) }
                }
            } label: {
                HStack(spacing: 9) {
                    if col.isGrabs {
                        Text("🙌").font(.system(size: 16)).frame(width: 30, height: 30)
                            .background(NK.gold.opacity(0.15)).clipShape(Circle())
                    } else {
                        Avatar(colorHex: col.colorHex, emoji: col.emoji ?? "🙂", size: 30)
                    }
                    Text(col.name).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                    Spacer()
                    let allDone = !col.items.isEmpty && col.done == col.items.count
                    HStack(spacing: 3) {
                        Image(systemName: allDone ? "checkmark.circle.fill" : "checkmark.circle")
                            .font(.system(size: 12)).foregroundStyle(allDone ? FamilyColor.wally.solid : NK.ink3)
                        Text("\(col.done)/\(col.items.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(NK.ink3).rotationEffect(.degrees(isCollapsed ? 0 : 90))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !isCollapsed {
                if col.isGrabs && !col.items.isEmpty {
                    Text("Tap to claim it, or drag it into someone’s column to assign it.")
                        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(NK.ink3)
                        .padding(.top, 4).padding(.bottom, 2)
                }
                VStack(spacing: 0) {
                    ForEach(Array(col.items.enumerated()), id: \.element.id) { i, inst in
                        draggableRow(choreRow(inst, isGrabs: col.isGrabs), inst: inst)
                        if i < col.items.count - 1 { Divider().background(NK.hair) }
                    }
                }
                .padding(.top, 4)
                if col.items.isEmpty {
                    Text(col.isGrabs ? "Nothing up for grabs — add one anyone can claim."
                                     : "Nothing for \(col.name) \(ChoreDates.meta(model.date).isToday ? "today" : "this day").")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(NK.ink3).padding(.vertical, 6)
                }
                Button { editor = .new(personId: col.isGrabs ? nil : col.id) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                        Text("Add chore").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(NK.ink3).padding(.top, 8)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(dropTarget == col.id ? NK.primary
                          : (col.isGrabs ? NK.gold.opacity(0.4) : NK.hair),
                          lineWidth: dropTarget == col.id ? 2 : 1))
        // Drop a chore here to (re)assign it to this person, or onto "Up for grabs"
        // to unassign it.
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            dropTarget = nil
            if col.isGrabs { Task { await model.unassign(id: id) } }
            else { Task { await model.assign(id: id, to: col.id) } }
            return true
        } isTargeted: { hovering in
            withAnimation(.easeInOut(duration: 0.12)) {
                dropTarget = hovering ? col.id : (dropTarget == col.id ? nil : dropTarget)
            }
        }
    }

    /// Wrap a chore row so it can be dragged between columns — reassign to a person,
    /// or back to up-for-grabs. Only still-pending chores are draggable (a done or
    /// awaiting one keeps its awarded stars where they are).
    @ViewBuilder private func draggableRow(_ row: some View, inst: NookAPI.ChoreInstanceDTO) -> some View {
        if inst.status == "pending" {
            // contentShape makes the *whole* row (incl. the trailing empty space)
            // the drag handle, not just the title text.
            row.contentShape(Rectangle()).draggable(inst.id) {
                HStack(spacing: 6) {
                    Text(inst.emoji ?? "🧹").font(.system(size: 14))
                    Text(inst.choreTitle).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(NK.card)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(NK.gold.opacity(0.5), lineWidth: 1))
            }
        } else {
            row
        }
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
                        Text(sync.currencySymbol(inst.rewardCurrency)).font(.system(size: 11))
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
            // Tap anywhere on the row to edit — the tick and approve/reject Buttons
            // intercept their own taps, so they're unaffected.
            .contentShape(Rectangle())
            .onTapGesture { editor = .edit(inst) }

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

/// Create or edit a chore definition — title, emoji, repeat schedule (every day /
/// certain weekdays), who (or up-for-grabs), star reward, and a parent-approval
/// toggle. Delete when editing. Mirrors the web ChoreModal. NK-styled.
struct ChoreEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SyncManager.self) private var sync
    let members: [SyncedMember]
    let target: ChoresView.ChoreEditorTarget
    let onSave: (String?, [String: JSONValue]) -> Void
    let onDelete: (String) -> Void

    private static let days: [(code: String, label: String)] = [
        ("MO", "Mon"), ("TU", "Tue"), ("WE", "Wed"), ("TH", "Thu"), ("FR", "Fri"), ("SA", "Sat"), ("SU", "Sun"),
    ]

    private let editChoreId: String?
    @State private var title: String
    @State private var emoji: String
    @State private var personId: String?
    @State private var stars: Int
    /// Chosen reward currency key; nil = the household default.
    @State private var currencyKey: String?
    @State private var freq: String        // "daily" | "weekly"
    @State private var days: Set<String>
    @State private var requiresApproval: Bool
    @State private var confirmDelete = false

    init(members: [SyncedMember], target: ChoresView.ChoreEditorTarget,
         onSave: @escaping (String?, [String: JSONValue]) -> Void, onDelete: @escaping (String) -> Void) {
        self.members = members; self.target = target; self.onSave = onSave; self.onDelete = onDelete
        switch target {
        case let .new(pid):
            editChoreId = nil
            _title = State(initialValue: ""); _emoji = State(initialValue: "")
            _personId = State(initialValue: pid); _stars = State(initialValue: 1)
            _currencyKey = State(initialValue: nil)
            _freq = State(initialValue: "daily"); _days = State(initialValue: [])
            _requiresApproval = State(initialValue: false)
        case let .edit(i):
            editChoreId = i.choreId
            _title = State(initialValue: i.choreTitle); _emoji = State(initialValue: i.emoji ?? "")
            _personId = State(initialValue: i.personId); _stars = State(initialValue: i.rewardAmount)
            _currencyKey = State(initialValue: i.rewardCurrency)
            let parsed = ChoreEditSheet.parseRrule(i.rrule)
            _freq = State(initialValue: parsed.freq); _days = State(initialValue: Set(parsed.days))
            _requiresApproval = State(initialValue: i.requiresApproval)
        }
    }

    private var editing: Bool { editChoreId != nil }
    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty && (freq != "weekly" || !days.isEmpty)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        labeled("Title") {
                            TextField("Feed the dog", text: $title)
                                .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.sentences)
                                .padding(.horizontal, 13).padding(.vertical, 12).cardField()
                        }
                        labeled("Emoji", width: 64) {
                            TextField("🐶", text: $emoji).multilineTextAlignment(.center)
                                .font(.system(size: 16, weight: .semibold)).frame(width: 60).padding(.vertical, 12).cardField()
                                .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Repeats")
                        Picker("Repeats", selection: $freq.animation()) {
                            Text("Every day").tag("daily"); Text("Certain days").tag("weekly")
                        }
                        .pickerStyle(.segmented)
                        if freq == "weekly" {
                            HStack(spacing: 5) {
                                ForEach(Self.days, id: \.code) { d in
                                    let on = days.contains(d.code)
                                    Button { if on { days.remove(d.code) } else { days.insert(d.code) } } label: {
                                        Text(d.label).font(.system(size: 12, weight: .bold))
                                            .foregroundStyle(on ? .white : NK.ink2)
                                            .frame(maxWidth: .infinity).padding(.vertical, 9)
                                            .background(on ? NK.primary : NK.card)
                                            .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(on ? Color.clear : NK.hair, lineWidth: 1))
                                            .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Who")
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            personChip(nil, label: "🙌 Up for grabs")
                            ForEach(members) { m in personChip(m.id, label: "\(m.emoji ?? "🙂") \(goalFirstName(m.name))") }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        if currencies.count > 1 {
                            VStack(alignment: .leading, spacing: 9) {
                                SectionLabel(text: "Reward")
                                ChipFlow(spacing: 8, lineSpacing: 8) {
                                    ForEach(currencies) { c in
                                        let on = c.key == effectiveCurrencyKey
                                        let tint = Color(hexString: c.color) ?? NK.gold
                                        Button { currencyKey = c.key } label: {
                                            Text("\(c.symbol) \(c.label)")
                                                .font(.system(size: 14, weight: on ? .bold : .medium))
                                                .foregroundStyle(on ? NK.ink : NK.ink2)
                                                .padding(.horizontal, 13).padding(.vertical, 8)
                                                .background(on ? tint.opacity(0.16) : NK.panel)
                                                .clipShape(Capsule())
                                                .overlay(Capsule().strokeBorder(on ? tint.opacity(0.5) : .clear, lineWidth: 1))
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                        HStack {
                            SectionLabel(text: currencies.count > 1 ? "Amount" : "Stars")
                            Spacer()
                            HStack(spacing: 14) {
                                Button { if stars > 0 { stars -= 1 } } label: {
                                    Image(systemName: "minus.circle.fill").font(.system(size: 24)).foregroundStyle(stars > 0 ? NK.ink2 : NK.hair)
                                }.buttonStyle(.plain).disabled(stars == 0)
                                HStack(spacing: 3) {
                                    rewardSymbol
                                    Text("\(stars)").font(.system(size: 17, weight: .heavy)).foregroundStyle(NK.ink).frame(minWidth: 20)
                                }
                                Button { stars += 1 } label: {
                                    Image(systemName: "plus.circle.fill").font(.system(size: 24)).foregroundStyle(NK.primary)
                                }.buttonStyle(.plain)
                            }
                        }
                    }

                    Toggle(isOn: $requiresApproval) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Needs a parent’s OK").font(.system(size: 14.5, weight: .bold)).foregroundStyle(NK.ink)
                            Text("The reward is awarded only after a parent approves.")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                        }
                    }
                    .tint(FamilyColor.wally.solid)
                    .padding(13).cardField()

                    if editing {
                        Button {
                            if confirmDelete { onDelete(editChoreId!); dismiss() }
                            else { withAnimation { confirmDelete = true } }
                        } label: {
                            Text(confirmDelete ? "Tap again to delete this chore" : "Delete chore")
                                .font(.system(size: 14, weight: .bold)).foregroundStyle(NK.primary)
                        }
                        .buttonStyle(.plain).padding(.top, 2)
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle(editing ? "Edit chore" : "New chore")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing ? "Save" : "Add") { submit() }.fontWeight(.semibold).disabled(!canSave)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func labeled<V: View>(_ label: String, width: CGFloat? = nil, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 9) { SectionLabel(text: label); content() }
            .frame(maxWidth: width == nil ? .infinity : width, alignment: .leading)
    }

    private func personChip(_ id: String?, label: String) -> some View {
        let on = personId == id
        return Button { personId = id } label: {
            Text(label).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? NK.ink : NK.ink2)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .nkChip(selected: on)
        }
        .buttonStyle(.plain)
    }

    /// The household's reward currencies (e.g. Stars, plus any custom ones).
    private var currencies: [NookAPI.Currency] { sync.currencies }
    /// The selected key, falling back to the household default.
    private var effectiveCurrencyKey: String? {
        currencyKey ?? currencies.first(where: { $0.isDefault })?.key
    }
    private var selectedCurrency: NookAPI.Currency? {
        currencies.first { $0.key == effectiveCurrencyKey }
    }
    /// The amount stepper's icon — the chosen currency's symbol, else the gold star.
    @ViewBuilder private var rewardSymbol: some View {
        if let c = selectedCurrency {
            Text(c.symbol).font(.system(size: 14))
        } else {
            Image(systemName: "star.fill").font(.system(size: 13)).foregroundStyle(NK.gold)
        }
    }

    private func submit() {
        var body: [String: JSONValue] = [
            "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "emoji": emoji.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(emoji.trimmingCharacters(in: .whitespaces)),
            "personId": personId.map(JSONValue.string) ?? .null,
            "rewardAmount": .int(stars),
            "rrule": .string(buildRrule()),
            "requiresApproval": .bool(requiresApproval),
        ]
        // Pass the chosen currency when the household has more than one (else the
        // backend uses its default).
        if currencies.count > 1, let key = effectiveCurrencyKey {
            body["rewardCurrency"] = .string(key)
        }
        onSave(editChoreId, body)
        dismiss()
    }

    private func buildRrule() -> String {
        guard freq == "weekly", !days.isEmpty else { return "FREQ=DAILY" }
        let ordered = Self.days.map(\.code).filter { days.contains($0) }
        return "FREQ=WEEKLY;BYDAY=\(ordered.joined(separator: ","))"
    }

    private static func parseRrule(_ rrule: String?) -> (freq: String, days: [String]) {
        guard let r = rrule, r.uppercased().contains("FREQ=WEEKLY") else { return ("daily", []) }
        guard let range = r.range(of: "BYDAY=", options: .caseInsensitive) else { return ("weekly", []) }
        let rest = r[range.upperBound...].prefix { $0.isLetter || $0 == "," }
        return ("weekly", rest.uppercased().split(separator: ",").map(String.init))
    }
}

private extension View {
    /// The shared NK card-field chrome (white, hairline border, rounded).
    func cardField() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).nkField()
    }
}
