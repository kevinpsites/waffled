import SwiftUI
import Observation

/// The Lists index — every list in the household (Grocery, packing lists, …). The
/// first built-out hub destination; tapping a list opens its detail.
@MainActor
@Observable
final class ListsIndexModel {
    private(set) var lists: [WaffledAPI.ListSummary] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = WaffledAPI()

    func load() async {
        loading = true
        do {
            lists = try await api.listSummaries()
            error = false
        } catch {
            self.error = true
        }
        loading = false
    }

    /// Create a list and return it (so the caller can open it), reloading the index.
    func create(name: String, emoji: String) async -> WaffledAPI.ListSummary? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return nil }
        do {
            let new = try await api.addList(name: n, emoji: emoji.isEmpty ? nil : emoji)
            await load()
            return new
        } catch { self.error = true; return nil }
    }

    /// Optimistic delete; restore on failure.
    func delete(_ list: WaffledAPI.ListSummary) async {
        let snapshot = lists
        withAnimation { lists.removeAll { $0.id == list.id } }
        do { try await api.deleteList(id: list.id) }
        catch { lists = snapshot; self.error = true }
    }

    /// The household's saved templates (for the "Apply template" picker).
    func templates() async -> [WaffledAPI.ListSummary] {
        (try? await api.listTemplates()) ?? []
    }

    /// Apply a template → a fresh custom list (everything unchecked), reloading the
    /// index so the new list shows in the rail. Returns it so the caller can open it.
    func apply(template: WaffledAPI.ListSummary) async -> WaffledAPI.ListSummary? {
        do {
            let new = try await api.applyListTemplate(templateId: template.id)
            await load()
            return new
        } catch { self.error = true; return nil }
    }
}

struct ListsIndexView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model = ListsIndexModel()
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    @State private var creatingList = false
    @State private var applyingTemplate = false

    /// Fire the headless deep-link at most once per process — the index view is
    /// recreated when you pop back to it, so a per-view flag would re-fire and trap
    /// you on the detail screen.
    private static var didDeepLink = false

    var body: some View {
        List {
            AICaptureBar(placeholder: "Add milk & eggs to groceries…",
                         onTap: { dictateOnOpen = false; showCapture = true },
                         onMic: { dictateOnOpen = true; showCapture = true })
                .listRowInsets(EdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18))
                .listRowBackground(Color.clear).listRowSeparator(.hidden)

            if !model.lists.isEmpty {
                SectionLabel(text: "Your lists")
                    .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 2, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if model.loading && model.lists.isEmpty {
                WaffledLoading(top: 40)
                    .listRowInsets(EdgeInsets(top: 24, leading: 20, bottom: 8, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if model.lists.isEmpty {
                WaffledEmptyState(
                    emoji: model.error ? "😕" : "🗒️",
                    title: model.error ? "Couldn’t load your lists" : "No lists yet",
                    message: model.error ? "Pull to refresh to try again." : "Add one with the ＋ button.")
                    .listRowInsets(EdgeInsets(top: 24, leading: 20, bottom: 8, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(model.lists) { list in
                Button { path.append(.list(list)) } label: { row(list) }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 5, leading: 18, bottom: 5, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .swipeActions(edge: .trailing) {
                        if list.listType.lowercased() != "grocery" {
                            Button(role: .destructive) { Task { await model.delete(list) } } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(WF.canvas)
        .navigationTitle("Lists")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { creatingList = true } label: { Label("New list", systemImage: "plus") }
                    Button { applyingTemplate = true } label: { Label("Apply template", systemImage: "doc.on.doc") }
                } label: {
                    Image(systemName: "plus")
                } primaryAction: {
                    creatingList = true
                }
            }
        }
        .task {
            await model.load()
            deepLinkIfNeeded()
        }
        .refreshable { await model.load() }
        .onChange(of: sync.listsRev) { _, _ in Task { await model.load() } }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $creatingList) {
            NewListSheet { name, emoji in
                Task { if let new = await model.create(name: name, emoji: emoji) { path.append(.list(new)) } }
            }
        }
        .sheet(isPresented: $applyingTemplate) {
            ApplyTemplateSheet(
                load: { await model.templates() },
                onApply: { tpl in
                    Task { if let new = await model.apply(template: tpl) { path.append(.list(new)) } }
                })
        }
    }

    private func row(_ list: WaffledAPI.ListSummary) -> some View {
        WaffledCard(padding: 15) {
            HStack(spacing: 13) {
                WaffledEmojiTile(emoji: list.emoji ?? "📝")
                Text(list.name).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                Text("\(list.itemCount)").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3.opacity(0.55))
            }
        }
    }

    /// Headless verification: WAFFLED_OPEN_LIST=grocery (or a list name) pushes that
    /// list's detail once per process, after the index has loaded.
    private func deepLinkIfNeeded() {
        guard !Self.didDeepLink, let want = DemoHooks.openList?.lowercased() else { return }
        if let match = model.lists.first(where: {
            $0.listType.lowercased() == want || $0.name.lowercased() == want
        }) {
            Self.didDeepLink = true
            path.append(.list(match))
        }
    }
}

/// New custom list — name + optional emoji. WF-styled.
struct NewListSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreate: (String, String) -> Void
    @State private var name = ""
    @State private var emoji = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "List name")
                        TextField("Camping gear", text: $name)
                            .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.words)
                            .focused($nameFocused)
                            .padding(.horizontal, 13).padding(.vertical, 12)
                            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Emoji")
                        TextField("📝", text: $emoji)
                            .font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
                            .frame(width: 60).padding(.vertical, 12)
                            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                            .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("New list")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { onCreate(name, emoji.trimmingCharacters(in: .whitespaces)); dismiss() }
                        .fontWeight(.semibold).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.height(200), .medium])
        // Land in the name field so you can just start typing.
        .task { try? await Task.sleep(for: .milliseconds(300)); nameFocused = true }
    }
}

/// Pick a saved template to spin up a fresh copy of (everything unchecked). Mirrors
/// the web's Apply-template picker. Loads templates on appear; tapping one applies it
/// and dismisses.
struct ApplyTemplateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let load: () async -> [WaffledAPI.ListSummary]
    let onApply: (WaffledAPI.ListSummary) -> Void

    @State private var templates: [WaffledAPI.ListSummary] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    WaffledLoading(top: 40)
                        .listRowInsets(EdgeInsets(top: 24, leading: 20, bottom: 8, trailing: 18))
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else if templates.isEmpty {
                    WaffledEmptyState(
                        emoji: "📑",
                        title: "No templates yet",
                        message: "Open a list and choose “Save as template” to reuse it later.")
                        .listRowInsets(EdgeInsets(top: 24, leading: 20, bottom: 8, trailing: 18))
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else {
                    SectionLabel(text: "Your templates")
                        .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 2, trailing: 18))
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    ForEach(templates) { tpl in
                        Button { onApply(tpl); dismiss() } label: { row(tpl) }
                            .buttonStyle(.plain)
                            .listRowInsets(EdgeInsets(top: 5, leading: 18, bottom: 5, trailing: 18))
                            .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(WF.canvas)
            .navigationTitle("Apply template")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            templates = await load()
            loading = false
        }
    }

    private func row(_ tpl: WaffledAPI.ListSummary) -> some View {
        WaffledCard(padding: 15) {
            HStack(spacing: 13) {
                WaffledEmojiTile(emoji: tpl.emoji ?? "📑")
                Text(tpl.name).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                Text("\(tpl.itemCount)").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.primary)
            }
        }
    }
}
