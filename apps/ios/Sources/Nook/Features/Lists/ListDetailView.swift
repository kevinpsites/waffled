import SwiftUI
import Observation

/// One list's items — works for any list (Grocery included). Tapping the circle
/// toggles done; tapping the row opens an editor (name + quantity). Swipe to
/// delete. Items are grouped by section (aisle for grocery). Online-only (lists
/// aren't a synced table).
@MainActor
@Observable
final class ListDetailModel {
    let list: NookAPI.ListSummary
    private(set) var items: [NookAPI.ListItemDTO] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = NookAPI()
    private var isGrocery: Bool { list.listType.lowercased() == "grocery" }

    init(list: NookAPI.ListSummary) { self.list = list }

    var remaining: Int { items.filter { !$0.checked }.count }
    var sections: [ListSectionGroup] { ListGrouping.sections(items) }

    func load() async {
        loading = true
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
            await load()   // server assigns id / section / aisle
        } catch {
            self.error = true
        }
    }

    /// Optimistic toggle; revert on failure.
    func toggle(_ id: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let target = !items[idx].checked
        items[idx].checked = target
        do {
            try await api.patchListItem(id: id, checked: target)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) { items[i].checked = !target }
        }
    }

    /// Optimistic edit; revert on failure.
    func edit(_ id: String, name rawName: String, quantity rawQty: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        let prev = items[idx]
        items[idx].name = name
        items[idx].quantity = qty.isEmpty ? nil : qty
        do {
            try await api.patchListItem(id: id, name: name, quantity: qty)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) { items[i] = prev }
        }
    }

    /// Optimistic removal; restore on failure.
    func remove(_ id: String) async {
        let snapshot = items
        items.removeAll { $0.id == id }
        do {
            try await api.deleteListItem(id: id)
        } catch {
            items = snapshot
        }
    }
}

struct ListDetailView: View {
    @State private var model: ListDetailModel
    @State private var draftName = ""
    @State private var draftQty = ""
    @State private var editing: NookAPI.ListItemDTO?
    @FocusState private var addingName: Bool

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
            ForEach(model.sections) { group in
                Section {
                    ForEach(group.items) { item in
                        row(item)
                            .listRowBackground(Color.clear)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await model.remove(item.id) }
                                } label: { Label("Delete", systemImage: "trash") }
                            }
                    }
                } header: {
                    if let title = group.title {
                        Text(title.uppercased())
                            .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                            .foregroundStyle(NK.ink3)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(NK.canvas)
        .safeAreaInset(edge: .bottom, spacing: 0) { addBar }
        .navigationTitle(model.list.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .sheet(item: $editing) { item in
            EditItemSheet(name: item.name, quantity: item.quantity ?? "") { name, qty in
                Task { await model.edit(item.id, name: name, quantity: qty) }
            }
        }
    }

    private func row(_ item: NookAPI.ListItemDTO) -> some View {
        HStack(spacing: 12) {
            // Circle: tap to complete (separate hit target from the row).
            Button {
                Task { await model.toggle(item.id) }
            } label: {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 21))
                    .foregroundStyle(item.checked ? NK.primary : NK.ink3)
                    .contentShape(Rectangle())
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)

            // Row body: tap to edit.
            Button {
                editing = item
            } label: {
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
        .padding(.vertical, 2)
    }

    private var addBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(NK.primary)
            TextField("Add item", text: $draftName)
                .font(.system(size: 16, weight: .semibold))
                .focused($addingName)
                .submitLabel(.next)
                .onSubmit(submit)
            TextField("Qty", text: $draftQty)
                .font(.system(size: 15, weight: .semibold))
                .multilineTextAlignment(.trailing)
                .frame(width: 64)
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

    private func submit() {
        let name = draftName, qty = draftQty
        draftName = ""; draftQty = ""
        Task { await model.add(name: name, quantity: qty) }
    }
}

/// A small editor for a list item's name + quantity.
struct EditItemSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var name: String
    @State var quantity: String
    let onSave: (String, String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("Name", text: $name) }
                Section("Quantity") { TextField("e.g. 2 lb", text: $quantity) }
            }
            .navigationTitle("Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(name, quantity); dismiss() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.height(280)])
    }
}
