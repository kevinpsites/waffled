import SwiftUI

/// The iPad Lists page — a web-like master/detail: a sidebar of the household's lists
/// on the left, the selected list's full detail (`ListDetailView`, incl. the grocery
/// aisle/meal board) on the right. Reuses `ListsIndexModel` + `ListDetailView`; the
/// iPhone keeps the push-navigation `ListsIndexView`. See `apps/ios/IPAD_ROADMAP.md`.
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
        HStack(spacing: 0) {
            sidebar.frame(width: 320)
            Rectangle().fill(NK.hair).frame(width: 1).ignoresSafeArea()
            Group {
                if let sel = selected {
                    NavigationStack {
                        ListDetailView(list: sel, openRecipe: openRecipe)
                    }
                    .id(sel.id)   // fresh detail model when the selection changes
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

    // MARK: sidebar (the lists index)

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Lists").font(NK.serif(28)).foregroundStyle(NK.ink)
                Spacer()
                Button { creating = true } label: {
                    Image(systemName: "plus").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.primary)
                        .frame(width: 38, height: 38).background(NK.card).clipShape(Circle())
                        .overlay(Circle().strokeBorder(NK.hair, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 10)

            if model.loading && model.lists.isEmpty {
                NookLoading(top: 32)
            } else if model.lists.isEmpty {
                Text(model.error ? "Couldn’t load your lists." : "No lists yet — tap ＋ to add one.")
                    .font(.system(size: 13)).foregroundStyle(NK.ink3)
                    .padding(.horizontal, 18).padding(.top, 12)
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 6) {
                        ForEach(model.lists) { list in
                            Button { selectedId = list.id } label: { sidebarRow(list, isSelected: list.id == selected?.id) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12).padding(.bottom, 20)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(NK.panel.opacity(0.4))
    }

    private func sidebarRow(_ list: NookAPI.ListSummary, isSelected: Bool) -> some View {
        HStack(spacing: 12) {
            Text(list.emoji ?? "📝").font(.system(size: 20))
                .frame(width: 38, height: 38).background(NK.panel)
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            Text(list.name).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
            Spacer(minLength: 6)
            Text("\(list.itemCount)").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(isSelected ? NK.card : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(isSelected ? NK.hair : Color.clear, lineWidth: 1))
    }

    private var placeholder: some View {
        VStack(spacing: 10) {
            Text("🗒️").font(.system(size: 44))
            Text("Pick a list").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NK.canvas)
    }
}
