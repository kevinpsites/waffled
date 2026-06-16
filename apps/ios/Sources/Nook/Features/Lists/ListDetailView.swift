import SwiftUI
import Observation

/// One list's items — works for any list (Grocery included). Tapping the circle
/// toggles done; tapping the row edits it inline (name + a quantity field on the
/// right). Swipe to delete. Items group by section (aisle for grocery). A checked
/// item lingers in place for a moment, then drops into a collapsed "Completed"
/// section. Online-only (lists aren't a synced table).
@MainActor
@Observable
final class ListDetailModel {
    let list: NookAPI.ListSummary
    private(set) var items: [NookAPI.ListItemDTO] = []
    /// Checked items still shown in place (before they settle into Completed).
    private(set) var settling: Set<String> = []
    private(set) var loading = true
    private(set) var error = false

    private let api = NookAPI()
    private var isGrocery: Bool { list.listType.lowercased() == "grocery" }

    init(list: NookAPI.ListSummary) { self.list = list }

    /// Active items: unchecked, plus just-checked ones that haven't settled yet.
    var activeSections: [ListSectionGroup] {
        ListGrouping.sections(items.filter { !$0.checked || settling.contains($0.id) })
    }
    /// Settled, checked items — shown in the collapsed Completed section.
    var completed: [NookAPI.ListItemDTO] { items.filter { $0.checked && !settling.contains($0.id) } }

    func load() async {
        loading = true
        settling = []
        do {
            items = try await api.listItems(listId: list.id)
            error = false
        } catch {
            self.error = true
        }
        loading = false
    }

    func add(name rawName: String, quantity rawQty: String) async {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if isGrocery {
                try await api.addGroceryItem(name: name, quantity: qty.isEmpty ? nil : qty)
            } else {
                try await api.addListItem(listId: list.id, name: name, quantity: qty.isEmpty ? nil : qty)
            }
            await load()
        } catch {
            self.error = true
        }
    }

    /// Optimistic toggle. Checking keeps the row in place briefly (settling), then
    /// it animates down into Completed; unchecking returns it to its section now.
    func toggle(_ id: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let target = !items[idx].checked
        withAnimation { items[idx].checked = target }
        if target {
            settling.insert(id)
            scheduleSettle(id)
        } else {
            settling.remove(id)
        }
        do {
            try await api.patchListItem(id: id, checked: target)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) {
                withAnimation { items[i].checked = !target }
            }
            settling.remove(id)
        }
    }

    private func scheduleSettle(_ id: String) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            // Only settle if it's still checked (the user may have toggled it back).
            if self.items.first(where: { $0.id == id })?.checked == true {
                withAnimation { _ = self.settling.remove(id) }
            }
        }
    }

    /// Optimistic inline edit; revert on failure.
    func edit(_ id: String, name rawName: String, quantity rawQty: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        let prev = items[idx]
        guard name != prev.name || qty != (prev.quantity ?? "") else { return }
        items[idx].name = name
        items[idx].quantity = qty.isEmpty ? nil : qty
        do {
            try await api.patchListItem(id: id, name: name, quantity: qty)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) { items[i] = prev }
        }
    }

    /// Optimistic full-detail edit (name / quantity / assignee / section); revert on
    /// failure. `member` is the chosen assignee (nil = unassigned).
    func editDetails(_ id: String, name rawName: String, quantity rawQty: String,
                     member: SyncedMember?, section rawSection: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        let section = rawSection.trimmingCharacters(in: .whitespacesAndNewlines)
        let prev = items[idx]
        items[idx].name = name
        items[idx].quantity = qty.isEmpty ? nil : qty
        items[idx].section = section.isEmpty ? nil : section
        items[idx].assignee = member.map { .init(name: $0.name, avatarEmoji: $0.emoji, colorHex: $0.colorHex) }
        do {
            try await api.updateItemDetails(id: id, name: name, quantity: qty, assignedTo: member?.id, section: section)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) { items[i] = prev }
        }
    }

    /// Optimistic removal; restore on failure.
    func remove(_ id: String) async {
        let snapshot = items
        withAnimation { items.removeAll { $0.id == id } }
        do {
            try await api.deleteListItem(id: id)
        } catch {
            items = snapshot
        }
    }
}

