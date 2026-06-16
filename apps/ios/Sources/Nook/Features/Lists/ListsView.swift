import SwiftUI
import Observation

/// One grocery row from `/api/lists/grocery`.
struct GroceryListItem: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let quantity: String?
    var checked: Bool
}

/// REST-backed, interactive grocery list (the first built-out hub destination).
/// Mirrors the web `useGrocery`: optimistic check-off and removal, add via the
/// shared capture endpoint. Not a synced table, so it's online-only for now.
@MainActor
@Observable
final class ListsModel {
    private(set) var items: [GroceryListItem] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = NookAPI()

    func load() async {
        loading = true
        do {
            items = try await api.groceryList()
            error = false
        } catch {
            self.error = true
        }
        loading = false
    }

    func add(_ raw: String) async {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        do {
            try await api.addGroceryItem(name: name)
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
            try await api.setListItemChecked(id: id, checked: target)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) { items[i].checked = !target }
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

struct ListsView: View {
    @State private var model = ListsModel()
    @State private var draft = ""
    @FocusState private var adding: Bool

    private var remaining: Int { model.items.filter { !$0.checked }.count }

    var body: some View {
        List {
            if model.items.isEmpty && !model.loading {
                Text(model.error ? "Couldn’t load the list." : "Nothing on the list yet.")
                    .font(.system(size: 14)).foregroundStyle(NK.ink3)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            ForEach(model.items) { item in
                row(item)
                    .listRowBackground(Color.clear)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await model.remove(item.id) }
                        } label: { Label("Delete", systemImage: "trash") }
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(NK.canvas)
        .safeAreaInset(edge: .bottom) { addBar }
        .navigationTitle("Grocery")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Text("\(remaining) to buy").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    private func row(_ item: GroceryListItem) -> some View {
        Button {
            Task { await model.toggle(item.id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 21))
                    .foregroundStyle(item.checked ? NK.primary : NK.ink3)
                Text(item.name)
                    .font(.system(size: 16, weight: .semibold))
                    .strikethrough(item.checked, color: NK.ink3)
                    .foregroundStyle(item.checked ? NK.ink3 : NK.ink)
                Spacer(minLength: 8)
                if let q = item.quantity, !q.isEmpty {
                    Text(q).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                }
            }
            .contentShape(Rectangle())
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
    }

    private var addBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(NK.primary)
            TextField("Add item", text: $draft)
                .font(.system(size: 16, weight: .semibold))
                .focused($adding)
                .submitLabel(.done)
                .onSubmit {
                    let t = draft; draft = ""
                    Task { await model.add(t) }
                }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        .padding(.horizontal, 16)
        .padding(.bottom, 96)   // clear the floating tab bar
    }
}

#Preview {
    NavigationStack { ListsView() }
}
