import SwiftUI

/// The iPad Lists page. Lists are a compact selector across the top (they matter less
/// than the content); the selected list fills the page below. For Grocery, the detail
/// itself shows the items as the main column with a side panel of this-week's-meals +
/// pantry staples (the web grocery layout — see `ListDetailView.kioskBody`). Reuses
/// `ListsIndexModel` + `ListDetailView`. iPhone keeps the push-nav `ListsIndexView`.
struct KioskListsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = ListsIndexModel()
    @State private var selectedId: String?
    @State private var creating = false
    /// Opening a recipe from a list's meal recap (forwarded to the Meals tab).
    var openRecipe: (NookAPI.RecipeSummary) -> Void = { _ in }

    /// The selected list, defaulting to the first (so the detail isn't empty on load).
    private var selected: NookAPI.ListSummary? {
        model.lists.first { $0.id == selectedId } ?? model.lists.first
    }

    var body: some View {
        VStack(spacing: 0) {
            selectorBar
            Rectangle().fill(NK.hair).frame(height: 1)
            Group {
                if let sel = selected {
                    ListDetailView(list: sel, openRecipe: openRecipe).id(sel.id)
                } else {
                    placeholder
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(NK.canvas)
        .task { await model.load() }
        .onChange(of: sync.listsRev) { _, _ in Task { await model.load() } }
        .sheet(isPresented: $creating) {
            NewListSheet { name, emoji in
                Task { if let new = await model.create(name: name, emoji: emoji) { selectedId = new.id } }
            }
        }
    }

    // MARK: list selector (across the top)

    private var selectorBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.lists) { list in
                    Button { selectedId = list.id } label: { listPill(list, isSelected: list.id == selected?.id) }
                        .buttonStyle(.plain)
                }
                Button { creating = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus").font(.system(size: 12, weight: .bold))
                        Text("New list").font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(NK.ink2)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(NK.card).clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 24).padding(.vertical, 12)
        }
        .background(NK.canvas)
    }

    private func listPill(_ list: NookAPI.ListSummary, isSelected: Bool) -> some View {
        HStack(spacing: 8) {
            Text(list.emoji ?? "📝").font(.system(size: 16))
            Text(list.name).font(.system(size: 15, weight: .bold))
                .foregroundStyle(isSelected ? .white : NK.ink2).lineLimit(1)
            Text("\(list.itemCount)").font(.system(size: 12, weight: .heavy))
                .foregroundStyle(isSelected ? .white.opacity(0.85) : NK.ink3)
        }
        .padding(.leading, 13).padding(.trailing, 14).padding(.vertical, 8)
        .background(isSelected ? NK.ink : NK.card)
        .overlay(Capsule().strokeBorder(isSelected ? Color.clear : NK.hair, lineWidth: 1))
        .clipShape(Capsule())
    }

    private var placeholder: some View {
        VStack(spacing: 10) {
            if model.loading {
                NookLoading(top: 0)
            } else {
                Text("🗒️").font(.system(size: 44))
                Text(model.error ? "Couldn’t load your lists." : "No lists yet — tap “New list”.")
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NK.canvas)
    }
}