struct ListDetailView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model: ListDetailModel
    @State private var draftName = ""
    @State private var draftQty = ""
    @State private var editingId: String?
    @State private var editName = ""
    @State private var editQty = ""
    @State private var showCompleted = false
    @State private var detailItem: NookAPI.ListItemDTO?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case add, editName, editQty }

    init(list: NookAPI.ListSummary) {
        _model = State(initialValue: ListDetailModel(list: list))
    }

    var body: some View {
        List {
            if model.items.isEmpty && !model.loading {
                Text(model.error ? "Couldn’t load this list." : "Nothing here yet.")
                    .font(.system(size: 14)).foregroundStyle(NK.ink3)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            ForEach(model.activeSections) { group in
                Section {
                    ForEach(group.items) { item in itemRow(item) }
                } header: { sectionHeader(group.title) }
            }
            completedSection
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(NK.canvas)
        .safeAreaInset(edge: .bottom, spacing: 0) { addBar }
        .navigationTitle(model.list.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: focus) { _, new in
            // Tapping away from an inline edit commits it.
            if editingId != nil, new != .editName, new != .editQty { commitEdit() }
        }
        .sheet(item: $detailItem) { item in
            ItemDetailEditor(item: item, members: sync.members) { name, qty, member, section in
                Task { await model.editDetails(item.id, name: name, quantity: qty, member: member, section: section) }
            }
        }
    }

    /// A row plus its swipe actions (Delete + Details), shared by the active and
    /// completed sections.
    @ViewBuilder private func itemRow(_ item: NookAPI.ListItemDTO) -> some View {
        row(item)
            .listRowBackground(Color.clear)
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    Task { await model.remove(item.id) }
                } label: { Label("Delete", systemImage: "trash") }
                Button {
                    if editingId != nil { commitEdit() }
                    detailItem = item
                } label: { Label("Details", systemImage: "slider.horizontal.3") }
                    .tint(NK.ai)
            }
    }

    @ViewBuilder private func sectionHeader(_ title: String?) -> some View {
        if let title {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                .foregroundStyle(NK.ink3)
        }
    }

    @ViewBuilder private var completedSection: some View {
        if !model.completed.isEmpty {
            Section {
                if showCompleted {
                    ForEach(model.completed) { item in itemRow(item) }
                }
            } header: {
                Button {
                    withAnimation { showCompleted.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: showCompleted ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .heavy))
                        Text("COMPLETED (\(model.completed.count))")
                            .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                        Spacer()
                    }
                    .foregroundStyle(NK.ink3)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private func row(_ item: NookAPI.ListItemDTO) -> some View {
        HStack(spacing: 12) {
            // Circle: tap to complete (separate hit target).
            Button {
                if editingId != nil { commitEdit() }
                Task { await model.toggle(item.id) }
            } label: {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 21))
                    .foregroundStyle(item.checked ? NK.primary : NK.ink3)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if editingId == item.id {
                TextField("Name", text: $editName)
                    .font(.system(size: 16, weight: .semibold))
                    .focused($focus, equals: .editName)
                    .submitLabel(.next)
                    .onSubmit { focus = .editQty }
                TextField("Qty", text: $editQty)
                    .font(.system(size: 14, weight: .semibold))
                    .multilineTextAlignment(.trailing)
                    .frame(width: 70)
                    .focused($focus, equals: .editQty)
                    .submitLabel(.done)
                    .onSubmit { commitEdit() }
            } else {
                Button { startEdit(item) } label: {
                    HStack(spacing: 8) {
                        Text(item.name)
                            .font(.system(size: 16, weight: .semibold))
                            .strikethrough(item.checked, color: NK.ink3)
                            .foregroundStyle(item.checked ? NK.ink3 : NK.ink)
                        Spacer(minLength: 8)
                        if let q = item.quantity, !q.isEmpty {
                            Text(q).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                        }
                        if let a = item.assignee, a.avatarEmoji != nil || a.colorHex != nil {
                            Avatar(colorHex: a.colorHex, emoji: a.avatarEmoji ?? "🙂", size: 24)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }

    private var addBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(NK.primary)
            TextField("Add item", text: $draftName)
                .font(.system(size: 16, weight: .semibold))
                .focused($focus, equals: .add)
                .submitLabel(.next)
                .onSubmit(submit)
            TextField("Qty", text: $draftQty)
                .font(.system(size: 15, weight: .semibold))
                .multilineTextAlignment(.trailing)
                .frame(width: 64)
                .focused($focus, equals: .add)
                .submitLabel(.done)
                .onSubmit(submit)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 96)            // clear the floating tab bar
        .background(NK.canvas)           // opaque strip so rows don't show through
    }

    private func startEdit(_ item: NookAPI.ListItemDTO) {
        if editingId != nil, editingId != item.id { commitEdit() }
        editName = item.name
        editQty = item.quantity ?? ""
        editingId = item.id
        focus = .editName
    }

    private func commitEdit() {
        guard let id = editingId else { return }
        let n = editName, q = editQty
        editingId = nil
        Task { await model.edit(id, name: n, quantity: q) }
    }

    private func submit() {
        let name = draftName, qty = draftQty
        draftName = ""; draftQty = ""
        Task { await model.add(name: name, quantity: qty) }
    }
}

/// The fuller "Details" editor reached by swiping a row — name, quantity, assignee,
/// and section. The 90% case stays on the inline row editor; this is for the rest.
struct ItemDetailEditor: View {
    @Environment(\.dismiss) private var dismiss
    let members: [SyncedMember]
    let onSave: (String, String, SyncedMember?, String) -> Void

    @State private var name: String
    @State private var quantity: String
    @State private var assigneeId: String?
    @State private var section: String

    init(item: NookAPI.ListItemDTO, members: [SyncedMember],
         onSave: @escaping (String, String, SyncedMember?, String) -> Void) {
        self.members = members
        self.onSave = onSave
        _name = State(initialValue: item.name)
        _quantity = State(initialValue: item.quantity ?? "")
        _section = State(initialValue: item.section ?? "")
        // The item's assignee carries no id, so resolve it to a member by name.
        let assigneeName = item.assignee?.name
        _assigneeId = State(initialValue: members.first { $0.name == assigneeName }?.id)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("Name", text: $name) }
                Section("Quantity") { TextField("e.g. 2 lb", text: $quantity) }
                Section("Assigned to") {
                    Picker("Assignee", selection: $assigneeId) {
                        Text("Unassigned").tag(String?.none)
                        ForEach(members) { m in Text(m.name).tag(Optional(m.id)) }
                    }
                }
                Section("Section") { TextField("e.g. Produce", text: $section) }
            }
            .navigationTitle("Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(name, quantity, members.first { $0.id == assigneeId }, section)
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
