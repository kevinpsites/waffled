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
    var openRecipe: (WaffledAPI.RecipeSummary) -> Void = { _ in }

    /// The selected list, defaulting to the first (so the detail isn't empty on load).
    private var selected: WaffledAPI.ListSummary? {
        model.lists.first { $0.id == selectedId } ?? model.lists.first
    }

    var body: some View {
        VStack(spacing: 0) {
            KioskPageHeader("Lists", "Groceries, packing, to-dos — whatever the family needs.") {
                KioskHeaderButton(icon: "plus", label: "New list") { creating = true }
            }
            .padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 4)
            selectorBar
            Rectangle().fill(WF.hair).frame(height: 1)
            Group {
                if let sel = selected {
                    ListDetailView(list: sel, openRecipe: openRecipe).id(sel.id)
                } else {
                    placeholder
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(WF.canvas)
        .task { await model.load() }
        .onChange(of: sync.listsRev) { _, _ in Task { await model.load() } }
        .sheet(isPresented: $creating) {
            NewListSheet(
                loadTemplates: { await model.templates() },
                onCreate: { name, emoji in
                    Task { if let new = await model.create(name: name, emoji: emoji) { selectedId = new.id } }
                },
                onApply: { tpl, name in
                    Task { if let new = await model.apply(template: tpl, name: name) { selectedId = new.id } }
                })
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
                    .foregroundStyle(WF.ink2)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(WF.card).clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 24).padding(.vertical, 12)
        }
        .background(WF.canvas)
    }

    private func listPill(_ list: WaffledAPI.ListSummary, isSelected: Bool) -> some View {
        HStack(spacing: 8) {
            Text(list.emoji ?? "📝").font(.system(size: 16))
            Text(list.name).font(.system(size: 15, weight: .bold))
                .foregroundStyle(isSelected ? .white : WF.ink2).lineLimit(1)
            Text("\(list.itemCount)").font(.system(size: 12, weight: .heavy))
                .foregroundStyle(isSelected ? .white.opacity(0.85) : WF.ink3)
        }
        .padding(.leading, 13).padding(.trailing, 14).padding(.vertical, 8)
        .background(isSelected ? WF.primary : WF.card)
        .overlay(Capsule().strokeBorder(isSelected ? Color.clear : WF.hair, lineWidth: 1))
        .clipShape(Capsule())
    }

    private var placeholder: some View {
        VStack(spacing: 10) {
            if model.loading {
                WaffledLoading(top: 0)
            } else {
                Text("🗒️").font(.system(size: 44))
                Text(model.error ? "Couldn’t load your lists." : "No lists yet — tap “New list”.")
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WF.canvas)
    }
}
